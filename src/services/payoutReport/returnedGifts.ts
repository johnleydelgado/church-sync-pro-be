/**
 * A gift the donor's bank returned (an ACH payment that failed after Stripe charged it), as it shows in
 * Planning Center's payout report.
 *
 * The file has the gift's charge ("Donation #<id> - <donor> - <fund> ($600.00)"), then Stripe's own lines
 * taking it back, which name only Stripe's payment id - Active Church, October 2026:
 *   Charge failure  "Funds reversed due to payment py_3UMp... failed"   -$600.00 gross, -$600.75 net
 *   Fee             "Application fee refund for py_3UMp..."             +$0.05 net
 * Planning Center marks the gift failed, so CSP never posts it; what the return cost is the net of all
 * three lines ($1.00 there), which the church books itself. Nothing here posts.
 * docs/plans/2026-11-10-payout-bounces.md in the frontend repo.
 */

/** The part of a payout row these rules read: one from this file, or one stored by an earlier upload. */
export interface ReturnLine {
  rowKey: string;
  day: string;
  type: string;
  source: string;
  name: string | null;
  fundOrSignup: string | null;
  description: string | null;
  grossCents: number;
  netCents: number;
  feeCents?: number;
}

export type UnlinkedReason = 'returned_without_charge' | 'returned_unconfirmed' | 'returned_ambiguous';

export interface ReturnLinks {
  /** Failure and fee lines tied to a gift: rowKey -> Planning Center donation id. */
  gift: Map<string, string>;
  /** Failure and fee lines that could not be tied to one gift: rowKey -> why. */
  unlinked: Map<string, UnlinkedReason>;
}

/** A return is looked for this many days after the gift's charge. ACH returns come in two to five. */
export const RETURN_WINDOW_DAYS = 14;

const ID_IN_KEY = /^donation:(\d+):/;
const STRIPE_PAYMENT = /\b(?:py|ch|pi)_[A-Za-z0-9]+/;

export const donationIdOf = (row: { rowKey: string }): string | null => ID_IN_KEY.exec(String(row.rowKey))?.[1] ?? null;

/** Stripe's payment id in a line's description ("...due to payment py_3UMp... failed"), if any. */
export const stripePaymentIdOf = (row: { description?: string | null }): string | null =>
  STRIPE_PAYMENT.exec(String(row.description ?? ''))?.[0] ?? null;

export const isGivingCharge = (row: Pick<ReturnLine, 'source' | 'type' | 'grossCents'>): boolean =>
  row.source === 'Giving' && row.type === 'Charge' && Number(row.grossCents) > 0;

/** Stripe taking a gift back: a Giving line whose type mentions a failure, with money going out. */
export const isGivingFailure = (row: Pick<ReturnLine, 'source' | 'type' | 'grossCents'>): boolean =>
  row.source === 'Giving' && /fail/i.test(String(row.type)) && Number(row.grossCents) < 0;

export const isGivingFee = (row: Pick<ReturnLine, 'source' | 'type'>): boolean =>
  row.source === 'Giving' && /^fee$/i.test(String(row.type).trim());

const norm = (s: string | null | undefined) =>
  String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
const sameText = (a: string | null | undefined, b: string | null | undefined) => norm(a) !== '' && norm(a) === norm(b);
const daysFrom = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

/**
 * Ties Stripe's lines for returned payments to their gift. A failure belongs to the one charge with the
 * same donor, fund and amount, made up to RETURN_WINDOW_DAYS before it, whose gift Planning Center marks
 * returned (`returnedGifts`, donation ids). A fee belongs with the failure that names the same Stripe
 * payment. `charges` holds the charges to consider - this file's and stored ones; duplicates are fine.
 * A fee that names no failure's payment is not a returned gift's and is left out of both maps.
 */
