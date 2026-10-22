/**
 * Backend-side helpers for the end-to-end run (scripts/staging-e2e/run.sh). Each subcommand
 * prints one JSON line. Everything here is read-only except `mint`, which creates an
 * email-verification token - the same thing the verification email carries - so the run does
 * not have to wait on an inbox.
 *
 *   NODE_ENV=staging DOTENV_CONFIG_PATH=.env.staging npx ts-node -r dotenv/config \
 *     scripts/staging-e2e/helper.ts <command> <args...>
 *
 *   mint <email>               a verification token for that login
 *   churches <email>           the login's Users row and every church it is a member of
 *   member <churchId> <email>  that address's ChurchMembers row on the church (joined or invited)
 *   church <churchId>          one Churches row
 *
 * run.sh picks NODE_ENV and the env file (E2E_ENV / E2E_ENV_FILE), so a local stack works too.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const supertokens = require('supertokens-node');
import EmailVerification from 'supertokens-node/recipe/emailverification';
import { buildSupertokensConfig } from '../../src/supertokensConfig';
import sequelize from '../../src/db';
const ThirdPartyEmailPassword = require('supertokens-node/recipe/thirdpartyemailpassword');

const out = (o: unknown) => console.log(JSON.stringify(o));
const rows = async (sql: string, replacements: Record<string, unknown>) =>
  (await sequelize.query(sql, { replacements }))[0] as any[];

const commands: Record<string, { args: number; run: (...args: string[]) => Promise<void> }> = {
  mint: {
    args: 1,
    async run(email) {
      supertokens.init(buildSupertokensConfig());
      const users: Array<{ id: string }> = await ThirdPartyEmailPassword.getUsersByEmail(email);
      if (!users.length) return out({ email, error: 'no SuperTokens user with this email' });
      const verified = await EmailVerification.isEmailVerified(users[0].id, email);
      const t = await EmailVerification.createEmailVerificationToken(users[0].id, email);
      // The browser builds the link on the frontend under test: `${base}/auth/verify-email?token=...`,
      // the same path the email carries.
      out({ email, verified, status: t.status, token: t.status === 'OK' ? t.token : null });
    },
  },

  churches: {
    args: 1,
    async run(email) {
      const [user] = await rows('SELECT id, role FROM "Users" WHERE lower(email) = lower(:email) ORDER BY id LIMIT 1', {
        email,
      });
      if (!user) return out({ email, error: 'no Users row' });
      const churches = await rows(
        `SELECT c.id, c.name, c."isActive", c."ownerUserId", a.email AS "accountEmail",
                m.role AS "memberRole", m."inviteAccepted"
         FROM "ChurchMembers" m
         JOIN "Churches" c ON c.id = m."churchId"
         LEFT JOIN "Users" a ON a.id = c."ownerUserId"
         WHERE m."userId" = :userId ORDER BY c.id`,
        { userId: user.id },
      );
      out({ userId: user.id, role: user.role, churches });
    },
  },

  member: {
    args: 2,
    async run(churchId, email) {
      const [r] = await rows(
        `SELECT m.id, m.role, m."userId", m."inviteAccepted", m."invitedEmail", m."invitationToken",
                m."integrationAccessEnabled", u.email AS "userEmail", u.role AS "userRole"
         FROM "ChurchMembers" m LEFT JOIN "Users" u ON u.id = m."userId"
         WHERE m."churchId" = :churchId
           AND (lower(u.email) = lower(:email) OR lower(m."invitedEmail") = lower(:email))
         ORDER BY m.id DESC LIMIT 1`,
        { churchId: Number(churchId), email },
      );
      out(r ?? { churchId: Number(churchId), email, none: true });
    },
  },

  church: {
    args: 1,
    async run(churchId) {
      const [r] = await rows('SELECT id, name, "isActive", "ownerUserId" FROM "Churches" WHERE id = :id', {
        id: Number(churchId),
      });
      out(r ?? { id: Number(churchId), none: true });
    },
  },
};

const [name, ...args] = process.argv.slice(2);
const cmd = commands[name];
if (!cmd || args.length !== cmd.args || args.some((a) => !a)) {
  console.error(`usage: helper.ts <${Object.keys(commands).join('|')}> <args...>`);
  process.exit(2);
}
cmd
  .run(...args)
  .then(() => process.exit(0))
  .catch((e) => {
    out({ error: e?.message ?? String(e) });
    process.exit(1);
  });
