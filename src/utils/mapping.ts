/* eslint-disable @typescript-eslint/no-explicit-any */
interface MappingPcToQboProps {
  donationAmount: string;
  batchName: string;
  batchCreated: string;
  batchTotalAmount: string;
  AccountRef: string;
  ReceivedFrom: string;
  ClassRef: string;
  CheckNum: string;
  tempPaymentMethod?: string;
  bankRef: {
    value: string;
    label: string;
  };
  TxnDate: string;
}

export interface CustomerProps {
  firstName: string;
  middleName: string;
  lastName: string;
  projectName: string;
  projectDisplayName: string;
  email: string;
  phoneno: string;
  mobileno: string;
  fax: string;
  other: string;
  nameToPrintOnChecks: string;
  parentRef: string;
  billWithParent?: boolean;
  webAdd?: string;
  active?: boolean;
  Id?: number;
  syncToken?: string;
}

interface MappingCustomerProps {
  GivenName: string;
  MiddleName: string;
  FamilyName: string;
  FullyQualifiedName: string;
  DisplayName: string;
  PrimaryEmailAddr: {
    Address: string;
  };
  PrimaryPhone: {
    FreeFormNumber: string;
  };
  AlternatePhone: {
    FreeFormNumber: string;
  };
  Mobile: {
    FreeFormNumber: string;
  };
  PrintOnCheckName: string;
  ParentRef?: {
    value: string;
  };
  BillWithParent?: boolean;
  Job?: boolean;
  CompanyName: string;
  WebAddr?: {
    URI: string;
  };
  Notes?: string;
  Active?: boolean;
  Id?: number;
  SyncToken?: string;
}

interface MappingCustomerProps {}

export interface SettingsJsonProps {
  fundName: string;
  account: { value: string; label: string };
  class: { value: string; label: string };
  customer: { value: string; label: string };
}

const numberWithToFix = (number: number) => {
  if (number) {
    const num = (number / 100).toFixed(2);
    return num as string;
  }
  return '';
};

const mapping = (data: any[]): MappingPcToQboProps[] => {
  const tempData: MappingPcToQboProps[] = [];
  data.map((item: any) => {
    tempData.push({
      tempPaymentMethod:
        item.attributes.payment_method === 'card' ? item.attributes.payment_brand : item.attributes.payment_method,
      donationAmount: numberWithToFix(item.attributes.amount_cents),
      batchName: item.batch.attributes.description || '',
      batchCreated: item.batch.attributes.created_at || '',
      batchTotalAmount: numberWithToFix(item.batch?.attributes?.total_cents || 0),
      AccountRef: item.accountRef,
      ReceivedFrom: item.receivedFrom,
      ClassRef: item.classRef,
      CheckNum: item.attributes.payment_method === 'card' ? '' : item.paymentCheck,
      bankRef: { value: item.bankRef.value || '', label: item.bankRef.label || '' },
      TxnDate: item.TxnDate,
    });
  });

  return tempData;
};

const requestPayload = (data: any[]) => {
  const mappingPayload = mapping(data);
  const finalData = mappingPayload.map((item) => {
    return {
      // TxnDate: item.batchCreated,
      // TotalAmt: item.batchTotalAmount,
      tempPaymentMethod: item.tempPaymentMethod,
      Line: [
        {
          Amount: item.donationAmount,
          DetailType: 'DepositLineDetail',
          DepositLineDetail: {
            AccountRef: {
              value: item.AccountRef,
            },
            Entity: {
              value: item.ReceivedFrom ?? '',
            },
            //   PaymentMethodRef: {
            //     value: '{newPaymentMethodID}',
            //   },
            ClassRef: {
              value: item.ClassRef,
            },
            CheckNum: item.CheckNum,
          },
          Description: item.batchName,
        },
      ],
      DepositToAccountRef: {
        name: item.bankRef.label,
        value: item.bankRef.value,
      },
    };
  });
  return finalData;
};

