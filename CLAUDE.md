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

⚠️ **Live credentials are currently committed** to this repo — `src/db/config/config.json` (DigitalOcean Postgres user/passwords for staging/prod), the `Makefile` (DB password + SuperTokens `API_KEYS`), and `.env*`. Treat these as real production secrets: don't echo them in output or new commits, and flag if asked to add more.

## Deploy (Google Cloud Run, via Makefile)

```bash
make deploy-prd     # builds DockerfileBE → GCR → Cloud Run service "csp-be-prd" (port 8080)
make deploy-stg     # deploys the SuperTokens core image (csp-vpc connector)
```
Project `church-sync-pro-385703`, region `us-central1`. The backend connects to managed Postgres (DigitalOcean) and a self-hosted SuperTokens core; env vars are injected from `.env.production` at deploy time. The commented Makefile header preserves the gcloud commands used to provision the Cloud SQL instance and SuperTokens image.
