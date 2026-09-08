# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`church-sync-pro-be` — the **backend/API** for Church Sync Pro, a SaaS tool that syncs church giving data between **Planning Center (PCO)**, **QuickBooks Online (QBO)**, and **Stripe**. Express + TypeScript (run directly via `ts-node`, no build step in dev), Sequelize over PostgreSQL, SuperTokens for auth.

The **frontend** is a separate repo (`church-sync-pro`, a CRA app). It calls this server at `/csp/...`. This server listens on **8080**; the frontend's `REACT_APP_API_PATH` points at `http://localhost:8080/csp/`. Endpoint path constants are mirrored on both sides (`src/constant/routes.ts` here ↔ `src/common/constant/routes-api.ts` in the frontend) — keep them in sync when adding endpoints.

## Commands

```bash
yarn start          # ts-node -r dotenv/config index.ts  (runs the server, no watch)
yarn dev            # nodemon — same but reloads on change
yarn format         # eslint src/**/*.ts --fix

# Migrations (sequelize-cli, config from .sequelizerc → src/db/config/config.json)
yarn db:migrate:gen <name>   # generate a new migration file
yarn db:migrate              # NODE_ENV=development, apply migrations
yarn db:uat:migrate          # NODE_ENV=uat
yarn db:prd:migrate          # NODE_ENV=uat-prd (note: runs against the prod DB)
yarn db:migrate:undo         # undo last
yarn db:migrate:undo:all     # undo all
```

No test suite exists. Node version is pinned to **v18.13.0** (`.nvmrc`), though the deploy image (`DockerfileBE`) still uses `node:14-slim` — prefer matching `.nvmrc` locally.

### Local dependencies (Postgres + SuperTokens core)

`docker-compose.yml` brings up the two infra pieces this server needs:
```bash
docker compose up -d        # postgres:5432 (admin/1234, db "supertokens") + supertokens-core:3567
```
The `development` DB config in `src/db/config/config.json` matches these (`127.0.0.1`, user `admin`, pass `1234`).

## Architecture

### Request lifecycle

`index.ts` → `src/app.ts` (the Express app) → `src/routes` → `src/controller/*`.

- **`src/app.ts`** does all wiring: SuperTokens `init()` (with custom `signUpPOST`/`emailPasswordSignUpPOST` overrides that upsert a row into the `Users` table on signup), security headers, CORS (locked to `websiteDomain`, credentials on), the SuperTokens `middleware()`, then mounts the app router at **`/csp`**. A `node-cron` block exists but is currently commented out.
- **`src/routes/routers.ts`** is the single flat route table — every endpoint is registered here, mapping a path (from `src/constant/routes.ts`) to a controller function. **Most routes are wrapped in `verifySession()`** (SuperTokens) for auth; a handful are intentionally public (e.g. `authStripe`, `callBackStripe`, `createPaymentIntent`, `getUserRelated`, invitation/password-reset endpoints, and the `automation*`/`checkLatest*` cron-style endpoints). Check the wrapping before assuming an endpoint is authed.

### Controllers (`src/controller/`) — where the business logic lives