const newRequestPayload = (data: any[]) => {
  const mappingPayload = mapping(data);
  const lines = mappingPayload.map((item) => ({
    tempPaymentMethod: item.tempPaymentMethod,
    Amount: item.donationAmount,
    DetailType: 'DepositLineDetail',
    DepositLineDetail: {
      ...(item.AccountRef && {
        AccountRef: {
          value: item.AccountRef,
        },
      }),
      Entity: {
        value: item.ReceivedFrom ?? '',
      },
      // PaymentMethodRef: {
      //   value: '{newPaymentMethodID}',
      // },
      ClassRef: {
        value: item.ClassRef,
      },
      CheckNum: item.CheckNum,
    },
    Description: item.batchName,
  }));

  const finalData = {
    Line: lines,
    TxnDate: mappingPayload[0]?.TxnDate,
    DepositToAccountRef: {
      name: mappingPayload[0]?.bankRef.label,
      value: mappingPayload[0]?.bankRef.value,
    },
  };
  return finalData;
};

const projectPayload = (data: CustomerProps): MappingCustomerProps => {
  return {
    AlternatePhone: { FreeFormNumber: data.phoneno || '' },
    DisplayName: data.projectName || '',
    FamilyName: data.lastName || '',
    FullyQualifiedName: data.projectDisplayName || '',
    GivenName: data.firstName || '',
    MiddleName: data.middleName || '',
    Mobile: { FreeFormNumber: data.mobileno || '' },
    PrimaryEmailAddr: { Address: data.email || '' },
    PrimaryPhone: { FreeFormNumber: data.phoneno || '' },
    PrintOnCheckName: data.nameToPrintOnChecks || '',
    BillWithParent: data.billWithParent || false,
    ParentRef: { value: data.parentRef || '' },
    Job: data.parentRef ? true : false,
    CompanyName: data.projectName || '',
    WebAddr: { URI: data.webAdd ? 'https://' + data.webAdd : '' },
    Notes: data.other || '',
    ...('active' in data && { Active: data.active ? true : false }),
    ...((data.Id || data.Id === 0) && { Id: data.Id }),
    SyncToken: data.syncToken,
  };
};

// Planning Center's Giving API returns exactly four payment_method values:
// 'cash', 'check', 'card' and 'ach'. Only the last two are processed by Stripe.
// 'bank_account' is not a value PCO emits; it is kept as a defensive alias only.
const STRIPE_ELECTRONIC_METHODS = ['card', 'ach', 'bank_account'];

const stripeElectronic = (donation: any, opts: { allowRefunded?: boolean } = {}): boolean => {
  const a = donation?.attributes ?? {};
  const method = (a.payment_method ?? '').toLowerCase();
  if (!STRIPE_ELECTRONIC_METHODS.includes(method)) return false;
  if (!opts.allowRefunded && a.refunded === true) return false;
  // Only *completed* giving belongs in a journal entry. A pending or failed card
  // payment would otherwise be recognised as income and debited to the clearing
  // account, where it can never clear because the money never arrives.
  // Donations with no payment_status are treated as complete: PCO omits the field
  // on some records, and dropping those would under-report real income.
  const status = (a.payment_status ?? '').toLowerCase();
  if (status && status !== 'succeeded') return false;
  // fee_cents may arrive as a string from PCO; coerce before comparing.
  const fee = Number(a.fee_cents);
  const hasFee = !Number.isNaN(fee) && fee !== 0;
  const sourceName = (donation?.payment_source?.attributes?.name ?? '').toLowerCase();
  const hasStripeSource = sourceName.includes('stripe');
  return hasFee || hasStripeSource;
};

/** Giving that belongs in the day's journal entry. */
export const isStripeElectronic = (donation: any): boolean => stripeElectronic(donation);

/**
 * The same test, ignoring the refund flag: money this engine WOULD have posted before it
 * was refunded. The refund pass used to select on `refunded === true` alone, so a refunded
 * cash or cheque gift - which no journal entry ever recorded - got a reversing entry against
 * the Stripe clearing account, driving it negative against a payout that never included it.
 */
export const wasStripeElectronic = (donation: any): boolean => stripeElectronic(donation, { allowRefunded: true });

