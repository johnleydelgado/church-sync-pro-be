import { PayoutRow } from './parsePayoutReport';
import { RegistrationMappingV2, accountForSignup } from './registrationMapping';

export type ClassifiedStatus = 'to_post' | 'already_recorded' | 'before_start' | 'giving' | 'held';
export interface ClassifiedRow {
  row: PayoutRow;
  status: ClassifiedStatus;
  reason?: string;
  accountRef?: string;
  classRef?: string;
}
export interface ClassifyContext {
  registrationStartDay: string; // YYYY-MM-DD, required: never post a church's whole history
  mapping: RegistrationMappingV2;
  knownKeys: Set<string>; // rowKeys already stored in a final state
}

const held = (row: PayoutRow, reason: string): ClassifiedRow => ({ row, status: 'held', reason });

/**
 * What to do with each row. Pure - no I/O - so the rules can be read and tested in one place.
 * Anything not positively recognised is HELD for a person, never skipped: Matt's rule is that
 * every dollar in a payout is recorded or someone has looked at it.
 */
export const classifyRows = (rows: PayoutRow[], ctx: ClassifyContext): ClassifiedRow[] =>
  rows.map((row) => {
    if (ctx.knownKeys.has(row.rowKey)) return { row, status: 'already_recorded' };
    if (row.type !== 'Charge' && row.type !== 'Refund') return held(row, 'unrecognised_type');
    if (row.source === 'Giving') return { row, status: 'giving' };
    if (row.source !== 'Registrations') return held(row, 'unrecognised_source');
    if (row.netCents !== row.grossCents - row.feeCents) return held(row, 'amounts_do_not_add_up');
    if ((row.type === 'Charge' && row.grossCents <= 0) || (row.type === 'Refund' && row.grossCents >= 0)) {
      return held(row, 'unexpected_sign');
    }
    if (row.type === 'Refund' && row.feeCents !== 0) return held(row, 'refund_with_fee');
    if (row.day < ctx.registrationStartDay) return { row, status: 'before_start' };
    const target = accountForSignup(ctx.mapping, row.fundOrSignup);
    if (!target) return held(row, 'no_account_mapped');
    return { row, status: 'to_post', accountRef: target.accountRef, classRef: target.classRef };
  });
