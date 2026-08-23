# Deploy Checklist — Church Sync Pro Backend (`csp-be` / `csp-be-prd`)

Deploys go to **Google Cloud Run** (project `church-sync-pro-385703`, region `us-central1`) via the `Makefile`,
which injects env vars from `.env.staging` / `.env.production` at deploy time. **Migrations are NOT run by the
deploy** — they are a separate, manual step (see below).

> ⚠️ The DigitalOcean Postgres database `supertokens` is shared by the `staging`, `uat-prd`, and `production`
> `NODE_ENV` configs (see `src/db/config/config.json`). Migrating against any of them hits the same live DB.
> The `uat` config points at a separate test DB (`34.27.255.216`).

---

## Every deploy — do these in order

### 1. Run pending DB migrations FIRST (manual)
The app code depends on the schema. Run migrations **before** (or together with) deploying new code, or the
running service will error on missing tables/columns.

```bash
# Live DO database (covers staging + prod — they share it):
make migrate-prd          # == NODE_ENV=uat-prd npx sequelize-cli db:migrate

# Separate test DB only:
make migrate-uat          # == NODE_ENV=uat npx sequelize-cli db:migrate
```

Requires the DO CA cert at `cert/ca-certificate.crt` (referenced by the staging/prod DB config).

**Migrations that must be applied for the current release:**
- `20241201000000-add-usersync-status-and-unique-index` — adds `UserSync.status` + a UNIQUE index on
  `(userId, batchId, donationId)` (powers the atomic claim-then-post idempotency).
- `20241201000001-create-syncrun-table` — adds the `SyncRun` audit table (automation run history).

Verify after running: `SyncRun` table exists and `UserSync.status` column exists.

### 2. Confirm required env vars are present
The Makefile injects **every line** of `.env.<env>` as a Cloud Run env var. New since last release:

- **`AUTOMATION_API_KEY`** — REQUIRED. The automation endpoints are fail-closed; without this set they return
  `500 "Automation API key not configured"` and the daily sync will not run. (Already added to
  `.env.staging` / `.env.production`.)

Keep `.env.*` as bare `KEY=VALUE` lines (no `#` comments / blank-line gaps) — the Makefile does
`cat ${ENV_VAR} | xargs | tr ' ' ','`, which comments/spaces would corrupt.

### 3. Deploy
```bash
make deploy-stg     # staging  (service: csp-fe-style stack; backend via deploy-supertoken/-backend)
make deploy-prd     # production (service: csp-be-prd, port 8080)
```

### 4. Update the automation trigger to send the API key
The in-app `node-cron` is commented out in `src/app.ts`, so the daily automation is triggered **externally**
(e.g. Cloud Scheduler) by POSTing to the automation routes. Those callers must now send the header:

```
x-automation-key: <the AUTOMATION_API_KEY value for that environment>
```

Authenticated automation routes: `/csp/automationScheduler`, `/csp/latestFundAutomation`,
`/csp/latestRegistrationAutomation`, `/csp/checkLatestFund`, `/csp/checkLatestRegistration`.

> Confirm how the daily sync is actually triggered in prod today and update that trigger's header, or automated
> syncing will stop after this deploy.

---

## Rollback notes
- Each migration has a `down` (`make migrate-prd`'s sequelize-cli `db:migrate:undo`), but undoing the unique
  index / SyncRun table is only safe if no new code depends on them.
- Cloud Run keeps prior revisions; `gcloud run services update-traffic <svc> --to-revision=<rev>` reverts the app.

## Known pre-existing deploy debt (not blocking, worth scheduling)
- `DockerfileBE` runs `node:14-slim` (EOL) while `.nvmrc` says v18.
- `staging` + `production` share one DigitalOcean database.
- DB credentials live in committed `src/db/config/config.json` (rotate + move to secrets).
