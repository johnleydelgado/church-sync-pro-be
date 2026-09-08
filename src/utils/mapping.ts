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

export const isStripeElectronic = (donation: any): boolean => {
  const a = donation?.attributes ?? {};
  const method = (a.payment_method ?? '').toLowerCase();
  if (!STRIPE_ELECTRONIC_METHODS.includes(method)) return false;
  if (a.refunded === true) return false;
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
}

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
    PrivateNote: opts.syncId ? `${opts.memo} | ${opts.syncId}` : opts.memo,
  };
};

export { requestPayload, newRequestPayload, projectPayload };