export const filterStripeElectronic = (donations: any[]): any[] => (donations ?? []).filter(isStripeElectronic);

/**
 * The calendar day a donation belongs to, in the CHURCH's timezone.
 *
 * PCO stores `received_at` in UTC. Slicing the ISO string directly puts an
 * 8pm gift in New York (00:00Z the next day) onto the following day's entry -
 * which is exactly the Planning Center / QuickBooks mismatch this product
 * exists to remove. The church's timezone comes from `GET /giving/v2`
 * (`attributes.time_zone`), so no per-church configuration is needed.
 *
 * With no timeZone supplied, falls back to the raw UTC date so existing
 * callers keep working rather than silently dropping donations.
 */
export const dayKey = (donation: any, timeZone?: string | null): string => {
  const raw = String(donation?.attributes?.received_at ?? donation?.attributes?.created_at ?? '');
  if (!raw) return '';
  if (!timeZone) return raw.slice(0, 10);

  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return raw.slice(0, 10);

  try {
    // en-CA formats as YYYY-MM-DD, which is the shape the rest of the pipeline expects.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    // An unrecognised timezone must not take the whole sync down.
    return raw.slice(0, 10);
  }
};

export const groupDonationsByDay = (donations: any[], timeZone?: string | null): Record<string, any[]> =>
  (donations ?? []).reduce((acc: Record<string, any[]>, d) => {
    const key = dayKey(d, timeZone);
    if (!key) return acc;
    (acc[key] = acc[key] ?? []).push(d);
    return acc;
  }, {});

const centsToAmount = (cents: number) => Math.round(cents) / 100;

export interface MappedDonationLine {
  AccountRef: string;
  ClassRef?: string;
  amount_cents: number;
  fundName?: string;
}

/**
 * The day's Stripe fee.
 *
 * Every fee counts, including gifts marked `fee_covered`. That is worth explaining, because the
 * opposite looks reasonable at first glance and was briefly implemented here.
 *
 * When a donor "covers the fee", Planning Center bumps the charge - a $200.00 gift becomes a
 * $204.70 charge - and records the donation at the GROSS $204.70, which is also what appears on
 * the donor's receipt and giving statement. The donor did not pay Stripe on the church's behalf;
 * they simply made a larger gift. The church remains the merchant of record and incurs the whole
 * $4.70. So the ordinary arithmetic is already correct:
 *
 *     credit revenue   $204.70     the gift, as the donor's statement shows it
 *     debit  fees        $4.70     what Stripe took
 *     debit  clearing  $200.00     what Stripe deposits - what the donor meant the church to get
 *
 * Excluding covered fees would credit $204.70 and debit $204.70 to clearing, leaving it
 * overstated by the fee against a deposit that will only ever be $200.00 - the exact
 * reconciliation break the split exists to prevent. It would also net a processing fee against
 * contribution revenue, which GAAP does not permit and which understates both figures on the
 * church's return.
 *
 * Planning Center says as much itself: "A donation where the donor covers the fee means it's a
 * slightly more generous donation. So, the donation is not represented differently in your payout
 * reports, and there's no change in your bookkeeping process." Their own worked example is a
 * proof by contradiction: a $100 gift with a 30c covered ACH fee produces a year-end tax
 * statement reading "$100.30 to that missions organization" while only $100 arrives - which is
 * only possible if the recorded amount is the gross.
 *
 * `fee_covered` therefore changes nothing about the entry. It remains useful for one thing:
 * Planning Center documents that it can only be true for donations processed through Stripe, so
 * it is the single field that positively proves Stripe handled a gift.
 *
 * Returns a negative number, matching PCO's own sign convention for `fee_cents`.
 */
export const chargeableFeeCents = (donations: any[]): number =>
  (donations ?? []).reduce((sum, donation) => sum + (Number(donation?.attributes?.fee_cents) || 0), 0);

export interface DesignationInfo {
  fundName?: string;
  amountCents: number;
}

