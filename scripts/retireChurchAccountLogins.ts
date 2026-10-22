/**
 * Retires the SuperTokens logins of church account rows made before a church's data got an address
 * nobody can sign in with.
 *
 * Two old ways of adding a church left a login on the church's account row, at the address
 * `<church-slug>-<adding bookkeeper's email>`, with a bookkeeper row carrying that same address:
 *   - the Clients page signed up from the browser with a shared hard-coded password;
 *   - POST /user/createClientChurch signed up server-side with a random password.
 * churchAccess.ts lets a login always reach its own row, so whoever signs in as one of these is
 * that church's owner.
 *
 * For each such row:
 *   1. One transaction moves it to church-<hex>@accounts.churchsyncpro.invalid together with every
 *      row filed under its old address (token_entity, its own bookkeeper row, billing,
 *      userEmailPreferences). Token rows are found by that address, so they must move with it.
 *   2. Then its SuperTokens login is deleted, sessions with it.
 * In that order: a login left behind maps to no Users row and opens nothing, whereas deleting the
 * login first frees the address while the row still carries it, and sign-up adopts an existing
 * Users row by email. Moving the row also cuts off an access token already issued to the login,
 * which stays valid for up to an hour after the login is deleted.
 *
 * Order on an environment that has neither yet (production): the churches migrations, then this,
 * then scripts/verifyExistingUsers.ts. Until a login's address is verified, REQUIRED email
 * verification refuses its session - but verifyExistingUsers.ts verifies every Users address,
 * these included.
 *
 * Dry run (read-only) unless --apply. Prints row ids and church names, never an address.
 *
 *   NODE_ENV=staging DOTENV_CONFIG_PATH=.env.staging npx ts-node -r dotenv/config scripts/retireChurchAccountLogins.ts [--apply]
 *
 * A login whose delete failed after its row moved is printed; delete it with
 *   RETIRE_LOGIN_IDS=<id,id> ... scripts/retireChurchAccountLogins.ts --apply
 * (it is deleted only if its address belongs to no Users row).
 */
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
const supertokens = require('supertokens-node');
import crypto from 'crypto';
import { QueryTypes, Transaction, col, fn, where as sqlWhere } from 'sequelize';
import ThirdPartyEmailPassword from 'supertokens-node/recipe/thirdpartyemailpassword';
import Session from 'supertokens-node/recipe/session';
import sequelize from '../src/db';
import { buildSupertokensConfig } from '../src/supertokensConfig';
import { ACCOUNT_EMAIL_DOMAIN } from '../src/services/churchAccountEmail';
import Users from '../src/db/models/user';
import bookkeeper from '../src/db/models/bookkeeper';
import tokenEntity from '../src/db/models/tokenEntity';
import Billing from '../src/db/models/billing';
import userEmailPreferences from '../src/db/models/userEmailPreferences';
import Church from '../src/db/models/church';
import ChurchMember from '../src/db/models/churchMember';

const APPLY = process.argv.includes('--apply');

interface Candidate {
  id: number;
  email: string;
  churchName: string;
  bookkeeperRowId: number;
  addedBy: number;
  slug: string;
}

/**
 * Client rows at `<slug>-<email of the user who added them>` with a bookkeeper row (added by that
 * user) carrying the row's own address: the shape both old flows left. `right(...)` rather than
 * LIKE, which would read `_` and `%` in an address as wildcards.
 */
const CANDIDATES_SQL = `
  SELECT u.id, u.email, u."churchName", b.id AS "bookkeeperRowId", bk.id AS "addedBy",
         left(u.email, length(u.email) - length(bk.email) - 1) AS slug
    FROM "Users" u
    JOIN bookkeeper b ON b."clientId" = u.id AND lower(b.email) = lower(u.email)
    JOIN "Users" bk ON bk.id = b."userId" AND bk.id <> u.id
   WHERE u.role = 'client'
     AND right(lower(u.email), length(bk.email) + 1) = '-' || lower(bk.email)
   ORDER BY u.id`;

