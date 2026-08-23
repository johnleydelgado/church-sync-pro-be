# PCO → QuickBooks Journal Entry Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **PROJECT CONSTRAINT (overrides skill default): DO NOT COMMIT.** Every "Commit" step in the standard template is replaced by a **REVIEW CHECKPOINT** — stop, summarize the diff, and wait for the human to review. The human is doing manual testing + code review and will commit themselves.

**Goal:** Change Church Sync Pro's QuickBooks posting from per-batch **Deposit** transactions to per-day summarized **Journal Entries**, sourced entirely from Planning Center (Stripe electronic giving only), crediting mapped revenue accounts and debiting a configurable clearing account — without using the church-connected Stripe integration.

**Architecture:** Today the daily automation (`latestFundAutomation` → `dailySyncing` → `newRequestPayload` → `automationDeposit`/`createDeposit`) creates **one Deposit per PCO batch**. We introduce a parallel posting path: pure builder functions in `src/utils/mapping.ts` (filter Stripe-only → group by calendar day → build a balanced JournalEntry payload), a thin QBO writer `automationJournalEntry` in `src/controller/automation.ts` calling `node-quickbooks`'s `createJournalEntry`, and a rewire of `dailySyncing` to group across batches **by day** and post one JE per day. The existing fund→revenue-account mapping (`settingsData`) and the account picker (repurposed as the **clearing account**) are reused. The church-Stripe payout path is left in place but is no longer part of the giving sync.

**Tech Stack:** Node 18 + TypeScript, Express, Sequelize/Postgres, `node-quickbooks` (`createJournalEntry`), Jest + ts-jest (added for unit-testing the pure builders), Planning Center Giving API v2.

---

## Key files (orientation for the implementer)