export const linkReturnLines = (
  lines: ReturnLine[],
  charges: ReturnLine[],
  returnedGifts: Set<string>,
  /** Gifts that already have their return tied to them: a gift is returned once. */
  taken: Set<string> = new Set(),
): ReturnLinks => {
  const out: ReturnLinks = { gift: new Map(), unlinked: new Map() };
  const used = new Set(taken);
  const byPayment = new Map<string, { gift?: string; reason?: UnlinkedReason }>();
  // Oldest return first, so each takes the gift nearest before it while that one is still free.
  const failures = lines
    .filter(isGivingFailure)
    .sort((a, b) => a.day.localeCompare(b.day) || a.rowKey.localeCompare(b.rowKey));
  for (const f of failures) {
    let gift: string | null = null;
    let reason: UnlinkedReason | undefined;
    const keyed = donationIdOf(f);
    if (keyed) {
      // A line that names its gift still needs Planning Center to say that gift came back.
      if (returnedGifts.has(keyed) && !used.has(keyed)) gift = keyed;
      else reason = returnedGifts.has(keyed) ? 'returned_ambiguous' : 'returned_unconfirmed';
    } else {
      const alike = charges.filter(
        (c) =>
          isGivingCharge(c) &&
          !!donationIdOf(c) &&
          sameText(c.name, f.name) &&
          sameText(c.fundOrSignup, f.fundOrSignup) &&
          Number(c.grossCents) === -Number(f.grossCents) &&
          c.day <= f.day &&
          daysFrom(c.day, f.day) <= RETURN_WINDOW_DAYS,
      );
      const ids = [...new Set(alike.map((c) => donationIdOf(c)!))];
      const confirmed = ids.filter((id) => returnedGifts.has(id) && !used.has(id));
      if (confirmed.length === 1) gift = confirmed[0];
      else
        reason =
          confirmed.length > 1
            ? 'returned_ambiguous'
            : ids.some((id) => returnedGifts.has(id))
              ? 'returned_ambiguous' // the only matching returned gift already has its return
              : ids.length
                ? 'returned_unconfirmed'
                : 'returned_without_charge';
    }
    if (gift) {
      used.add(gift);
      out.gift.set(f.rowKey, gift);
    } else out.unlinked.set(f.rowKey, reason!);
    const payment = stripePaymentIdOf(f);
    if (payment) byPayment.set(payment, gift ? { gift } : { reason });
  }
  for (const fee of lines.filter(isGivingFee)) {
    const keyed = donationIdOf(fee);
    if (keyed) {
      // Only a returned gift's own fee is part of it; any other fee line is not ours to explain.
      if (returnedGifts.has(keyed)) out.gift.set(fee.rowKey, keyed);
      continue;
    }
    const payment = stripePaymentIdOf(fee);
    const failure = payment ? byPayment.get(payment) : undefined;
    if (failure?.gift) out.gift.set(fee.rowKey, failure.gift);
    else if (failure?.reason) out.unlinked.set(fee.rowKey, failure.reason);
  }
  return out;
};

/**
 * Whether a return line's gift was charged before the church's sync start date: a gift like it (same
 * donor, fund and amount, within the window before the return) exists, and every such gift is earlier
 * than `startDay`. Giving from before the start is left alone, and so is its return.
 */
export const returnBeforeStart = (line: ReturnLine, charges: ReturnLine[], startDay: string | null): boolean => {
  if (!startDay) return false;
  if (!isGivingFailure(line)) return line.day < startDay;
  const alike = charges.filter(
    (c) =>
      isGivingCharge(c) &&
      sameText(c.name, line.name) &&
      sameText(c.fundOrSignup, line.fundOrSignup) &&
      Number(c.grossCents) === -Number(line.grossCents) &&
      c.day <= line.day &&
      daysFrom(c.day, line.day) <= RETURN_WINDOW_DAYS,
  );
  return alike.length ? alike.every((c) => c.day < startDay) : line.day < startDay;
};

/** The return lines (by rowKey) of gifts from before the sync start date: failures, and their fees. */
export const preStartReturnLines = (
  lines: ReturnLine[],
  charges: ReturnLine[],
  startDay: string | null,
): Set<string> => {
  const out = new Set<string>();
  if (!startDay) return out;
  const payments = new Set<string>();
  for (const f of lines.filter(isGivingFailure)) {
    if (!returnBeforeStart(f, charges, startDay)) continue;
    out.add(f.rowKey);
    const payment = stripePaymentIdOf(f);
    if (payment) payments.add(payment);
  }
  for (const fee of lines.filter(isGivingFee)) {
    const payment = stripePaymentIdOf(fee);
    if ((payment && payments.has(payment)) || (!payment && fee.day < startDay)) out.add(fee.rowKey);
  }
  return out;
};

/**
 * What a returned gift cost the church, in cents (positive = a cost): everything its lines left in the
 * payouts - the charge and the lines that took it back. Null until a line taking it back is uploaded.
 */
export const returnCostCents = (
  charge: Pick<ReturnLine, 'netCents'>,
  lines: Pick<ReturnLine, 'source' | 'type' | 'grossCents' | 'netCents'>[],
): number | null => {
  if (!lines.some(isGivingFailure)) return null;
  return -(Number(charge.netCents) + lines.reduce((sum, l) => sum + Number(l.netCents), 0));
};