/** The task's looser rule, to show anything it catches that the strict shape above leaves alone. */
const LOOSE_SQL = `
  SELECT u.id FROM "Users" u
   WHERE u.role = 'client' AND u.email LIKE '%-%@%'
     AND EXISTS (SELECT 1 FROM bookkeeper b WHERE b."clientId" = u.id AND lower(b.email) = lower(u.email))
   ORDER BY u.id`;

const emailLogins = async (email: string) => {
  const spellings = Array.from(new Set([email, email.toLowerCase()]));
  const found = new Map<string, any>();
  for (const e of spellings) {
    for (const u of await ThirdPartyEmailPassword.getUsersByEmail(e)) {
      if (!(u as any).thirdParty) found.set(u.id, u);
    }
  }
  return Array.from(found.values());
};

const count = (model: any, where: any, transaction?: Transaction) => model.count({ where, transaction });

const describe = async (c: Candidate, transaction?: Transaction) => {
  const logins = await emailLogins(c.email);
  const sessions = (
    await Promise.all(logins.map((l) => Session.getAllSessionHandlesForUser(l.id)))
  ).reduce((n, handles) => n + handles.length, 0);
  const church = await Church.findOne({ where: { ownerUserId: c.id }, transaction });
  const owners = church
    ? (await ChurchMember.findAll({ where: { churchId: church.id, role: 'owner', inviteAccepted: true }, transaction })).map(
        (m) => m.userId,
      )
    : [];
  const anyCase = sqlWhere(fn('lower', col('email')), c.email.toLowerCase());
  return {
    logins,
    sessions,
    church: church ? { id: church.id, name: church.name, isActive: church.isActive, owners } : null,
    otherUsersSameAddress: (await Users.count({ where: anyCase as any, transaction })) - 1,
    tokenEntity: await count(tokenEntity, { email: c.email }, transaction),
    tokenEntityOtherCase:
      (await count(tokenEntity, anyCase, transaction)) - (await count(tokenEntity, { email: c.email }, transaction)),
    bookkeeperRows: await count(bookkeeper, { email: c.email }, transaction),
    billing: await count(Billing, { email: c.email }, transaction),
    emailPreferences: await count(userEmailPreferences, { email: c.email }, transaction),
    pendingInvitesToAddress: await count(ChurchMember, { invitedEmail: c.email }, transaction),
  };
};

const label = (c: Candidate) => `Users #${c.id} "${c.churchName}" ("${c.slug}" + "-" + <email of Users #${c.addedBy}>)`;

/** Move the row and everything filed under its address; the login is left for the caller. */
const moveRow = async (c: Candidate) => {
  const next = `church-${crypto.randomBytes(8).toString('hex')}@${ACCOUNT_EMAIL_DOMAIN}`;
  return sequelize.transaction(async (transaction) => {
    const row = await Users.findOne({ where: { id: c.id }, transaction, lock: Transaction.LOCK.UPDATE });
    if (!row || row.email !== c.email) throw new Error(`${label(c)} changed since it was read; run again`);
    const [users] = await Users.update({ email: next } as any, { where: { id: c.id }, transaction });
    const [tokens] = await tokenEntity.update({ email: next }, { where: { email: c.email }, transaction });
    const [bk] = await bookkeeper.update({ email: next } as any, { where: { email: c.email, clientId: c.id }, transaction });
    const [billing] = await Billing.update({ email: next } as any, { where: { email: c.email }, transaction });
    const [prefs] = await userEmailPreferences.update({ email: next } as any, { where: { email: c.email }, transaction });
    if (users !== 1) throw new Error(`${label(c)}: expected to move 1 Users row, moved ${users}`);
    return { tokenEntity: tokens, bookkeeper: bk, billing, emailPreferences: prefs };
  });
};

