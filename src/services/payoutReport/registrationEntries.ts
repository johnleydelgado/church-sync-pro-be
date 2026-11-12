/**
 * Journal entries for registration (event) money from Planning Center's payout report.
 *
 * Same shape as a day of giving - gross to income, Stripe's fee to the fee account, net to the
 * clearing account - so Clearing keeps matching the net deposits. One income line per account,
 * class AND event, named after the event: bookkeepers report income by event. With every event on
 * one unnamed line, Active Church's bookkeepers typed each event's name into every October 2026 entry
 * by hand, splitting the line on days with more than one event.
 */
export interface RegistrationEntryLine {
  accountRef: string;
  classRef?: string;
  /** The event (Planning Center signup) the payment is for: the payout report's Fund/Signup. */
  event?: string | null;
  grossCents: number;
  feeCents: number;
}
export interface RegistrationEntryOptions {
  day: string;
  docNumber: string;
  memo: string;
  clearing: { value: string; name?: string };
  fees: { value: string; name?: string; classRef?: string };
}

const amount = (cents: number) => Math.round(cents) / 100;
const detail = (postingType: 'Debit' | 'Credit', accountRef: { value: string; name?: string }, classRef?: string) => ({
  PostingType: postingType,
  AccountRef: accountRef,
  ...(classRef ? { ClassRef: { value: classRef } } : {}),
});
const line = (cents: number, d: any, description?: string) => ({
  Amount: amount(cents),
  ...(description ? { Description: description } : {}),
  DetailType: 'JournalEntryLineDetail',
  JournalEntryLineDetail: d,
});

export const registrationDocNumber = (day: string, sequence: number, kind: 'charge' | 'refund'): string =>
  `CSP-${kind === 'refund' ? 'ER' : 'E'}-${day}-${sequence}`.slice(0, 21);

const eventName = (event?: string | null) => String(event ?? '').trim().replace(/\s+/g, ' ');

/** In the order they first appear. Spacing and capitals don't make another event, as in the per-event mapping. */
const groupByAccountClassEvent = (lines: RegistrationEntryLine[]) => {
  const out = new Map<string, { accountRef: string; classRef?: string; event: string; cents: number }>();
  for (const l of lines) {
    const key = `${l.accountRef}|${l.classRef ?? ''}|${eventName(l.event).toLowerCase()}`;
    const prev = out.get(key) ?? { accountRef: l.accountRef, classRef: l.classRef, event: eventName(l.event), cents: 0 };
    prev.cents += Math.abs(l.grossCents);
    out.set(key, prev);
  }
  return [...out.values()];
};

const assertBalanced = (je: any) => {
  const sum = (t: string) =>
    je.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === t).reduce(
      (s: number, l: any) => s + Math.round(l.Amount * 100),
      0,
    );
  if (sum('Debit') !== sum('Credit')) {
    throw new Error(`Registration entry imbalance: debits ${sum('Debit')} != credits ${sum('Credit')}`);
  }
  return je;
};

export const registrationChargeEntry = (lines: RegistrationEntryLine[], o: RegistrationEntryOptions) => {
  if (!lines.length) throw new Error('No registration charges to post');
  const grossCents = lines.reduce((s, l) => s + l.grossCents, 0);
  const feeCents = lines.reduce((s, l) => s + Math.abs(l.feeCents), 0);
  if (feeCents > grossCents) throw new Error(`Fees ${feeCents} exceed gross ${grossCents}`);
  if (feeCents > 0 && !o.fees.value) throw new Error('No Stripe fee account is mapped');
  return assertBalanced({
    Line: [
      ...groupByAccountClassEvent(lines).map((g) => line(g.cents, detail('Credit', { value: g.accountRef }, g.classRef), g.event)),
      ...(feeCents > 0 ? [line(feeCents, detail('Debit', { value: o.fees.value, name: o.fees.name }, o.fees.classRef))] : []),
      line(grossCents - feeCents, detail('Debit', o.clearing)),
    ],
    TxnDate: o.day,
    DocNumber: o.docNumber,
    PrivateNote: o.memo,
  });
};

/** Refund rows carry negative gross and (always, so far) a zero fee; the classifier holds the rest. */
export const registrationRefundEntry = (lines: RegistrationEntryLine[], o: RegistrationEntryOptions) => {
  if (!lines.length) throw new Error('No registration refunds to post');
  if (lines.some((l) => l.feeCents !== 0)) throw new Error('Refunds with a returned fee are held for review');
  const cents = lines.reduce((s, l) => s + Math.abs(l.grossCents), 0);
  return assertBalanced({
    Line: [
      ...groupByAccountClassEvent(lines).map((g) => line(g.cents, detail('Debit', { value: g.accountRef }, g.classRef), g.event)),
      line(cents, detail('Credit', o.clearing)),
    ],
    TxnDate: o.day,
    DocNumber: o.docNumber,
    PrivateNote: o.memo,
  });
};