/**
 * Build the journal-entry lines for a single donation.
 *
 * A gift can be split across funds. Planning Center models that as several
 * designations, and the donation's own `amount_cents` is documented as "the total of
 * all of a donation's associated designation's `amount_cents` values". Reading only
 * the first designation and pairing it with that total credits the whole gift to one
 * fund - a $100 gift split $60 General / $40 Missions posted $100 to General and
 * nothing to Missions, with the books still balancing so nothing looked wrong.
 *
 * Falls back to one line at the donation total when the designations cannot be
 * resolved or do not add up to it (a partial PCO payload). Posting the whole gift
 * against its resolved fund is wrong in the same way as before, but it is better than
 * understating the day's revenue, which is what trusting an incomplete split would do.
 */
export const donationLines = (
  donation: any,
  designations: Record<string, DesignationInfo>,
  settingsData: SettingsJsonProps[],
  fallbackFundName?: string,
): MappedDonationLine[] => {
  const lineFor = (fundName: string | undefined, amountCents: number): MappedDonationLine => {
    const settingsItem = (settingsData ?? []).find((item) => item.fundName === fundName);
    return {
      AccountRef: settingsItem?.account?.value ?? '',
      ClassRef: settingsItem?.class?.value || undefined,
      amount_cents: amountCents,
      fundName: fundName ?? '',
    };
  };

  const total = Number(donation?.attributes?.amount_cents) || 0;
  const refs = (donation?.relationships?.designations?.data ?? []) as { id: string }[];
  const resolved = refs
    .map((r) => designations?.[r?.id])
    .filter((d): d is DesignationInfo => !!d && Number.isFinite(Number(d.amountCents)));
  const resolvedTotal = resolved.reduce((sum, d) => sum + Number(d.amountCents), 0);

  // Only split the gift when EVERY share can be posted. The caller drops lines with a blank
  // AccountRef, so splitting a gift whose second fund is unmapped posts part of its value
  // while the whole donation's fee is still charged - revenue understated and the clearing
  // account permanently short of what Stripe deposits. One line at the donation total is
  // wrong about which fund, but it keeps the day reconcilable, which is the product's job.
  const everyShareMapped =
    resolved.length > 0 &&
    resolved.every((d) => (settingsData ?? []).some((item) => item.fundName === (d.fundName ?? fallbackFundName)));

  if (resolved.length > 0 && resolvedTotal === total && everyShareMapped) {
    return resolved.map((d) => lineFor(d.fundName ?? fallbackFundName, Number(d.amountCents)));
  }

  // Fall back to the first share whose fund IS mapped, so a partly-unmapped split still
  // posts its full value rather than vanishing; if none is mapped the blank AccountRef
  // below drops the whole donation, exactly as before this helper existed.
  const mappedFallback =
    resolved.find((d) => (settingsData ?? []).some((item) => item.fundName === d.fundName))?.fundName ??
    fallbackFundName ??
    // Nothing is mapped: keep a fund name anyway so the caller's "skipped unmapped-fund"
    // warning names the fund the church still has to map, rather than an empty string.
    resolved[0]?.fundName;
  return [lineFor(mappedFallback, total)];
};

/** Shown when the sweep's `included[]` does not carry the designation's fund. */
const UNRESOLVED_FUND_NAME = 'Unknown fund';

export interface DonationDesignationDetail {
  fundName: string;
  amount: number;
}

export interface DonationDetail {
  id: string;
  receivedAt: string;
  completedAt: string | null;
  gross: number;
  fee: number;
  net: number;
  paymentMethod: string;
  paymentMethodSub: string | null;
  paymentStatus: string;
  feeCovered: boolean;
  designations: DonationDesignationDetail[];
}

export interface StripeGivingDayDetail {
  donations: DonationDetail[];
  totals: { gross: number; fees: number; net: number; count: number };
}