/** Delete logins named by id, but only ones whose address no Users row carries any more. */
const deleteLeftovers = async (ids: string[]) => {
  let failed = 0;
  for (const id of ids) {
    const login: any = await ThirdPartyEmailPassword.getUserById(id);
    if (!login) {
      console.log(`login ${id}: not found (already gone)`);
      continue;
    }
    const rows = await Users.count({ where: sqlWhere(fn('lower', col('email')), String(login.email).toLowerCase()) as any });
    if (rows > 0) {
      console.log(`login ${id}: its address still belongs to a Users row - left alone`);
      failed++;
      continue;
    }
    await supertokens.deleteUser(id);
    console.log(`login ${id}: deleted`);
  }
  return failed;
};

const main = async () => {
  supertokens.init(buildSupertokensConfig());
  const cfg = (sequelize as any).config;
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} - NODE_ENV=${process.env.NODE_ENV} database=${cfg.database}`);

  const leftoverIds = (process.env.RETIRE_LOGIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (leftoverIds.length) {
    if (!APPLY) throw new Error('RETIRE_LOGIN_IDS needs --apply');
    process.exitCode = (await deleteLeftovers(leftoverIds)) ? 1 : 0;
    return;
  }

  // Read everything in one read-only snapshot; a dry run never writes.
  const { candidates, loose, details } = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET TRANSACTION READ ONLY', { transaction });
    const candidates = (await sequelize.query(CANDIDATES_SQL, { type: QueryTypes.SELECT, transaction })) as Candidate[];
    const loose = (await sequelize.query(LOOSE_SQL, { type: QueryTypes.SELECT, transaction })) as { id: number }[];
    const details = new Map<number, Awaited<ReturnType<typeof describe>>>();
    for (const c of candidates) details.set(c.id, await describe(c, transaction));
    return { candidates, loose, details };
  });

  console.log(`${candidates.length} church account row(s) with a login-shaped address`);
  const outside = loose.filter((l) => !candidates.some((c) => c.id === l.id));
  if (outside.length) {
    console.log(`left alone, look by hand (match the loose rule only): Users ${outside.map((l) => `#${l.id}`).join(', ')}`);
  }

  const toRetire: Candidate[] = [];
  for (const c of candidates) {
    const d = details.get(c.id);
    if (!d) continue;
    const { logins, ...rest } = d;
    console.log(`\n${label(c)}`);
    console.log(`  logins: ${logins.length}${logins.length ? ` (${logins.map((l) => l.id).join(', ')})` : ''}`);
    console.log(`  ${JSON.stringify(rest)}`);
    if (d.otherUsersSameAddress > 0) {
      console.log('  SKIP: another Users row has this address; which one its tokens belong to is unclear');
      continue;
    }
    // Run the churches migrations first (20261015000001 makes whoever added it the owner).
    if (!d.church || d.church.owners.length === 0) {
      console.log('  SKIP: no owner but its own login; retiring it would leave the church unreachable');
      continue;
    }
    if (d.tokenEntityOtherCase > 0) {
      console.log('  note: token rows under this address in another case stay where they are (lookups are exact)');
    }
    if (d.pendingInvitesToAddress > 0) {
      console.log('  note: a pending invitation names this address; it is not changed');
    }
    toRetire.push(c);
  }

  if (!APPLY) {
    console.log(`\nDry run: ${toRetire.length} row(s) would move and lose their logins. Nothing was changed.`);
    return;
  }

  const leftBehind: string[] = [];
  for (const c of toRetire) {
    const logins = details.get(c.id)?.logins ?? [];
    const moved = await moveRow(c);
    console.log(`\n${label(c)}: moved ${JSON.stringify(moved)}`);
    for (const login of logins) {
      try {
        await supertokens.deleteUser(login.id);
        console.log(`  login ${login.id}: deleted`);
      } catch (e) {
        console.log(`  login ${login.id}: NOT deleted (${e instanceof Error ? e.name : 'unknown'}) - maps to no row now`);
        leftBehind.push(login.id);
      }
    }
  }
  if (leftBehind.length) {
    console.log(`\nLogins left behind: RETIRE_LOGIN_IDS=${leftBehind.join(',')} ... --apply`);
    process.exitCode = 1;
  }
};

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
