import crypto from 'crypto';

/**
 * Planning Center's payout report ("full transaction details" export from Accounts).
 *
 * `Date` is the CHARGE (or refund) date, not the payout date, and the file carries no payout id -
 * so rows can be recorded, but not attributed to a particular deposit. Every row that comes from
 * Giving or Registrations carries its Planning Center id in the description, which is what makes
 * re-uploading a file safe (see `rowKey`).
 */
export const PAYOUT_REPORT_HEADER = [
  'Date',
  'Type',
  'Source',
  'Name',
  'Fund/Signup',
  'Gross',
  'Fee',
  'Net',
  'Payment method',
  'Campus',
  'Description',
];

export class PayoutReportFormatError extends Error {}

export interface PayoutRow {
  line: number; // 1-based line in the file, for messages
  day: string; // YYYY-MM-DD
  type: string; // 'Charge' | 'Refund' | whatever Planning Center adds later
  source: string; // 'Giving' | 'Registrations' | ...
  name: string;
  fundOrSignup: string;
  grossCents: number;
  feeCents: number; // magnitude as printed (positive)
  netCents: number;
  paymentMethod: string;
  campus: string;
  description: string;
  externalId: string | null; // 'donation:<id>' | 'registration:<id>'
  rowKey: string; // unique per (church, row); re-uploads never post twice
}

/** RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes. */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
};

const toCents = (raw: string, what: string, line: number): number => {
  const cleaned = String(raw ?? '').replace(/[$,\s]/g, '');
  const n = Number(cleaned);
  if (cleaned === '' || !Number.isFinite(n)) {
    throw new PayoutReportFormatError(`line ${line}: ${what} "${raw}" is not an amount`);
  }
  return Math.round(n * 100);
};

const ID_PATTERN = /(Donation|Registration) #(\d+)/;

export const parsePayoutReport = (text: string): PayoutRow[] => {
  const [header, ...body] = parseCsv(text);
  const normalized = (header ?? []).map((h) => h.trim());
  if (PAYOUT_REPORT_HEADER.some((h, i) => normalized[i] !== h)) {
    throw new PayoutReportFormatError(
      'This is not a Planning Center payout report. Export "full transaction details" from the payout report and upload that file.',
    );
  }
  // A file can list the very same charge twice (same id, day and amount): number the repeats so
  // each is recorded once instead of the second reading as "already recorded".
  const seen = new Map<string, number>();
  return body.map((f, i) => {
    const line = i + 2;
    const [day, type, source, name, fundOrSignup, gross, fee, net, paymentMethod, campus, description] = f.map((x) =>
      (x ?? '').trim(),
    );
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new PayoutReportFormatError(`line ${line}: date "${day}" is not YYYY-MM-DD`);
    const grossCents = toCents(gross, 'Gross', line);
    const feeCents = toCents(fee, 'Fee', line);
    const netCents = toCents(net, 'Net', line);
    const m = (description ?? '').match(ID_PATTERN);
    const externalId = m ? `${m[1].toLowerCase()}:${m[2]}` : null;
    const baseKey = externalId
      ? `${externalId}:${type.toLowerCase()}:${day}:${grossCents}`
      : // From the parsed fields, not the raw line: a quoted field may contain a line break, which
        // would shift raw-line positions and break re-upload safety for these rows.
        `raw:${crypto
          .createHash('sha1')
          .update(f.map((x) => (x ?? '').trim()).join('\u0001'))
          .digest('hex')}`;
    const occurrence = (seen.get(baseKey) ?? 0) + 1;
    seen.set(baseKey, occurrence);
    const rowKey = occurrence === 1 ? baseKey : `${baseKey}#${occurrence}`;
    return {
      line,
      day,
      type,
      source,
      name,
      fundOrSignup,
      grossCents,
      feeCents,
      netCents,
      paymentMethod,
      campus,
      description,
      externalId,
      rowKey,
    };
  });
};
