/**
 * Backend-side helpers for the staging end-to-end run (scripts/staging-e2e/run.sh).
 * Each subcommand prints one JSON line. Everything here is read-only against staging
 * except `mint`, which creates an email-verification token - the same thing the
 * verification email carries - so the run does not have to wait on an inbox.
 *
 *   NODE_ENV=staging DOTENV_CONFIG_PATH=.env.staging npx ts-node -r dotenv/config \
 *     scripts/staging-e2e/helper.ts <mint|invite-link|client-row|invitee-row> <arg>
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const supertokens = require('supertokens-node');
import EmailVerification from 'supertokens-node/recipe/emailverification';
import { buildSupertokensConfig, websiteDomain } from '../../src/supertokensConfig';
import sequelize from '../../src/db';
const ThirdPartyEmailPassword = require('supertokens-node/recipe/thirdpartyemailpassword');

const { INVITATION_URL } = process.env;
const out = (o: unknown) => console.log(JSON.stringify(o));
const rows = async (sql: string, replacements: Record<string, unknown>) => (await sequelize.query(sql, { replacements }))[0] as any[];

const commands: Record<string, (arg: string) => Promise<void>> = {
  async mint(email) {
    supertokens.init(buildSupertokensConfig());
    const users: Array<{ id: string }> = await ThirdPartyEmailPassword.getUsersByEmail(email);
    if (!users.length) return out({ email, error: 'no SuperTokens user with this email' });
    const verified = await EmailVerification.isEmailVerified(users[0].id, email);
    const t = await EmailVerification.createEmailVerificationToken(users[0].id, email);
    out({
      email,
      verified,
      link: t.status === 'OK' ? `${websiteDomain}/auth/verify-email?token=${t.token}&rid=emailverification` : null,
      status: t.status,
    });
  },

  async 'invite-link'(email) {
    const [r] = await rows(
      'SELECT "invitationToken", "inviteSent", "inviteAccepted", "clientId" FROM "bookkeeper" WHERE email = :email ORDER BY id DESC LIMIT 1',
      { email },
    );
    if (!r) return out({ email, error: 'no invitation row' });
    // Built exactly as controller/index.ts builds the link in the email.
    out({ ...r, link: `${INVITATION_URL}?bookkeeperEmail=${encodeURIComponent(email)}&invitationToken=${r.invitationToken}` });
  },

  async 'client-row'(churchName) {
    out(
      await rows(
        `SELECT u.id, u.email, u.role, b."userId" AS "bookkeeperUserId", b."inviteAccepted"
         FROM "Users" u LEFT JOIN "bookkeeper" b ON b."clientId" = u.id
         WHERE u."churchName" = :churchName ORDER BY u.id`,
        { churchName },
      ),
    );
  },

  async 'invitee-row'(email) {
    const [r] = await rows(
      `SELECT b."userId", b."inviteAccepted", u.role
       FROM "bookkeeper" b LEFT JOIN "Users" u ON u.id = b."userId"
       WHERE b.email = :email ORDER BY b.id DESC LIMIT 1`,
      { email },
    );
    out(r ?? { email, error: 'no invitation row' });
  },
};

const [cmd, arg] = process.argv.slice(2);
const fn = commands[cmd];
if (!fn || !arg) {
  console.error(`usage: helper.ts <${Object.keys(commands).join('|')}> <arg>`);
  process.exit(2);
}
fn(arg)
  .then(() => process.exit(0))
  .catch((e) => {
    out({ error: e?.message ?? String(e) });
    process.exit(1);
  });
