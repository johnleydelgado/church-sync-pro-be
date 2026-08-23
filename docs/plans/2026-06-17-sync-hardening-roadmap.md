# Sync Hardening Roadmap — Planning Center → QuickBooks

> **For Claude:** REQUIRED SUB-SKILL when executing: superpowers:executing-plans (or subagent-driven-development), task-by-task.
>
> **PROJECT CONSTRAINT: DO NOT COMMIT.** Every task ends in a **REVIEW CHECKPOINT** (show the diff, pause for the human). The human reviews + tests + commits.

**Goal:** Make the PCO→QuickBooks sync secure, correct under concurrency, reliable under failure, and maintainable — without changing the (now Journal-Entry-based) accounting behavior the SOW defined.

**Architecture today (for context):** Two trigger models (manual UI sync via `manualSync`; automated via externally-cron'd HTTP endpoints) and two divergent posting paths (legacy `getallUsers`→Deposit; new `dailySyncing`→Journal Entry). Core flow: PCO committed batches → donations (`?include=designations`) → fund→account mapping (`settingsData`) → QBO write → `UserSync` idempotency record.

**Target architecture:** One hardened, shared sync engine used by both manual and automated paths, with per-user token handling, atomic idempotency, paginated + retried external calls, and an auditable `SyncRun` record.

**Tech Stack:** Node 18, Express, Sequelize/Postgres, node-quickbooks, PCO Giving API v2, Stripe SDK, Jest (added in the JE work).

**Sequencing:** Phases are ordered by risk. **P0 is independent and should ship first.** P1 builds on P0. P2 is the larger refactor and should come after P0/P1 are verified. P3 (frontend) can run in parallel with P1/P2.

---

## PHASE 0 — Security & Correctness (P0, ship first)

### Task 0.1 — Authenticate the automation endpoints
**Why:** `routers.ts:130-137` exposes `automationScheduler`, `latestFundAutomation`, `latestRegistrationAutomation`, `checkLatestFund`, `checkLatestRegistration` with **no auth** → anyone can trigger all-tenant QBO writes / DoS.
**Files:** `src/routes/routers.ts`; new `src/utils/automationAuth.ts`; `.env*` / `.env.sample`.
**Approach:** Add a shared-secret middleware: read `AUTOMATION_API_KEY` from env; compare against an `x-automation-key` header (constant-time compare). Wrap all 5 automation routes. Document the header for whoever runs the external cron.
**Test:** Unit-test the middleware (missing/wrong/correct key → 401/401/next). Manual: curl the endpoint without/with the header.
**Risk:** The external scheduler config must be updated with the key at the same time, or automated syncs stop. Coordinate.
**REVIEW CHECKPOINT 0.1.**

### Task 0.2 — Fix the QBO token-refresh gate (cross-user bleed)
**Why:** `automation.ts:252,324` gate refresh on `quickbookAuth.isAccessTokenValid()` — a process-wide singleton populated only by the last OAuth callback (`auth.ts:43`). It's unrelated to the user being synced → posts with expired DB tokens or skips refresh.
**Files:** `src/controller/automation.ts` (`automationDeposit`, `automationJournalEntry`, `generateQBOToken`), `src/db/models/tokens.ts` (+ migration), delete dead `src/constant/config.ts` `setToken`/`setRealmId` + unused `REALM_ID` import in `src/utils/quickBookApi.ts`.
**Approach:** Refresh QBO tokens **per user** based on a stored expiry. Add `qbo_expires_at` to the `tokens` row (migration); when refreshing, persist new `access_token` + `expires_at`; the gate becomes `if (!arr.qbo_expires_at || isPast(arr.qbo_expires_at)) refresh`. Simplest safe interim: **always call `generateQBOToken`** per user before posting (QBO refresh tokens are reusable) and persist the result — removes the singleton entirely. Extract a `getQboClientForUser(email)` helper to centralize.
**Test:** Unit-test the expiry decision (valid/expired/missing). Manual: force an expired token, confirm a refresh happens and the post succeeds.
**Risk:** Token refresh churn / Intuit refresh-token rotation — persist the rotated refresh_token too.
**REVIEW CHECKPOINT 0.2.**

### Task 0.3 — Make idempotency atomic
**Why:** Check-then-write on `UserSync` with no constraint/lock (`automation-helper.ts:248,304,337`) → concurrent runs or a crash between QBO-post and DB-record cause **duplicate journal entries**.
**Files:** `src/db/models/UserSync.ts` (+ migration), `src/utils/automation-helper.ts` (`dailySyncing`).
**Approach:** Add a **unique index** on `UserSync(userId, batchId, donationId)` (migration). Switch to **claim-then-post**: before posting a day, `INSERT ... ON CONFLICT DO NOTHING` (or create inside a txn) a "claim" row; if the claim wins, post to QBO and mark it succeeded (store the JE id); if it loses, skip. Decide a recovery story for a claim that posts then crashes (a `status` column: `pending|posted|failed`, reconciled on next run).
**Test:** Unit/integration: two concurrent `dailySyncing` calls for the same day → exactly one JE attempt. Manual: re-run a synced batch → no duplicate.
**Risk:** Requires a small state machine on `UserSync.status`; keep it minimal.
**REVIEW CHECKPOINT 0.3.**

---

## PHASE 1 — Reliability (P1)

### Task 1.1 — Stop swallowing errors; report truthfully
**Why:** `getallUsers` `catch(e){}` (`automation.ts:111`); `getFundInDonation`/`getBatchInDonation` return `[]` on error (`:135,:167`); `automationScheduler` returns success despite fire-and-forget `users.map(async…)` (`:82`); `finalSyncStripe` outer catch body commented out (`automation-helper.ts:641`).
**Files:** `src/controller/automation.ts`, `src/utils/automation-helper.ts`.
**Approach:** `await Promise.all(users.map(...))`; distinguish transient (throw/surface) from "genuinely empty"; make `automationScheduler`/`latestFundAutomation` return per-user success/failure counts; replace `console.log` in the sync path with structured logging (winston is already a dep) including user/batch/day correlation.
**Test:** Force a PCO error mid-run → run reports the failed user, others still succeed.
**REVIEW CHECKPOINT 1.1.**

### Task 1.2 — Paginate external fetches
**Why:** Batches capped at 50 (`automation.ts:436`), Stripe payouts at 100 (`:537`) — silent data loss on busy days.
**Files:** `src/controller/automation.ts`, `src/controller/stripe.ts`.
**Approach:** Follow PCO `links.next` / `meta` pagination for batches; Stripe `autoPagingEach`/`has_more` for payouts. Bound by the automation date window.
**Test:** Mock >1 page → all pages consumed.
**REVIEW CHECKPOINT 1.2.**

### Task 1.3 — Retry/backoff on 429/5xx
**Files:** new `src/utils/httpRetry.ts`; wrap PCO axios calls + QBO/Stripe SDK calls.
**Approach:** Exponential backoff w/ jitter, capped retries, only on 429/5xx/network; respect `Retry-After`.
**Test:** Unit-test the retry wrapper (429 then 200 → succeeds; permanent 400 → no retry).
**REVIEW CHECKPOINT 1.3.**

### Task 1.4 — `SyncRun` audit record
**Files:** new `src/db/models/SyncRun.ts` (+ migration), wire into the automation entrypoints.
**Approach:** One row per automation invocation: started_at, finished_at, trigger, users_processed, jes_posted, failures (JSON). Lets the scheduler and ops see outcomes.
**Test:** A run creates exactly one `SyncRun` with correct counts.
**REVIEW CHECKPOINT 1.4.**

---

## PHASE 2 — Performance & Maintainability (P2, larger refactor)

### Task 2.1 — Collapse the PCO N+1
**Why:** `getFundInDonation` = 2 PCO calls per donation (`automation.ts:114-138`); `2·batches·donations`.
**Files:** `src/utils/automation-helper.ts`, `src/controller/automation.ts`.
**Approach:** Fetch donations with `?include=designations,designations.fund` (or batch-load funds once per batch) and resolve fund names from the `included` payload — drop `getFundInDonation` from the hot loop.
**Test:** Count external calls before/after on a fixture batch.
**REVIEW CHECKPOINT 2.1.**

### Task 2.2 — One shared sync engine; retire dead paths
**Why:** 3 copies of the enrichment loop (`manualSync` `index.ts:243`, `dailySyncing`, `generateTodayBatches`); legacy Deposit path and dead endpoints (`syncStripePayout`/`syncStripePayoutRegistration`) still routed.
**Files:** new `src/services/syncEngine.ts`; refactor `manualSync`, `dailySyncing`; remove/deprecate dead endpoints in `routers.ts`.
**Approach:** Extract `enrichBatchDonations()` + `postDayJournalEntries()` into one service; `manualSync` and `dailySyncing` both call it (manual gets the fast-path it currently lacks). Confirm nothing else uses the legacy Deposit path before removing.
**Test:** Manual + automated sync produce identical JEs for the same batch.
**Risk:** Largest change — do after P0/P1 are green; keep behavior identical (no accounting change).
**REVIEW CHECKPOINT 2.2.**

### Task 2.3 — Centralize QBO token/client boilerplate
**Files:** `src/utils/quickBookApi.ts` (or new `src/services/qboClient.ts`); refactor the 8+ call sites in `qbo.ts` + `automation.ts`.
**Approach:** `getQboClientForUser(email)` returns a ready authed client (uses Task 0.2 refresh). Replace duplicated token blocks.
**REVIEW CHECKPOINT 2.3.**

---

## PHASE 3 — Frontend UX (P3, parallelizable) — repo: church-sync-pro

### Task 3.1 — Restore sync failure feedback
**Why:** Stripe failure toast commented out (`transaction/index.tsx:440`); API wrappers swallow errors to `[]` (`common/api/stripe.ts:29,78,99`).
**Approach:** Return `{ success, message }` shapes; surface real backend messages; re-enable failure toasts on both batch and Stripe paths.
**REVIEW CHECKPOINT 3.1.**

### Task 3.2 — `finalSyncStripe` partial-failure safety (backend)
**Why:** `return responseError(...)` from inside `.map` callbacks risks double-send / aborts whole payout on one bad fund (`stripe.ts:431-568`).
**Approach:** Collect per-item results; report which funds synced vs failed; one response.
**REVIEW CHECKPOINT 3.2.**

### Task 3.3 — Reference-data freshness
**Why:** 24h TTL on qboData/stripeData (`redux/store.ts:32`), refreshed only on the mapping page → new QBO accounts resolve to empty refs.
**Approach:** Refresh QBO reference data when entering the transaction page (or invalidate on sync); shorten TTL; re-enable `refetch()` after Stripe sync (`StripePayoutTable.tsx:74`).
**REVIEW CHECKPOINT 3.3.**

---

## Acceptance (roadmap-level)
- [ ] Automation endpoints reject unauthenticated calls
- [ ] QBO token refresh is per-user and correct (no singleton dependency)
- [ ] Concurrent/duplicate runs cannot double-post (unique index + claim-then-post)
- [ ] Failures are visible (SyncRun + structured logs); scheduler sees real outcomes
- [ ] No silent data loss (pagination); transient errors retried
- [ ] Manual + automated paths share one engine; PCO N+1 removed
- [ ] Frontend shows real success/failure; reference data fresh
- [ ] No change to JE accounting behavior

## Out of scope
Registration/event income redesign, clearing→bank reconciliation automation, the deferred major library upgrades, and the open client-decision items (Stripe-identification rule, day-grouping timezone) — those are tracked with the JE plan.
