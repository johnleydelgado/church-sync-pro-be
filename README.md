# Church Sync Pro — Backend API

`church-sync-pro-be` — the backend/API for **Church Sync Pro**, a SaaS tool that syncs church giving data between **Planning Center (PCO)**, **QuickBooks Online (QBO)**, and **Stripe**. Express + TypeScript, Sequelize over PostgreSQL, SuperTokens for auth.

> Paired with the **web client** (`church-sync-pro` repo). The client calls this API at `/csp/...`. This server listens on port **8080**.

## Tech stack

- **Express** + TypeScript, run with **ts-node** (no build step in dev)
- **Sequelize** ORM over **PostgreSQL** (migrations via `sequelize-cli`)
- **SuperTokens** (`supertokens-node`) for authentication & sessions
- **intuit-oauth** + **node-quickbooks** (QBO), **Stripe** SDK, Planning Center REST API
- **SendGrid** (`@sendgrid/mail`) for notification emails; **Google Cloud Storage** for image uploads
- **node-cron** for scheduled sync (currently driven by external scheduler endpoints)

## Getting started

Requirements: Node **v18.13.0** (`.nvmrc`), yarn, Docker (for local Postgres + SuperTokens core).

```bash
# 1. Bring up Postgres + the SuperTokens core
docker compose up -d        # postgres:5432, supertokens:3567

# 2. Install deps and create your env file
yarn install
cp .env .env.local          # then fill in real values (see Environment below)

# 3. Run migrations and start the server
yarn db:migrate             # apply migrations to the dev DB
yarn dev                    # nodemon + ts-node, server on http://localhost:8080
```

The `development` database config (`src/db/config/config.json`) matches the `docker-compose.yml` Postgres (`127.0.0.1`, user `admin`, password `1234`, db `supertokens`).

### Scripts

```bash
yarn start                  # ts-node (no watch)
yarn dev                    # nodemon (reloads on change)
yarn format                 # eslint --fix

yarn db:migrate:gen <name>  # generate a migration
yarn db:migrate             # apply (NODE_ENV=development)
yarn db:migrate:undo        # undo last
yarn db:migrate:undo:all    # undo all
```

`sequelize-cli` reads paths from `.sequelizerc` (config + migrations + models under `src/db`).

## API surface

All routes are mounted under **`/csp`** and registered in `src/routes/routers.ts`. Most are protected by SuperTokens `verifySession()`; OAuth callbacks, payment intents, invitation/password-reset, and the automation/scheduler endpoints are public. Path constants live in `src/constant/routes.ts` (mirrored in the client's `routes-api.ts`). Endpoints are grouped by integration:

- **`/auth*`, `/callBack*`** — OAuth connect/callback for QBO, PCO, Stripe
- **`/qbo/*`** — QuickBooks accounts, classes, customers, deposits, projects
- **`/pc/*`** — Planning Center batches, funds, registration events
- **`/stripe/*`** — payouts, multi-step payout sync, subscription payment intents
- **`/user/*`** — accounts, settings/mappings, billing, bookkeeper invites, email prefs
- **`automationScheduler`, `latestFundAutomation`, `checkLatest*`, ...** — automated sync entrypoints (called by an external scheduler; send SendGrid notifications)

Responses use a standard envelope via `src/utils/response.ts`: `{ code, message, data, success }`.

## Data model

Sequelize models in `src/db/models/`. Core entities: **`Users`** (`role: client | bookkeeper`) → **`UserSettings`** (sync mappings as JSON) → **`tokens`** (`token_type: stripe | qbo | pco`) grouped under **`tokenEntity`**; **`bookkeeper`** links a bookkeeper to a client; **`UserSync`** records synced batches/donations for idempotency; plus **`registration`**, **`billing`**, **`emailLog`**, **`userEmailPreferences`**. See `CLAUDE.md` for relationships and the client/bookkeeper access model.

## Environment

Loaded via `dotenv/config`. Required variables (see `.env`, `.env.staging`, `.env.production`):

`NODE_ENV`, `SECRET`, `API_URL`, `API_KEYS` (SuperTokens core), `SENDGRID_API_KEY`, Planning Center (`PC_APP_ID`, `PC_SECRET`, `PC_CLIENT_ID`, `PC_SECRET_APP`, `PC_REDIRECT`), QuickBooks (`QBO_KEY`, `QBO_SECRET`), Stripe (`STRIPE_SECRET_KEY`, `STRIPE_PUB_KEY`, `STRIPE_CLIENT_ID`), Google OAuth (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), and link bases (`INVITATION_URL`, `RESET_PASSWORD_URL`, `SETTING_FUND_URL`).

> **Security note:** `.env*`, `src/db/config/config.json`, and the `Makefile` currently contain live credentials. Rotate and move these out of version control before any public release.

## Deployment

Dockerized (`DockerfileBE`) and deployed to Google Cloud Run via the `Makefile`:

```bash
make deploy-prd     # build → GCR → Cloud Run service "csp-be-prd" (port 8080)
make deploy-stg     # deploy the SuperTokens core image
```

Project `church-sync-pro-385703`, region `us-central1`, behind the `csp-vpc` connector. Production uses managed PostgreSQL (DigitalOcean) and a self-hosted SuperTokens core; env vars are injected from `.env.production` at deploy time.