/**
 * One day's Stripe giving, gift by gift, for a church to read.
 *
 * Selection and fee arithmetic are the journal entry's - `filterStripeElectronic`, then
 * `chargeableFeeCents` - so these rows always add up to the day total shown above them and to
 * the entry that gets posted. Reaching for anything looser here (every donation, or fees summed
 * per row) would hand a bookkeeper two figures for the same day that disagree by design.
 *
 * Amounts come out in DOLLARS with fees POSITIVE, which is neither PCO's convention (cents,
 * fees negative) nor the ledger's. It is what the table renders, and converting once here keeps
 * the sign flip out of every caller.
 */
export const stripeGivingDayDetail = (donations: any[], included: any[]): StripeGivingDayDetail => {
  const fundNames = new Map<string, string>();
  const designations = new Map<string, { fundId?: string; amountCents: number }>();
  for (const item of included ?? []) {
    if (item?.type === 'Fund') fundNames.set(String(item.id), String(item.attributes?.name ?? ''));
    if (item?.type === 'Designation') {
      const fundId = item.relationships?.fund?.data?.id;
      designations.set(String(item.id), {
        fundId: fundId ? String(fundId) : undefined,
        amountCents: Number(item.attributes?.amount_cents) || 0,
      });
    }
  }

  const eligible = filterStripeElectronic(donations);

  const rows: DonationDetail[] = eligible.map((d: any) => {
    const a = d?.attributes ?? {};
    const grossCents = Number(a.amount_cents) || 0;
    // chargeableFeeCents keeps PCO's negative sign; a reader wants the fee as a cost.
    const feeCents = Math.abs(chargeableFeeCents([d]));

    const refs = (d?.relationships?.designations?.data ?? []) as { id: string }[];
    const split = refs
      .map((r) => designations.get(String(r?.id)))
      .filter((x): x is { fundId?: string; amountCents: number } => !!x)
      .map((x) => ({
        fundName: (x.fundId ? fundNames.get(x.fundId) : '') || UNRESOLVED_FUND_NAME,
        amount: centsToAmount(x.amountCents),
      }));

    return {
      id: String(d?.id ?? ''),
      receivedAt: String(a.received_at ?? ''),
      completedAt: a.completed_at ?? null,
      gross: centsToAmount(grossCents),
      fee: centsToAmount(feeCents),
      net: centsToAmount(grossCents - feeCents),
      paymentMethod: String(a.payment_method ?? ''),
      paymentMethodSub: a.payment_method_sub ?? null,
      paymentStatus: String(a.payment_status ?? ''),
      feeCovered: a.fee_covered === true,
      // A gift whose designations did not side-load still has to account for its whole value,
      // or the breakdown quietly sums to less than the gift it sits under.
      designations: split.length ? split : [{ fundName: UNRESOLVED_FUND_NAME, amount: centsToAmount(grossCents) }],
    };
  });

  // Summed in cents, then converted once - adding the rounded dollar figures drifts.
  const grossCents = eligible.reduce((s, d: any) => s + (Number(d?.attributes?.amount_cents) || 0), 0);
  const feeCents = Math.abs(chargeableFeeCents(eligible));

  return {
    donations: rows,
    totals: {
      gross: centsToAmount(grossCents),
      fees: centsToAmount(feeCents),
      net: centsToAmount(grossCents - feeCents),
      count: rows.length,
    },
  };
};

export interface JournalEntryOptions {
  clearingAccountRef: { value: string; name?: string };
  txnDate: string;
  memo: string;
  syncId?: string;
  // Stripe processing fees: account to debit the total fee to. When provided (with a value) and
  // there are fees, the clearing account is debited for the NET (gross - fees) instead of gross.
  feesAccountRef?: { value: string; name?: string; classRef?: string };
  // Total Stripe fee for the day in cents. PCO `fee_cents` is typically NEGATIVE; the magnitude
  // (Math.abs) is used as the fee amount.
  totalFeeCents?: number;
  /** The "Journal no." a bookkeeper cites. See `journalDocNumber`. */
  docNumber?: string;
}

