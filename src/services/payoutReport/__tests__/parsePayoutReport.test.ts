import { parsePayoutReport, PayoutReportFormatError } from '../parsePayoutReport';

const HEADER = 'Date,Type,Source,Name,Fund/Signup,Gross,Fee,Net,Payment method,Campus,Description';
const csv = (...lines: string[]) => [HEADER, ...lines].join('\r\n');

describe('parsePayoutReport', () => {
  test('reads a giving charge with quoted thousands', () => {
    const [row] = parsePayoutReport(
      csv(
        '2026-09-28,Charge,Giving,Joseph Silva,Tithes & Offerings,"1,900.00",41.15,"1,858.85",card,,"Donation #403670967 - Joseph Silva - Tithes & Offerings ($1,900.00)"',
      ),
    );
    expect(row).toMatchObject({
      line: 2,
      day: '2026-09-28',
      type: 'Charge',
      source: 'Giving',
      fundOrSignup: 'Tithes & Offerings',
      grossCents: 190000,
      feeCents: 4115,
      netCents: 185885,
      paymentMethod: 'card',
      externalId: 'donation:403670967',
      rowKey: 'donation:403670967:charge:2026-09-28:190000',
    });
  });

  test('reads a registration charge and a refund of an earlier charge', () => {
    const rows = parsePayoutReport(
      csv(
        '2026-09-27,Charge,Registrations,Mary K,SHE Conference 2026,60.00,1.59,58.41,card,,"Registration #86735390 - Mary K - SHE Conference 2026"',
        '2026-09-05,Refund,Registrations,Ashton A,Active Youth Magic Mountain Trip,-55.00,0.00,-55.00,card,,"REFUND FOR CHARGE (Registration #85597556 - Ashton A - Active Youth Magic Mountain Trip)"',
      ),
    );
    expect(rows[0]).toMatchObject({ externalId: 'registration:86735390', grossCents: 6000, feeCents: 159, netCents: 5841 });
    expect(rows[1]).toMatchObject({
      type: 'Refund',
      externalId: 'registration:85597556',
      grossCents: -5500,
      feeCents: 0,
      netCents: -5500,
      rowKey: 'registration:85597556:refund:2026-09-05:-5500',
    });
  });

  test('a row with no recognisable id still gets a stable key', () => {
    const line = '2026-10-02,Dispute,Stripe,,,-25.00,15.00,-40.00,card,,Chargeback';
    const a = parsePayoutReport(csv(line))[0];
    const b = parsePayoutReport(csv(line))[0];
    expect(a.externalId).toBeNull();
    expect(a.rowKey).toMatch(/^raw:[0-9a-f]{40}$/);
    expect(a.rowKey).toBe(b.rowKey);
  });

  test('the same charge listed twice in one file gets two keys, so neither is skipped', () => {
    const line = '2026-10-05,Charge,Registrations,M,SHE,60.00,1.59,58.41,card,,"Registration #5 - M - SHE"';
    const rows = parsePayoutReport(csv(line, line));
    expect(rows.map((r) => r.rowKey)).toEqual(['registration:5:charge:2026-10-05:6000', 'registration:5:charge:2026-10-05:6000#2']);
  });

  test('tolerates a BOM, LF endings and blank lines', () => {
    const text =
      '\uFEFF' + HEADER + '\n\n2026-09-27,Charge,Registrations,M,SHE,60.00,1.59,58.41,card,,"Registration #1 - M - SHE"\n';
    expect(parsePayoutReport(text)).toHaveLength(1);
  });

  test('rejects a file that is not the payout report', () => {
    expect(() => parsePayoutReport('id,donor_id,amount\n1,2,3')).toThrow(PayoutReportFormatError);
  });

  test('rejects a row whose amount is not a number, naming the line', () => {
    expect(() => parsePayoutReport(csv('2026-09-27,Charge,Giving,X,F,abc,0,0,card,,"Donation #1"'))).toThrow(/line 2/);
  });

  test('rejects a date that is not YYYY-MM-DD', () => {
    expect(() => parsePayoutReport(csv('09/27/2026,Charge,Giving,X,F,1.00,0,1.00,card,,"Donation #1"'))).toThrow(/line 2/);
  });
});
