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

There IS a test suite (the "no test suite" note here was stale): `npx jest` runs the unit
suites — 703 tests / 64 suites as of 2026-10-22. Read the **`Test Suites:`** line, not just
`Tests:` — a suite that fails to LOAD reports 0 tests while the others still read green.

Integration tests are a separate config and are EXCLUDED from `npx jest`
(`testPathIgnorePatterns`). They need a real Postgres, in a container that does not restart
itself after a reboot, so a green `npx jest` proves nothing about them:

```bash
docker start csp-test-pg   # or the docker run in jest.integration.config.js the first time
npx sequelize-cli db:migrate --url postgres://admin:1234@127.0.0.1:55433/csp_test \
  --migrations-path src/db/migrations
npm run test:integration   # 152 tests / 9 suites (2026-10-22): engine, payout reports, churches; PCO+QBO faked
```

If every integration test fails at once, check the container before the code — a stopped
`csp-test-pg` fails all 33 with `SequelizeConnectionRefusedError ... 55433`. A fresh worktree
also needs `src/db/config/config.json` copied in; it is gitignored, and without it every suite
fails to load with `Cannot find module './config/config.json'`.

Node version is pinned to **v18.13.0** (`.nvmrc`), though the deploy image (`DockerfileBE`) still uses `node:14-slim` — prefer matching `.nvmrc` locally.

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
- **`src/routes/routers.ts`** is the single flat route table — every endpoint is registered here, mapping a path (from `src/constant/routes.ts`) to a controller function. **Most routes are wrapped in `verifySession()`** (SuperTokens) for auth; the few with no session are `/`, the invitation/password-reset endpoints, and the scheduler's endpoints (`dailyJournalSync`, `automationScheduler`, `latest*Automation`, `checkLatest*`), which take `requireAutomationKey` instead. `PUBLIC` in `src/routes/__tests__/routers.test.ts` lists them with reasons and fails on any other. Check the wrapping before assuming an endpoint is authed.
- **Every church endpoint also has a church guard** (2026-10-15) between `verifySession()` and the
  handler: `requireAccountAccess(locate, need)` for the older endpoints (they name the church by
  its account's `email` / `userId` in the request) and `requireChurch(need)` for `/church/*` (by
  `churchId`). Both live in `src/services/churchAccess.ts`, the one place access is decided:
  a person's own Users row always; otherwise an accepted `ChurchMembers` row on the church filed
  under that account; `'integrations'` needs owner or `integrationAccessEnabled`; `'owner'` needs
  role owner. Refusals are 403 (never 401 - SuperTokens' frontend would try a refresh), unknown
  church 404. The guard leaves `res.locals.actor` / `res.locals.churchAccess`; handlers that write
  must act on `res.locals.churchAccess.account`, never re-read the church from the request.
  `src/routes/__tests__/routers.test.ts` fails if a session route is added without a guard (or with
  the wrong need/kind) and isn't on its allow-list.

### Controllers (`src/controller/`) — where the business logic lives

- **`auth.ts`** — OAuth connect + callback for QuickBooks (`authQuickBook`/`callBackQBO`) and Planning Center (`authPlanningCenter`/`callBackPC`). `GET /authQB` and `/authPC` take `?state=` (the browser's one-time value: lowercase hex, 32 to 64 characters), put it in the provider's sign-in address unchanged and send that address back as a bare string; any other state is a 400 `{ success: false, message: 'Missing or invalid state' }`. The browser checks the provider returns the same state (OAuth CSRF). The callbacks exchange the code and return the tokens; the browser files them via `updateUserToken`. Stripe Connect (`authStripe`/`callBackStripe`) was removed 2026-10-16: CSP cannot use it. `STRIPE_CLIENT_ID` stays for the legacy payout code (`refreshAccessToken` in `stripe.ts`).
- **`qbo.ts`** — QuickBooks reads/writes: `getAllQboData` (accounts/classes/customers), deposits (`deleteQboDeposit`, `getDepositRef`), projects/customers.
- **`planning-center.ts`** — PCO reads: `getBatches`, `getFunds`, `handleRegistrationEvents`. `getFunds` keeps every fund except visibility `nowhere` (`isLiveFund`): Planning Center's "Link Only" label is API `hidden` and live, and dropping it hid Legacy Offering from the Mapping page (2026-10-13).
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

### Registrations from the payout report (`src/services/payoutReport/`)

Planning Center pays giving and registrations out in the same Stripe deposits, but its
Registrations API has no payments, so CSP records event money from the **payout report** the
bookkeeper exports ("full transaction details") and uploads on the Clearing page. Design and API
contract: `docs/plans/2026-10-08-registrations-import.md` in the frontend repo (section 6).

- `parsePayoutReport` keys each row `registration|donation:<id>:<type>:<day>:<grossCents>`
  (a repeat in the same file gets `#2`). `Date` is the charge or refund date; the file has **no
  payout id**, so rows are recorded but not matched to a deposit.
- `classifyRows` (pure): `to_post` / `already_recorded` / `before_start` / `giving` / `held`.
  Anything not positively recognised is held for a person, never skipped.
- `importPayoutReport` posts one entry per day and kind: `CSP-E-<day>-<n>` for charges (gross to
  the event's account + class, fee to the fee account, net to clearing) and `CSP-ER-<day>-<n>` for
  refunds. `n` comes from `DailyJeSync.registrationEntryCount`, kept apart from giving's
  `entryCount`, under the same row lock the giving engine takes.
- **Exactly once.** `PayoutTransactions` is unique on `(userId, rowKey)`, and one upload runs at a
  time per church (`pg_try_advisory_xact_lock(74010, userId)`; a second gets 409 "busy").
  `failed` (QuickBooks said no) is retried by the next upload. `pending` is **never** retried: a
  row left pending means QuickBooks may already have the entry, so it waits in the review list as
  `posting_interrupted` for a person to mark posted (with the entry number) or post now.
- Giving lines in the file are checked against CSP's day ledger (`givingCoverage`): covered when
  the gift is one of Planning Center's settled Stripe gifts that day (refunded since or not) and
  `DailyJeSync.postedGrossCents` covers the day's settled gross; a refund line when
  `refundedGrossCents` covers the file's refunds that day. Planning Center unreachable means
  "couldn't check", never "covered"; a database error throws. Verified on Active's September file
  against production: 348 giving lines, 0 flagged.
- Setup, refused with 409 and a sentence otherwise: a registration start date
  (`startDateAutomationRegistration`, by charge date), a v2 mapping in `settingRegistrationData`
  (`{ version: 2, default: { account, class }, events: [{ signup, account, class }] }` - the old
  Stripe-era array is ignored), a clearing account (the `registration` bank slot, else `donation`;
  the two must be the same account because the Clearing page tracks one), and a fee account
  whenever a row carries a fee.
- The payout-report routes sit behind the church guard like every church endpoint, and
  `controller/payoutReport.ts` records the session user (`res.locals.actor`), not the request, as
  the uploader.
- **Every upload names its payout dates** (2026-10-22): preview and import require `payoutFrom` /
  `payoutTo` (YYYY-MM-DD, the PAYOUT dates the file was exported for - the rows carry charge dates
  only). 400 with a sentence when missing, reversed, ending after the church's local today, or
  crossing a month-end (`payoutRange.ts`). Stored on `PayoutReportUploads` (migration
  `20261022000001`); older uploads have null = "range unknown".
- **Still in transit at month-end** (`GET /user/payoutReport/outstanding?email=&month=YYYY-MM`;
  pure `outstanding.ts`, loader `outstandingReport.ts`; plan
  `docs/plans/2026-10-22-outstanding-deposits.md` in the frontend repo). An item in a file whose
  payout range ends on or before D was paid out; after D, or in no file, it is in transit. Giving
  comes from Planning Center only for posted days the files don't settle (same selection as the
  engine; a Planning Center failure is a 502 with a sentence). QuickBooks' balance on D =
  `CurrentBalance` less the General Ledger detail rows dated after D, read only from the section
  whose header names the clearing account; unreadable is `qbo.balance: null` + a message, not a
  500. Checked on Active's September files: 18 gifts / $4,689.62, 19 / $6,439.32 with the 9/30
  ACH settled - Matt's reconciled figure.
- `settingRegistrationData` now holds the v2 object. The Stripe-era code (`stripe.ts`,
  `automation.ts`, `utils/automation-helper.ts`) reads it only through `legacyRegistrationList()`,
  which returns [] for v2 - never call `.find`/`.filter` on the raw setting.

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

**A donor-covered fee is still the church's expense.** When a donor "covers the fee", Planning
Center bumps the charge - a $200.00 gift becomes a $204.70 charge - and records the donation at
the GROSS $204.70, which is what the donor's receipt and giving statement show. The donor did not
pay Stripe for the church; they made a larger gift. The church stays the merchant of record and
incurs the whole $4.70. So the ordinary arithmetic is already right:

    credit revenue   $204.70     the gift, as the donor's statement shows it
    debit  fees        $4.70     what Stripe took
    debit  clearing  $200.00     what Stripe deposits

`chargeableFeeCents` therefore counts every fee, `fee_covered` or not. Excluding covered fees was
implemented here on 2026-09-09 and reverted the same day: it would have left the clearing account
overstated by the fee against a deposit that will only ever be $200.00 - the exact reconciliation
break the fee split exists to prevent - and netted a processing fee against contribution revenue,
which GAAP does not permit and which understates both figures on the church's return.

`fee_covered` stays useful for one thing: PCO documents that it can only be true for donations
processed through Stripe, making it the one field that positively proves Stripe handled a gift.
Still unobserved in live data - the test organisation has no fee-covered donations - so the
amounts above come from PCO's help documentation, not a record.

**The nightly run sweeps donations, not batches.** `dailyJournalSync` (POST
`/csp/dailyJournalSync`, Cloud Scheduler, 8am) calls `runDailyDonationSync` per church, which
fetches each day from the organisation-level `/giving/v2/donations` endpoint and hands the
result to the same engine. Planning Center puts cash, cheques, external sources and CSV imports
into batches; online giving goes through Planning Center Payments and is NOT batched, so the old
batch sweep (`latestFundAutomation`) was looking for Stripe money in the one place it never is.
That endpoint is still routed and still works, but nothing schedules it.

Three things about the day window are load-bearing, each established against the live API:

- **Date-only strings, never instants.** PCO reads `2026-09-08` in the organisation's own
  timezone and handles DST itself, so the server's day and `dayKey` agree by construction. An
  explicit `Z` instant disagrees by a whole day.
- **Half-open `[gte, lt)`.** With `lte`, consecutive days overlap and the same donation is
  returned twice - proven live on donations 171050122 and 171050228. Delta posting then posts
  real money twice. `gt` on the start is the mirror hazard: date-only gifts sit exactly at org
  midnight and would all be dropped.
- **No `filter=succeeded`.** Its meaning is undocumented and unverifiable, an unknown `filter=`
  value returns 200 with every row, and if the scope also excludes refunded donations it would
  starve the refund pass in silence. `isStripeElectronic` stays the authority.

**`isStripeInTransit` is its sibling, and is never posted.** Same payment-method test, but
`payment_status === 'pending'` and not refunded: giving Stripe has accepted and not finished.
It exists only so `getStripeGivingByDay` can TELL a church what is still coming
(`inTransit` / `inTransitGross`); it must never feed a journal entry, because the money has
not arrived and the clearing account could never clear it. A refunded pending gift is a
cancellation, not money in transit, so it is excluded.

The claim scope is `daily:<YYYY-MM-DD>`, so the existing unique index on
(userId, batchId, donationId) gives one row per church per day. It is keyed on `received_at`,
which never moves - unlike `completed_at`, which jumps forward when an ACH gift settles.

The run settles yesterday and re-examines the previous `DEFAULT_CATCH_UP_DAYS` days, because
ACH settles late: a Tuesday gift is still `pending` at Wednesday 8am and correctly stays out,
then tops Tuesday up as an adjusting entry once it clears. Re-examining a day costs nothing
when its total has not changed.

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
- **`PayoutReportUploads`** - one row per payout report uploaded (file name, uploader, charge-date range, summary JSON); the Clearing page's "last payout report loaded".
- **`PayoutTransactions`** - every payout-report row a church has uploaded, unique on `(userId, rowKey)`, with `status` (`posted` / `pending` / `failed` / `before_start` / `giving_covered` / `giving_not_posted` / `held` / `resolved` / `dismissed`) and `reason`.
- **`DailyJeSync.registration*`** - registration gross and fee, refund gross and fee, entry count and entry ids per day (migration `20261008000001`). `netCentsOf` adds them, so the Clearing statement, "posted to date" and the switch-over include registrations.
- **`registration`**, **`billing`**, **`emailLog`**, **`userEmailPreferences`** — registration events, subscription billing info, sent-email log, and notification recipient prefs.

**Churches** (2026-10-15; plan `church-sync-pro/docs/plans/2026-10-14-church-access-and-bookkeeper-screens.md`):

- **`Churches`** - `ownerUserId` is the church's **account**: the Users row its settings, tokens and
  postings are filed under (unique: one church per account row, `churches_owner_user_unique`). For
  Active Church that is Matt's own login; a church added with `POST /church/create` gets an account
  row with an `@accounts.churchsyncpro.invalid` address and no SuperTokens user, so nobody can sign
  in as it (`churchAccountEmail.ts`; sign-up refuses that domain, the guard never treats it as a
  person). The money tables were deliberately NOT re-keyed to `churchId`: `(userId, day)` etc. are
  already per church because the account row is 1:1 with it. The Phase 1 `churchId` columns on
  data tables are unused and unmaintained.
- **`ChurchMembers`** - who may work on a church: `role` owner|bookkeeper, `integrationAccessEnabled`,
  `inviteAccepted`; pending invites carry `invitedEmail` + `invitationToken` (unique per church per
  pending address). Access reads this table only. The legacy **`bookkeeper`** table is kept in step
  (invites, acceptance and the legacy delete write both) until its routes are retired.
- `src/services/churches.ts` runs the Churches page and People tab (`/church/*`, controller
  `church.ts`): `listMyChurches` (creates a client login's own church on first call),
  `createChurch` (creator becomes owner), `updateChurch`, `listPeople`, `invitePerson` (an existing
  login is added straight away; otherwise a pending member and a copyable link - SendGrid failures
  return `emailSent: false`), `setIntegrationAccess`, `removePerson` (never the last owner or the
  church's own login). Advisory locks 74020/74021 guard create/remove; 74010 is the payout import.
- Migration `20261015000001-resync-church-members` caught memberships up with the legacy table and
  made the bookkeeper who added a Clients-page church its owner (only for the synthetic
  `<slug>-<their email>` address; it logs what it promotes/drops/can't match). Before running it on
  production read `bookkeeper` rows and duplicate emails (see the plan's section 9).
- The nightly `dailyJournalSync` skips churches whose `Churches.isActive` is false
  (`church_inactive`); a body `email`/`days` override must be valid or it's a 400 (an empty email
  used to mean "every church").

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

## Branches: `main` is production, `develop` is staging

The same rule holds in the frontend repo (`church-sync-pro`), set up 2026-10-06.

- **`main` is what runs in production**, nothing more. `make deploy-prd` and
  `make migrate-prd` refuse to run unless the checkout is on `main`, clean, and equal to
  `origin/main`. That makes migrations safe too: a migration file that exists only on
  `develop` (e.g. the `20260925*` churches tables) cannot reach the production database.
- **`develop` is what runs on staging.** Everything lands there first. Work not ready
  for the live church — sign-up email verification, churches-as-entities — stays on
  `develop` only until it is released on purpose.
- **Start new work from `main`, not `develop`:** `git switch -c feat/<thing> origin/main`.
  Merge it into `develop` to try it on staging; merge it into `main` when it should
  ship. A branch cut from `develop` drags all of develop's unreleased work with it and
  can never ship alone. The exception is work that builds on develop-only code
  (anything touching email verification or churches): it ships together with that work.
- **Hotfix:** branch from `main`, merge into `main`, deploy, then merge `main` into
  `develop`.
- **Deploy and migrate production from `../quickplan-connect-prod`**: a permanent
  worktree that stays on `main` and already holds the gitignored `.env.production` and
  `src/db/config/config.json`, plus a `node_modules` symlink to the main checkout's
  (ignored by git and `.dockerignore`) so `make migrate-prd` can run. `git pull
  --ff-only` there, then `make deploy-prd`. Never switch it to another branch.

Before this, production was deployed from hand-made cherry-pick worktrees that were
never pushed, so GitHub had no record of what was live, and `main`/`develop` were
years stale.

## Deploy (Google Cloud Run, via Makefile)

```bash
make deploy-stg     # SuperTokens core + backend → staging services "supertokens" / "csp-be"
make deploy-stg-be  # staging backend only
make deploy-prd     # builds DockerfileBE → GCR → Cloud Run service "csp-be-prd" (port 8080)
make migrate-prd    # migrations are MANUAL - deploy does not run them
```

`make migrate-prd` runs `NODE_ENV=uat-prd` - the same database the `production` config (and any
one-off production script) reads. For a release that touches money or clearing maths, snapshot
`getClearingStatement` for recent months and `getDailyJournalEntries` with the OLD code (the
`-prod` worktree before you pull) and again with the NEW code after migrating; deploy only if
they match field for field (done for the registrations release, 2026-10-13).

`deploy-supertoken` requires `SUPERTOKENS_DB_URI` and `SUPERTOKENS_API_KEY` exported;
it fails fast if they are unset.

`DockerfileBE` is a Node 18 multi-stage build that compiles to `dist/` and runs
`node dist/index.js`. It replaced a `node:14-slim` image that could no longer build
at all — Debian buster's apt repos are archived. Two things the build must keep
doing: copy `yarn.lock` (the old `COPY package*.json` never matched it, so no build
was reproducible), and copy `src/db/config/config.json` into `dist/` by hand, since
`tsc` does not emit `.json` and `src/db/index.ts` requires it at runtime.
Project `church-sync-pro-385703`, region `us-central1`. **Staging and production are separate databases on the same DigitalOcean cluster** — staging is `csp_staging`, production is `supertokens`. They used to be the same database; do not merge them again. Note Cloud Run URLs are now `SERVICE-1000606180549.us-central1.run.app`. The backend connects to managed Postgres (DigitalOcean) and a self-hosted SuperTokens core; env vars are injected from `.env.production` at deploy time. The commented Makefile header preserves the gcloud commands used to provision the Cloud SQL instance and SuperTokens image.

## Staging end-to-end run

`scripts/staging-e2e/run.sh` signs up fresh plus-addresses on staging and walks sign-up
verification, the church switcher, the Churches page (add, rename, deactivate) and the People
tab (existing-login invite, invite link and its acceptance, the integrations switch, remove,
the cross-church 403) through ego-browser, checking the database between browser phases and
printing a PASS/FAIL table (51 checks, stages A-G). It is visible live in Ego Lite.
`run.sh <tag> <stage>` resumes. Verification links are minted through the SDK
(`helper.ts mint`) and the invite link is read off the People tab, never an inbox. Run it after
any change to auth, churches, the People tab or invitations, before telling the client
something works. `BASE`, `BE` and `E2E_ENV` point it at a local stack instead (see the
script's header: serve a production build of the frontend, and stub SendGrid's send when mail
is disabled, because a refused verification mail hangs sign-up).