/**
 * The document number QuickBooks shows as "Journal no.".
 *
 * Left unset, QuickBooks leaves the field blank and the entry can only be referred to by its
 * internal id, which is invisible in most reports - so a bookkeeper querying "which entry is
 * this?" has nothing to quote. This gives every entry a name that says what it is on sight:
 *
 *   CSP-2026-09-08-1     first entry for that day's giving
 *   CSP-2026-09-08-2     a later top-up for the same day
 *   CSP-R-2026-09-08-1   a refund reversal dated that day
 *
 * The sequence comes from the day's ledger `entryCount`, so it stays unique across giving and
 * refunds on the same day. QuickBooks caps DocNumber at 21 characters; the longest this
 * produces is 19 (`CSP-R-2026-09-08-99`), and it is truncated defensively regardless.
 */
export const journalDocNumber = (day: string, sequence: number, kind: 'giving' | 'refund' = 'giving'): string =>
  `CSP-${kind === 'refund' ? 'R-' : ''}${day}-${sequence}`.slice(0, 21);

/**
 * Reversing entry for refunds processed on one day. Mirrors journalEntryPayload:
 * the original credited revenue and debited fees + clearing, so a refund debits
 * revenue and credits clearing for the money going back out. Stripe keeps its fee
 * on most refunds; when PCO reports a returned fee (`fee_cents` on the Refund) it
 * is credited back to the fees account and the clearing credit shrinks to match.
 *
 * Posted on the refund date - the client's decision - so the day's entries are an
 * honest audit trail of what happened when, rather than a rewritten original.
 */
export const refundJournalEntryPayload = (
  lines: MappedDonationLine[],
  opts: JournalEntryOptions,
) => {
  const byAccount = new Map<string, { cents: number; classRef?: string }>();
  for (const l of lines) {
    const prev = byAccount.get(l.AccountRef) ?? { cents: 0, classRef: l.ClassRef };
    prev.cents += l.amount_cents;
    byAccount.set(l.AccountRef, prev);
  }
  const debitLines = [...byAccount.entries()].map(([accountRef, v]) => ({
    Amount: centsToAmount(v.cents),
    DetailType: 'JournalEntryLineDetail',
    JournalEntryLineDetail: {
      PostingType: 'Debit',
      AccountRef: { value: accountRef },
      ...(v.classRef ? { ClassRef: { value: v.classRef } } : {}),
    },
  }));
  if (debitLines.length === 0) throw new Error('Cannot build refund entry: no refund lines');

  const grossAmount = debitLines.reduce((s, l) => s + l.Amount, 0);
  if (!Number.isFinite(grossAmount) || grossAmount <= 0) {
    throw new Error(`Invalid refund entry total: ${grossAmount}`);
  }

  const feeReturned = centsToAmount(Math.abs(opts.totalFeeCents ?? 0));
  const returnFee = feeReturned > 0 && !!opts.feesAccountRef?.value;
  if (returnFee && feeReturned > grossAmount) {
    throw new Error(`Returned fee ${feeReturned} exceeds refund ${grossAmount}`);
  }
  const clearingAmount = grossAmount - (returnFee ? feeReturned : 0);

  const creditLines = [
    ...(returnFee
      ? [{
          Amount: feeReturned,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: {
            PostingType: 'Credit',
            AccountRef: { value: opts.feesAccountRef!.value, name: opts.feesAccountRef!.name },
            ...(opts.feesAccountRef!.classRef ? { ClassRef: { value: opts.feesAccountRef!.classRef } } : {}),
          },
        }]
      : []),
    {
      Amount: clearingAmount,
      DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: {
        PostingType: 'Credit',
        AccountRef: { value: opts.clearingAccountRef.value, name: opts.clearingAccountRef.name },
      },
    },
  ];

  const creditTotal = creditLines.reduce((s, l) => s + l.Amount, 0);
  if (Math.abs(grossAmount - creditTotal) > 0.005) {
    throw new Error(`Refund entry imbalance: debits ${grossAmount} != credits ${creditTotal}`);
  }

  return {
    Line: [...debitLines, ...creditLines],
    TxnDate: opts.txnDate,
    ...(opts.docNumber ? { DocNumber: opts.docNumber } : {}),
    PrivateNote: opts.syncId ? `${opts.memo} | ${opts.syncId}` : opts.memo,
  };
};