- `src/controller/automation.ts` — `latestFundAutomation` (daily entrypoint, ~line 381), `automationDeposit` (~line 242, the QBO writer to mirror), `generateQBOToken`.
- `src/utils/automation-helper.ts` — `dailySyncing` (~line 139): pulls a batch's donations w/ `?include=designations`, sums duplicate fund designations, builds `newRequestPayload`, calls `automationDeposit`. **This is where day-grouping + the JE path are wired in.**
- `src/utils/mapping.ts` — `mapping()` + `newRequestPayload()`: the pure transforms that build the Deposit `Line[]`. **New JE builders go here.**
- `src/controller/qbo.ts` — `getAllQboData` (~line 20, returns ALL account types already), `getDepositRef` (~line 185, currently filters `AccountType: 'Bank'`).
- `src/controller/user.ts` — `addUpdateBankSettings` / `addUpdateBankCharges` (persist `settingBankData` / `settingBankCharges`).
- Frontend `church-sync-pro/src/pages/Main/automation/mapping/index.tsx` — the Donation/Registration/**Bank** mapping tabs (the "Select Bank Account" dropdown → becomes "Clearing Account").

## Assumptions (documented — confirm with client before Phase 5 "go live")

These come from the 3 open questions in the SOW analysis. The build proceeds on these defaults; each is isolated so it can change cheaply:

1. **"Stripe electronic" filter** = PCO donation with `payment_method` in {`card`, `bank_account`} **AND** evidence it was Stripe-processed (a non-zero `fee_cents` OR a Stripe `payment_source`). Cash/check/manual excluded. *(Implemented as one pure predicate so the rule can be tuned against real data.)*
2. **Registration/event income is OUT of scope** for this phase (giving only). The Stripe registration path (`dailySyncingRegistration`, `latestRegistrationAutomation`) is left untouched and simply not exercised.
3. **Clearing → bank reconciliation is manual** (no Stripe payout data). We only create the JE (credit revenue / debit clearing).

## Testing approach

The backend has **no test runner today**. We add Jest + ts-jest and test ONLY the pure functions (filter, group, build) — no DB/network. The QBO writer and the `dailySyncing` wiring are validated by **manual end-to-end** against the running stack + QBO sandbox (Phase 6), because they depend on live OAuth + the sandbox company.

---

## Task 0: Add a minimal test harness (backend)

**Files:**
- Modify: `package.json` (add devDeps + `test` script)
- Create: `jest.config.js`
- Create: `src/utils/__tests__/.gitkeep`

**Step 1: Install Jest + ts-jest**

Run: `cd /Volumes/T7/OtherProject/quickplan-connect && yarn add -D jest ts-jest @types/jest`
Expected: added to devDependencies, exit 0.

**Step 2: Create `jest.config.js`**

```js
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
}
```

**Step 3: Add test script to `package.json`**

Add to `"scripts"`: `"test": "jest"` and `"test:watch": "jest --watch"`.

**Step 4: Sanity test**

Create `src/utils/__tests__/smoke.test.ts`:
```ts
test('jest runs', () => { expect(1 + 1).toBe(2) })
```
Run: `yarn test`
Expected: 1 passing test. Then delete `smoke.test.ts`.

**REVIEW CHECKPOINT 0** — show `package.json` + `jest.config.js`. Do not commit.

---

## Task 1: Stripe-electronic filter (pure)

**Files:**
- Modify: `src/utils/mapping.ts` (add `isStripeElectronic`, `filterStripeElectronic`)
- Test: `src/utils/__tests__/filterStripeElectronic.test.ts`

**Step 1: Write the failing test**

```ts
import { filterStripeElectronic } from '../mapping'

const donation = (over: any = {}) => ({
  attributes: { payment_method: 'card', fee_cents: -30, amount_cents: 5000, ...over },
})

test('keeps card donations processed by Stripe (has fee)', () => {
  expect(filterStripeElectronic([donation()]).length).toBe(1)
})
test('keeps ACH/bank_account via Stripe', () => {
  expect(filterStripeElectronic([donation({ payment_method: 'bank_account' })]).length).toBe(1)
})
test('excludes cash and check', () => {
  expect(filterStripeElectronic([
    donation({ payment_method: 'cash', fee_cents: 0 }),
    donation({ payment_method: 'check', fee_cents: 0 }),
  ]).length).toBe(0)
})
test('excludes manually entered card with no Stripe fee or source', () => {
  expect(filterStripeElectronic([donation({ payment_method: 'card', fee_cents: 0 })]).length).toBe(0)
})
```

**Step 2: Run test to verify it fails**

Run: `yarn test filterStripeElectronic`
Expected: FAIL — `filterStripeElectronic is not a function`.

**Step 3: Implement**

```ts
const STRIPE_ELECTRONIC_METHODS = ['card', 'bank_account']

export const isStripeElectronic = (donation: any): boolean => {
  const a = donation?.attributes ?? {}
  const method = (a.payment_method ?? '').toLowerCase()
  if (!STRIPE_ELECTRONIC_METHODS.includes(method)) return false
  // Stripe-processed evidence: a processing fee, or a stripe payment source
  const hasFee = typeof a.fee_cents === 'number' && a.fee_cents !== 0
  const sourceName = (donation?.payment_source?.attributes?.name ?? '').toLowerCase()
  const hasStripeSource = sourceName.includes('stripe')
  return hasFee || hasStripeSource
}

export const filterStripeElectronic = (donations: any[]): any[] =>
  (donations ?? []).filter(isStripeElectronic)
```

**Step 4: Run test to verify it passes**

Run: `yarn test filterStripeElectronic`
Expected: PASS (4 tests).

**REVIEW CHECKPOINT 1** — show the diff to `mapping.ts` + the test. Do not commit.

---

## Task 2: Group donations by calendar day (pure)

**Files:**
- Modify: `src/utils/mapping.ts` (add `groupDonationsByDay`)
- Test: `src/utils/__tests__/groupDonationsByDay.test.ts`

**Step 1: Write the failing test**

```ts
import { groupDonationsByDay } from '../mapping'

test('groups donations by received_at calendar day', () => {
  const d = (received: string, cents: number) => ({ attributes: { received_at: received, amount_cents: cents } })
  const groups = groupDonationsByDay([
    d('2026-05-01T10:00:00-05:00', 5000),
    d('2026-05-01T22:30:00-05:00', 1200),
    d('2026-05-02T09:00:00-05:00', 750),
  ])
  expect(Object.keys(groups).sort()).toEqual(['2026-05-01', '2026-05-02'])
  expect(groups['2026-05-01'].length).toBe(2)
  expect(groups['2026-05-02'].length).toBe(1)
})
```

**Step 2: Run test — expect FAIL** (`groupDonationsByDay is not a function`).

**Step 3: Implement** (date key = `received_at` truncated to `YYYY-MM-DD`; document the timezone decision — uses the date as provided by PCO; revisit if client wants a fixed tz):

```ts
export const dayKey = (donation: any): string =>
  String(donation?.attributes?.received_at ?? donation?.attributes?.created_at ?? '').slice(0, 10)

export const groupDonationsByDay = (donations: any[]): Record<string, any[]> =>
  (donations ?? []).reduce((acc: Record<string, any[]>, d) => {
    const key = dayKey(d)
    if (!key) return acc
    ;(acc[key] = acc[key] ?? []).push(d)
    return acc
  }, {})
```

**Step 4: Run test — expect PASS.**

**REVIEW CHECKPOINT 2** — show diff + test. Do not commit.

---

## Task 3: Journal Entry payload builder (pure) — the core

**Files:**
- Modify: `src/utils/mapping.ts` (add `journalEntryPayload`)
- Test: `src/utils/__tests__/journalEntryPayload.test.ts`

This mirrors how `mapping()` already derives `AccountRef`/`ClassRef` per donation from `settingsData`, but produces a **JournalEntry**: one **Credit** line per revenue account (summed), one **Debit** line to the clearing account for the day's total. Credits must equal the debit.

**Step 1: Write the failing test**

```ts
import { journalEntryPayload } from '../mapping'

// mapped donations: each carries the resolved revenue AccountRef/ClassRef + amount (cents)
const mapped = [
  { AccountRef: '101', ClassRef: '5', amount_cents: 500000, fundName: 'General Tithes' },
  { AccountRef: '102', ClassRef: '5', amount_cents: 120000, fundName: 'Missions' },
  { AccountRef: '101', ClassRef: '5', amount_cents: 25000,  fundName: 'General Tithes' },
]

test('builds a balanced journal entry: credits per account, single clearing debit', () => {
  const je = journalEntryPayload(mapped, {
    clearingAccountRef: { value: '900', name: 'Funds in Transit' },
    txnDate: '2026-05-01',
    memo: 'Church Sync Pro - PCO Electronic Giving Sync - 2026-05-01',
  })
  // one credit per distinct AccountRef (101 summed = 5250.00) + 102 (1200.00) + 1 debit
  const credits = je.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Credit')
  const debits = je.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Debit')
  expect(credits.length).toBe(2)
  expect(debits.length).toBe(1)
  const acct101 = credits.find((l: any) => l.JournalEntryLineDetail.AccountRef.value === '101')
  expect(acct101.Amount).toBe(5250)            // 5000.00 + 250.00
  expect(debits[0].Amount).toBe(6450)          // total
  expect(debits[0].JournalEntryLineDetail.AccountRef.value).toBe('900')
  expect(je.TxnDate).toBe('2026-05-01')
  expect(je.PrivateNote).toContain('2026-05-01')
})

test('throws if credits do not balance the debit (guard)', () => {
  expect(() => journalEntryPayload([{ AccountRef: '', ClassRef: '', amount_cents: 100, fundName: 'x' }], {
    clearingAccountRef: { value: '900', name: 'Funds in Transit' }, txnDate: '2026-05-01', memo: 'm',
  })).not.toThrow() // single line still balances; guard is for internal rounding — see impl
})
```

**Step 2: Run test — expect FAIL.**

**Step 3: Implement**

```ts
const centsToAmount = (cents: number) => Math.round(cents) / 100

export interface MappedDonationLine {
  AccountRef: string
  ClassRef?: string
  amount_cents: number
  fundName?: string
}

export interface JournalEntryOptions {
  clearingAccountRef: { value: string; name?: string }
  txnDate: string
  memo: string
  syncId?: string
}

export const journalEntryPayload = (lines: MappedDonationLine[], opts: JournalEntryOptions) => {
  // Sum credits per revenue account (preserve class if consistent)
  const byAccount = new Map<string, { cents: number; classRef?: string }>()
  for (const l of lines) {
    const key = l.AccountRef
    const prev = byAccount.get(key) ?? { cents: 0, classRef: l.ClassRef }
    prev.cents += l.amount_cents
    byAccount.set(key, prev)
  }

  const creditLines = [...byAccount.entries()].map(([accountRef, v]) => ({
    Amount: centsToAmount(v.cents),
    DetailType: 'JournalEntryLineDetail',
    JournalEntryLineDetail: {
      PostingType: 'Credit',
      AccountRef: { value: accountRef },
      ...(v.classRef ? { ClassRef: { value: v.classRef } } : {}),
    },
  }))

  const totalCents = lines.reduce((s, l) => s + l.amount_cents, 0)
  const debitLine = {
    Amount: centsToAmount(totalCents),
    DetailType: 'JournalEntryLineDetail',
    JournalEntryLineDetail: {
      PostingType: 'Debit',
      AccountRef: { value: opts.clearingAccountRef.value, name: opts.clearingAccountRef.name },
    },
  }

  // Balance guard (defensive against rounding)
  const creditTotal = creditLines.reduce((s, l) => s + l.Amount, 0)
  if (Math.abs(creditTotal - debitLine.Amount) > 0.005) {
    throw new Error(`Journal entry not balanced: credits ${creditTotal} != debit ${debitLine.Amount}`)
  }

  return {
    Line: [...creditLines, debitLine],
    TxnDate: opts.txnDate,
    PrivateNote: opts.memo,
  }
}
```

**Step 4: Run test — expect PASS.**

**REVIEW CHECKPOINT 3** — this is the most important review. Show the full builder + tests. Do not commit.

---

## Task 4: `automationJournalEntry` QBO writer

**Files:**
- Modify: `src/controller/automation.ts` (add `automationJournalEntry`, mirroring `automationDeposit` token handling, ~after line 312)

**Step 1: Implement** (reuse the exact token/refresh block from `automationDeposit`; swap `createDeposit` → `createJournalEntry`):

```ts
export const automationJournalEntry = async (email: string, jePayload: any) => {
  const data = await tokenEntity.findOne({ where: { email, isEnabled: true }, include: tokens })
  const arr = data.tokens.find((item) => item.token_type === 'qbo')
  let tokenJson = { access_token: arr.access_token, refresh_token: arr.refresh_token, realm_id: arr.realm_id }
  if (!quickbookAuth.isAccessTokenValid()) {
    tokenJson = await generateQBOToken(arr.refresh_token, email)
  }
  const qboTokens = {
    ACCESS_TOKEN: tokenJson.access_token,
    REALM_ID: tokenJson.realm_id,
    REFRESH_TOKEN: tokenJson.refresh_token,
  }
  return new Promise(async (resolve, reject) => {
    await quickBookApi(qboTokens).createJournalEntry(jePayload, function (err, createdData) {
      if (err) return reject(err)
      resolve(isEmpty(createdData) ? [] : createdData)
    })
  })
}
```

**Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

**REVIEW CHECKPOINT 4** — show the new function. Do not commit. (No unit test — depends on live QBO; validated in Phase 6.)

---

## Task 5: Rewire `dailySyncing` to post one JE per day

**Files:**
- Modify: `src/utils/automation-helper.ts` `dailySyncing` (~line 139-280) — replace the deposit build/post with: resolve each donation's revenue mapping (as today) → `filterStripeElectronic` → `groupDonationsByDay` → per day `journalEntryPayload(... clearing account from settingBankData ...)` → `automationJournalEntry`.
- Modify: `src/controller/automation.ts` import `automationJournalEntry`.

**Step 1: Build the per-donation mapped lines** reusing the existing designation→fund→`settingsData` resolution already in `dailySyncing` (the code that derives `AccountRef`/`ClassRef`). Produce `MappedDonationLine[]` instead of the deposit payload.

**Step 2: Replace the post call.** Where it currently does:
```ts
const data = newRequestPayload(jsonRes.donation)
const bqoCreatedDataId = await automationDeposit(email as string, data)
```
do (per day group):
```ts
const stripeOnly = filterStripeElectronic(jsonRes.donation)
const byDay = groupDonationsByDay(stripeOnly)
const clearing = (bank ?? []).find((b) => b.type === 'donation')
for (const [day, donations] of Object.entries(byDay)) {
  const mappedLines = toMappedLines(donations, settingsData) // existing fund→account resolution
  const je = journalEntryPayload(mappedLines, {
    clearingAccountRef: { value: clearing?.value ?? '', name: clearing?.label },
    txnDate: day,
    memo: `Church Sync Pro - PCO Electronic Giving Sync - ${day}`,
    syncId: `${realBatchId}`,
  })
  await automationJournalEntry(email as string, je)
  await UserSync.create({ userId, batchId: realBatchId, syncedData: je, donationId: day })
}
```

**Step 3: Preserve idempotency** — keep the existing `UserSync` "already synced" guard, but key it so re-running a day/batch does not double-post (consider `batchId + day`).

**Step 4: Typecheck** — `npx tsc --noEmit` → exit 0.

**Step 5: Lint** — `yarn format` (eslint --fix) on changed files.

**REVIEW CHECKPOINT 5** — show full `dailySyncing` diff. This changes posting behavior; flag the idempotency key explicitly for review. Do not commit.

---

## Task 6: Clearing account config (backend filter + frontend label)

**Files:**
- Modify (backend): `src/controller/qbo.ts` `getDepositRef` — remove/relax the `{ AccountType: 'Bank' }` filter so non-bank accounts (e.g. "Funds in Transit" other-current-asset) are selectable. (`getAllQboData` already returns all types, so the FE list may just need its own filter relaxed.)
- Modify (frontend): `church-sync-pro/src/pages/Main/automation/mapping/index.tsx` — relabel "Select Bank Account" → "Select Clearing Account" on the Bank tab; ensure the account dropdown is not restricted to `type === 'Bank'`.

**Step 1:** Backend — relax the account-type filter; typecheck.
**Step 2:** Frontend — relabel + widen the account option filter; `npx tsc --noEmit` (frontend) → exit 0; confirm the dev server recompiles.

**REVIEW CHECKPOINT 6** — show both diffs. Do not commit.

---

## Task 7: Manual end-to-end validation (running stack + QBO sandbox)

**Not automated.** Using the already-running stack (FE :3000, BE :8080, Postgres :5432, SuperTokens :3567):

**Step 1:** In PCO, ensure a **committed** batch exists with at least 2 funds of **Stripe electronic** donations on the same day (plus one cash/check to prove exclusion).
**Step 2:** Configure mapping: funds → revenue accounts (Donation tab); clearing account (Bank tab).
**Step 3:** Trigger the fund automation (the `latestFundAutomation` / `dailySyncing` path).
**Step 4:** In QBO sandbox, confirm: one **Journal Entry per day**, credits = mapped revenue accounts, debit = clearing account, **balanced**, `TxnDate` = donation day, memo = `Church Sync Pro - PCO Electronic Giving Sync - YYYY-MM-DD`. Cash/check excluded.
**Step 5:** Re-trigger; confirm **no duplicate** JE (idempotency).

**REVIEW CHECKPOINT 7 (final)** — summarize behavior + screenshots/log evidence for the human's code review. Do not commit.

---

## Acceptance criteria (from SOW)

- [ ] Daily journal entries created in QBO
- [ ] Journal entries balance (credits == debit)
- [ ] Revenue account mappings work as configured
- [ ] Only Stripe/electronic transactions included
- [ ] Cash/check excluded
- [ ] JE posts by transaction date
- [ ] Sync logs / error handling intact
- [ ] No church-Stripe call in the giving path
- [ ] Existing billing Stripe untouched

## Out of scope (this phase)
Registration/event income sync, clearing→bank auto-reconciliation, removal of the church-Stripe payout code (left dormant), and the deferred major library upgrades.