- **`auth.ts`** — OAuth connect + callback flows for the three integrations: `authQuickBook`/`callBackQBO`, `authPlanningCenter`/`callBackPC`, `authStripe`/`callBackStripe`. These exchange OAuth codes and persist tokens.
- **`qbo.ts`** — QuickBooks reads/writes: `getAllQboData` (accounts/classes/customers), deposits (`deleteQboDeposit`, `getDepositRef`), projects/customers.
- **`planning-center.ts`** — PCO reads: `getBatches`, `getFunds`, `handleRegistrationEvents`.
- **`stripe.ts`** — the largest controller: payouts (`getStripePayouts`), the multi-step sync (`syncStripePayout`, `syncStripePayoutRegistration`, `finalSyncStripe`), `getStripeList`, and `createPaymentIntent` (the app's own subscription billing).
- **`automation.ts`** — the **automated sync engine**: token refresh (`generateQBOToken`, `generatePcToken`), batch/donation traversal, `automationDeposit` (pushes PCO donations into QBO as deposits), and the scheduled-style entrypoints (`automationScheduler`, `latestFundAutomation`, `latestRegistrationAutomation`, `checkLatestFund`, `checkLatestRegistration`). These last endpoints are designed to be hit by an external cron/scheduler and send notification emails via SendGrid, logging each send to the `EmailLog` table to avoid duplicates.
- **`user.ts`** — account/settings CRUD: users, settings (sync mappings), billing, bookkeeper invites, bank settings/charges, email preferences.
- **`index.ts`** — misc/shared handlers (`healthCheck`, `manualSync`, invitations, password reset, `createPayment`).
- **`db.ts`** — `addTokenInUser`.

### The daily journal entry engine (`src/services/syncEngine.ts`)

The product's core job: pull each day's **online giving** from Planning Center and
post one QuickBooks journal entry — credit revenue (gross), debit Stripe fees, debit
a clearing account for the net Stripe will deposit later. PCO is the source of truth;
the Stripe payout only matters when reconciling the clearing account afterwards.

### Tests

`npm test` is the unit suite (pure functions in `src/utils`). It cannot see the wiring, and
every defect found on 8-9 September 2026 lived in the wiring rather than inside any single
function - fees dropped by a summing pass that ran before the fee total, a refund pass that
never consulted the giving filter, a split-gift helper that met a drop-unmapped-lines guard
downstream.

`npm run test:integration` runs the real engine against a real Postgres, with Planning Center
and QuickBooks faked, asserting on the journal entries it tries to post. Bring the database up
first:

```
docker run -d --name csp-test-pg -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=1234 \
  -e POSTGRES_DB=csp_test -p 55433:5432 postgres:15
npx sequelize-cli db:migrate --url postgres://admin:1234@127.0.0.1:55433/csp_test \
  --migrations-path src/db/migrations
```

`NODE_ENV=test` builds its connection from `TEST_DB_*` environment variables rather than
`config/config.json`, which is gitignored. Add a case here before changing anything the engine
does with money.

**A donor-covered fee is not the church's expense.** When a donor ticks "cover the processing
fee" they are charged the gift plus the fee, so Stripe deposits the whole gift and the church
pays nothing. Planning Center marks that `fee_covered: true` while still populating `fee_cents`,
so summing fees blindly books a cost the church never incurred and leaves the clearing account
short of the deposit by exactly that amount. `chargeableFeeCents` skips them. PCO also documents
that `fee_covered` can only be true for donations processed through Stripe, which makes it the
one field that positively proves Stripe was involved.

Not yet seen in live data: the test organisation has zero fee-covered donations, so this rests
on PCO's field documentation (`amount_cents` is "derived from the total of all of a donation's
associated designation's `amount_cents` values", i.e. the gift, not the gift plus the fee).
Confirm against a real fee-covered record before treating it as settled.

**The posting decision is delta-based.** A `(userId, batchId, day)` claim records what it
actually posted - `postedGrossCents`, `postedFeeCents` and a per-account `postedByAccount`
split. On a later run the engine compares the batch's current contribution for that day
against those amounts and posts only the increase, as an adjusting entry crediting the right
funds. An unchanged batch posts nothing. This is what lets a batch that GREW top its day up:
before it, the claim was a bare flag, so once a day was posted that batch could never add to
it again - and the pagination fix produces exactly that situation the first time it fetches a
batch Planning Center had been truncating at 25 donations.

Two things to keep in mind when touching it. A claim whose `postedByAccount` is null was
written before this bookkeeping existed and has no baseline, so it is treated as complete
rather than re-posted; do not "helpfully" backfill those to zero, which would re-post the
whole day. And the cheap fast-path above compares amounts for the same reason - comparing
only the posted flag made it skip a grown batch before the delta logic could run.

**Scope: this filter exists only for the daily journal entry.** `filterStripeElectronic`
is used nowhere but `services/syncEngine.ts`, and `syncBatchToJournalEntries` has exactly
two callers - the manual sync in `controller/index.ts` and `dailySyncing` in
`utils/automation-helper.ts`, which the nightly Cloud Scheduler job drives. Both are the
same feature: the daily sync a church configures under Automation -> Mapping. The
transactions pages, batches view, payout view and registration sync do not use it. So a
change here can only affect the daily journal entry - and it affects all of it.

Order of operations matters and is easy to break:

1. `filterStripeElectronic` runs **first**. Planning Center's Giving API returns
   exactly four `payment_method` values — `cash`, `check`, `card`, `ach` — per PCO's own
   published field documentation, which is served without auth at
   `api.planningcenteronline.com/giving/v2/documentation/2019-10-18/vertices/donation`
   and is the authoritative source for this API (the interactive docs site is a JS app
   and the live API accepts unknown filter values silently, so neither can settle an enum). Only `card` and `ach` are Stripe-processed.
   Also required: not refunded, `payment_status` not pending or failed, and a
   non-zero `fee_cents`. The payment source is named "Planning Center" on real
   records, never "Stripe", so the source-name check is a fallback that never fires
   in production — the fee is what marks Stripe's involvement. Cash and cheques are
   out of scope. This must stay ahead of the duplicate-designation summing below — that step
   collapses every donation sharing a fund and adds their amounts, so running it
   first folds a cash gift into a card one and posts it as online giving.
2. Duplicate designations per fund are summed.
3. Donations are grouped by day (`dayKey` — note it uses the raw timestamp offset;
   timezone normalisation is an open product decision).
4. Per day: claim `DailyJeSync` (unique on `userId, day`) with `SELECT … FOR UPDATE`,
   then post. `entryCount > 0` means the day already exists in QBO, so the
   contribution becomes an **adjusting entry** rather than editing a posted
   transaction.
5. `UserSync` (unique on `userId, batchId, donationId`) makes re-runs idempotent.

Committing a PCO batch flips its donations from `pending` to `succeeded` — and the
sync only reads `filter=committed` batches, which is why the completeness check is
safe.

**Refunds** are reversing entries posted on the day the refund was *processed*
(`refunded_at`), never an edit to the original day — the client's decision. They come
from the unfiltered batch list (refunded donations never pass the giving filter), read
each Refund's amount / returned fee / `designation_refunds` split, and are claimed on
`UserSync` as `refund:<day>` so re-runs can't double-post. `DailyJeSync` carries
`refundedGrossCents` / `refundedFeeCents` alongside the posted figures.

**Days are the church's local date.** `dayKey(donation, timeZone)` converts PCO's UTC
`received_at` using the org timezone from `GET /giving/v2` (`attributes.time_zone`).
Without it an 8pm Eastern gift lands on the next day's entry.

**The clearing "balance" CSP can compute is only what it added** — it never sees the
accountant clearing deposits. `getDailyJournalEntries` and `getClearingStatement`
therefore also read the account's live `CurrentBalance` from QuickBooks and return
both; the statement returns the difference explicitly. Don't present the cumulative
figure as the balance.

This module, `services/qboClient.ts`, `utils/httpRetry.ts`, `utils/automationAuth.ts`
and the JE builder in `utils/mapping.ts` are the standard for new code: integer cents
throughout, balance assertions before posting, structured logging, rethrow rather
than swallow.

### Data model (`src/db/models/`, Sequelize)

`src/db/index.ts` creates the Sequelize instance from `src/db/config/config.json` keyed by `NODE_ENV`. Models use `freezeTableName: true` (model name = table name). Key entities and relationships:

- **`Users`** — the account. `role` is `'client' | 'bookkeeper'`. `hasOne(UserSettings)`, has many `tokens`, `userEmailPreferences`.
- **`UserSettings`** — per-user sync configuration stored as JSON columns: `settingsData` (fund→QBO mapping), `settingRegistrationData`, `settingBankData`, `settingBankCharges`, plus automation flags (`isAutomationEnable`, `isAutomationRegistration`) and `startDateAutomation*`.
- **`tokens`** — OAuth tokens per integration; `token_type` is `'stripe' | 'qbo' | 'pco'`, with `access_token`/`refresh_token`/`realm_id`/`organization_name`. Belongs to `Users` and `tokenEntity` (cascade delete).
- **`tokenEntity`** — groups tokens/bookkeepers under an `email` with an `isEnabled` flag (the integration "owner" a bookkeeper connects to).
- **`bookkeeper`** — links a bookkeeper user to a client (`userId` ↔ `clientId`) plus invitation state (`invitationToken`, `inviteSent`, `inviteAccepted`, `bookkeeperIntegrationAccessEnabled`).
- **`UserSync`** — record of synced data (`syncedData` JSON, `batchId`, `donationId`) for idempotency/audit.
- **`registration`**, **`billing`**, **`emailLog`**, **`userEmailPreferences`** — registration events, subscription billing info, sent-email log, and notification recipient prefs.

The **client/bookkeeper** distinction is core: a bookkeeper operates on a client's data via the `bookkeeper`→`tokenEntity` linkage. Mirror this when adding any data access.

### External integrations & helpers (`src/utils/`)

- **`quickbookAuth.ts`** — `intuit-oauth` client (sandbox vs production keyed on `NODE_ENV`).
- **`quickBookApi.ts`** — `node-quickbooks` client factory; takes `{ACCESS_TOKEN, REFRESH_TOKEN, REALM_ID}`. Note `src/constant/config.ts` holds a module-level mutable `ACCESS_TOKEN`/`REALM_ID` (`setToken`/`setRealmId`) — a global, not request-scoped; be careful with concurrency.
- **`storage.ts`** — uploads images to the GCS bucket `images-csp` (`@google-cloud/storage`).
- **`automation-helper.ts`, `mapping.ts`, `helper.ts`** — sync/mapping transforms.
- **`response.ts`** — standard response envelope: use **`responseSuccess(res, data)`** and **`responseError({res, code, message, data})`**. Responses are `{ code, message, data, success }`. Follow this shape for new endpoints.

### Conventions

- **Prettier:** semicolons **on**, single quotes, trailing commas, `printWidth: 120` (`.prettierrc`) — note this differs from the frontend (which omits semicolons).
- ESLint is just `@typescript-eslint/recommended` with no extra rules; `any` is used freely. `dist/` is the tsc `outDir` but dev runs straight from TS via ts-node.
- Many controllers mix CommonJS `require()` (SuperTokens, QuickBooks, SendGrid) with ES imports — this is expected, not a bug to "fix."

## Environment & secrets

Env is loaded via `dotenv/config`. Required `REACT_APP`-free vars (see `.env`, `.env.staging`, `.env.production`): `NODE_ENV`, `SECRET`, `API_URL`, `API_KEYS` (SuperTokens core key), `SENDGRID_API_KEY`, `PC_APP_ID`/`PC_SECRET`/`PC_CLIENT_ID`/`PC_SECRET_APP`/`PC_REDIRECT` (Planning Center OAuth), `QBO_KEY`/`QBO_SECRET` (QuickBooks), `STRIPE_SECRET_KEY`/`STRIPE_PUB_KEY`/`STRIPE_CLIENT_ID`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `INVITATION_URL`, `RESET_PASSWORD_URL`, `SETTING_FUND_URL`.

`QBO_USE_SANDBOX` decides which QuickBooks to talk to, **not** `NODE_ENV`. Only the
exact string `"false"` selects a real company file; anything else fails safe to the
sandbox. `quickBookApi` and `quickbookAuth` share one `useSandbox()` helper — keep
them in agreement, or the app authorizes against one environment and calls the other.

⚠️ **`src/db/config/config.json` is untracked and gitignored** (see
`config.sample.json`), and the Makefile's secrets moved to `SUPERTOKENS_DB_URI` /
`SUPERTOKENS_API_KEY`. But the DigitalOcean password is still present in **seven
earlier commits**, so it remains exposed until rotated. Never re-commit real
credentials, never echo them, and don't add new ones to tracked files.

## Deploy (Google Cloud Run, via Makefile)

```bash
make deploy-stg     # SuperTokens core + backend → staging services "supertokens" / "csp-be"
make deploy-stg-be  # staging backend only
make deploy-prd     # builds DockerfileBE → GCR → Cloud Run service "csp-be-prd" (port 8080)
make migrate-prd    # migrations are MANUAL - deploy does not run them
```

`deploy-supertoken` requires `SUPERTOKENS_DB_URI` and `SUPERTOKENS_API_KEY` exported;
it fails fast if they are unset.

`DockerfileBE` is a Node 18 multi-stage build that compiles to `dist/` and runs
`node dist/index.js`. It replaced a `node:14-slim` image that could no longer build
at all — Debian buster's apt repos are archived. Two things the build must keep
doing: copy `yarn.lock` (the old `COPY package*.json` never matched it, so no build
was reproducible), and copy `src/db/config/config.json` into `dist/` by hand, since
`tsc` does not emit `.json` and `src/db/index.ts` requires it at runtime.
Project `church-sync-pro-385703`, region `us-central1`. **Staging and production are separate databases on the same DigitalOcean cluster** — staging is `csp_staging`, production is `supertokens`. They used to be the same database; do not merge them again. Note Cloud Run URLs are now `SERVICE-1000606180549.us-central1.run.app`. The backend connects to managed Postgres (DigitalOcean) and a self-hosted SuperTokens core; env vars are injected from `.env.production` at deploy time. The commented Makefile header preserves the gcloud commands used to provision the Cloud SQL instance and SuperTokens image.