export const journalEntryPayload = (lines: MappedDonationLine[], opts: JournalEntryOptions) => {
  const byAccount = new Map<string, { cents: number; classRef?: string }>();
  for (const l of lines) {
    const prev = byAccount.get(l.AccountRef) ?? { cents: 0, classRef: l.ClassRef };
    prev.cents += l.amount_cents;
    byAccount.set(l.AccountRef, prev);
  }

  const creditLines = [...byAccount.entries()].map(([accountRef, v]) => ({
    Amount: centsToAmount(v.cents),
    DetailType: 'JournalEntryLineDetail',
    JournalEntryLineDetail: {
      PostingType: 'Credit',
      AccountRef: { value: accountRef },
      ...(v.classRef ? { ClassRef: { value: v.classRef } } : {}),
    },
  }));

  if (creditLines.length === 0) throw new Error('Cannot build journal entry: no donation lines');

  const totalCents = lines.reduce((s, l) => s + l.amount_cents, 0);
  const creditTotal = creditLines.reduce((s, l) => s + l.Amount, 0);
  const rawTotal = centsToAmount(totalCents);
  // Reject malformed (NaN, from a non-numeric amount_cents) or empty ($0) totals before posting.
  if (!Number.isFinite(creditTotal) || creditTotal === 0) {
    throw new Error(`Invalid journal entry total: ${creditTotal}`);
  }
  // Defensive: detect fractional-cent corruption in the input (amount_cents should be whole cents).
  if (Math.abs(rawTotal - creditTotal) > 0.005) {
    throw new Error(`Journal entry rounding mismatch: raw total ${rawTotal} != credit total ${creditTotal}`);
  }

  const grossAmount = creditTotal;
  // PCO fee_cents is typically negative; the fee magnitude is what we debit.
  const feeAmount = centsToAmount(Math.abs(opts.totalFeeCents ?? 0));
  // Only split out fees when both a fee exists AND a fees account is configured. Otherwise stay
  // backward-compatible: debit the clearing account for the full gross with no fee line.
  const splitFees = feeAmount > 0 && !!opts.feesAccountRef?.value;

  if (splitFees && feeAmount > grossAmount) {
    throw new Error(`Fees ${feeAmount} exceed gross ${grossAmount}`);
  }

  const clearingAmount = grossAmount - (splitFees ? feeAmount : 0);
  // Guard: clearing debit must never go negative.
  if (clearingAmount < 0) {
    throw new Error(`Fees ${feeAmount} exceed gross ${grossAmount}`);
  }

  const feesLine = splitFees
    ? {
        Amount: feeAmount,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: {
          PostingType: 'Debit',
          AccountRef: { value: opts.feesAccountRef!.value, name: opts.feesAccountRef!.name },
          ...(opts.feesAccountRef!.classRef ? { ClassRef: { value: opts.feesAccountRef!.classRef } } : {}),
        },
      }
    : null;

  const clearingLine = {
    Amount: clearingAmount, // gross when fees are not split, NET when they are
    DetailType: 'JournalEntryLineDetail',
    JournalEntryLineDetail: {
      PostingType: 'Debit',
      AccountRef: { value: opts.clearingAccountRef.value, name: opts.clearingAccountRef.name },
    },
  };

  const debitLines = feesLine ? [feesLine, clearingLine] : [clearingLine];

  // Balance assertion: sum(credits) must equal sum(debits) (fees + clearing).
  const debitTotal = debitLines.reduce((s, l) => s + l.Amount, 0);
  if (Math.abs(creditTotal - debitTotal) > 0.005) {
    throw new Error(`Journal entry imbalance: credits ${creditTotal} != debits ${debitTotal}`);
  }

  return {
    Line: [...creditLines, ...debitLines],
    TxnDate: opts.txnDate,
    ...(opts.docNumber ? { DocNumber: opts.docNumber } : {}),
    PrivateNote: opts.syncId ? `${opts.memo} | ${opts.syncId}` : opts.memo,
  };
};

export { requestPayload, newRequestPayload, projectPayload };
