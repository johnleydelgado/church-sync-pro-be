/**
 * The sync engine, end to end, against a real Postgres.
 *
 * Everything else in this repo's test suite exercises a pure function in isolation, and every
 * defect found on 2026-09-08 and 2026-09-09 lived in the wiring BETWEEN those functions rather
 * than inside any of them: fees dropped by a summing pass that ran before the fee total, a
 * refund pass that never consulted the giving filter, a split-gift helper that met a
 * drop-unmapped-lines guard downstream. Unit tests cannot see any of that.
 *
 * So this suite runs the real `syncBatchToJournalEntries` with the real database - the unique
 * indexes and the FOR UPDATE row lock are load-bearing and must be genuine - while faking only
 * the two external systems: Planning Center in, QuickBooks out. Assertions are on the journal
 * entries the engine TRIED to post.
 *
 * Setup is in jest.integration.config.js. Run with `npm run test:integration`.
 */
import axios from 'axios';

import sequelize from '../../db';
import DailyJeSync from '../../db/models/DailyJeSync';
import User from '../../db/models/user';
import UserSettings from '../../db/models/userSettings';
import UserSync from '../../db/models/UserSync';
import * as automation from '../../controller/automation';
import { syncBatchToJournalEntries } from '../syncEngine';

jest.mock('axios');
jest.mock('../../controller/automation', () => ({
  generatePcToken: jest.fn(),
  automationJournalEntry: jest.fn(),
  getFundInDonation: jest.fn(),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedAutomation = automation as jest.Mocked<typeof automation>;

const EMAIL = 'integration@example.test';
const USER_ID = 90001;
const TZ = 'America/New_York';

/** Accounts the fixtures map to, mirroring a real church's Mapping page. */
const ACCOUNTS = { general: '40', missions: '41', fees: '60', clearing: '10' };

const SETTINGS = [
  { fundName: 'General', account: { value: ACCOUNTS.general, label: 'Tithes & Offerings' }, class: { value: '', label: '' }, customer: { value: '', label: '' } },
  { fundName: 'Missions', account: { value: ACCOUNTS.missions, label: 'Missions Income' }, class: { value: '', label: '' }, customer: { value: '', label: '' } },
];
const BANK_CHARGES = { account: { value: ACCOUNTS.fees, label: 'Stripe Processing Fees' }, class: { value: '', label: '' } };
const BANK_DATA = [{ type: 'donation', value: ACCOUNTS.clearing, label: 'Stripe Clearing' }];

/** Journal entries the engine handed to QuickBooks, in order. */
let posted: any[] = [];

type DonationSpec = {
  id: string;
  cents: number;
  feeCents?: number;
  receivedAt: string;
  method?: string;
  status?: string;
  refunded?: boolean;
  feeCovered?: boolean;
  designations?: { id: string; cents: number; fund: string }[];
};

const FUND_IDS: Record<string, string> = { General: '901', Missions: '902', 'Youth Camp': '903' };

/** Build a PCO batch-donations payload, including the side-loaded designations and funds. */
const pcoPayload = (donations: DonationSpec[]) => {
  const included: any[] = [];
  const seenFunds = new Set<string>();
  const data = donations.map((d) => {
    const designations = d.designations ?? [{ id: `${d.id}-des`, cents: d.cents, fund: 'General' }];
    for (const des of designations) {
      const fundId = FUND_IDS[des.fund];
      included.push({
        type: 'Designation',
        id: des.id,
        attributes: { amount_cents: des.cents },
        relationships: { fund: { data: { type: 'Fund', id: fundId } } },
      });
      if (!seenFunds.has(fundId)) {
        seenFunds.add(fundId);
        included.push({ type: 'Fund', id: fundId, attributes: { name: des.fund } });
      }
    }
    return {
      type: 'Donation',
      id: d.id,
      attributes: {
        amount_cents: d.cents,
        fee_cents: d.feeCents ?? 0,
        payment_method: d.method ?? 'card',
        payment_status: d.status ?? 'succeeded',
        refunded: d.refunded ?? false,
        fee_covered: d.feeCovered ?? false,
        received_at: d.receivedAt,
        completed_at: d.receivedAt,
      },
      relationships: { designations: { data: designations.map((x) => ({ type: 'Designation', id: x.id })) } },
    };
  });
  return { data, included, links: {} };
};

/** Serve the org timezone, then the donation pages, in the order the engine asks. */
const servePco = (pages: any[]) => {
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.includes('/giving/v2') && !url.includes('/batches/')) {
      return { data: { data: { attributes: { time_zone: TZ } } } };
    }
    if (url.includes('/donations')) {
      const page = pages.shift();
      if (!page) throw new Error(`unexpected extra donations request: ${url}`);
      return { data: page };
    }
    throw new Error(`unmocked GET ${url}`);
  });
};

const run = (realBatchId: string) =>
  syncBatchToJournalEntries({
    user: { id: USER_ID, email: EMAIL },
    batchId: realBatchId,
    realBatchId,
    bankData: BANK_DATA,
    dataBatch: { id: realBatchId },
  });

/** Amounts by account and posting type, from a captured QuickBooks payload. */
const linesOf = (entry: any) =>
  entry.Line.map((l: any) => ({
    account: l.JournalEntryLineDetail.AccountRef.value,
    type: l.JournalEntryLineDetail.PostingType,
    amount: l.Amount,
  }));
const totalOf = (entry: any, type: 'Debit' | 'Credit') =>
  linesOf(entry).filter((l: any) => l.type === type).reduce((s: number, l: any) => s + l.amount, 0);
const amountFor = (entry: any, account: string) =>
  linesOf(entry).filter((l: any) => l.account === account).reduce((s: number, l: any) => s + l.amount, 0);

beforeAll(async () => {
  await sequelize.authenticate();
});

afterAll(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  posted = [];
  jest.clearAllMocks();

  mockedAutomation.generatePcToken.mockResolvedValue({ access_token: 'test-token', refresh_token: 'r' } as any);
  mockedAutomation.getFundInDonation.mockResolvedValue([{ id: '901', attributes: { name: 'General' } }] as any);
  mockedAutomation.automationJournalEntry.mockImplementation(async (_email: string, payload: any) => {
    posted.push(payload);
    return { Id: `JE${posted.length}` } as any;
  });

  await UserSync.destroy({ where: { userId: USER_ID } });
  await DailyJeSync.destroy({ where: { userId: USER_ID } });
  await UserSettings.destroy({ where: { userId: USER_ID } });
  await User.destroy({ where: { id: USER_ID } });

  await User.create({ id: USER_ID, email: EMAIL, isActive: true } as any);
  await UserSettings.create({
    userId: USER_ID,
    settingsData: SETTINGS,
    settingBankCharges: BANK_CHARGES,
    isAutomationEnable: true,
    isAutomationRegistration: false,
  } as any);
});

describe('one day of online giving', () => {
  test('posts a single entry: revenue credited gross, fees and clearing debited', async () => {
    servePco([
      pcoPayload([
        { id: 'd1', cents: 50000, feeCents: -758, receivedAt: '2026-08-23T14:00:00Z' },
        { id: 'd2', cents: 19920, feeCents: -300, receivedAt: '2026-08-23T15:00:00Z' },
      ]),
    ]);

    const result = await run('b1');

    expect(result.postedDays).toEqual(['2026-08-23']);
    expect(posted).toHaveLength(1);
    // The client's worked example: $699.20 given, $10.58 in fees, $688.62 owed by Stripe.
    expect(amountFor(posted[0], ACCOUNTS.general)).toBeCloseTo(699.2, 2);
    expect(amountFor(posted[0], ACCOUNTS.fees)).toBeCloseTo(10.58, 2);
    expect(amountFor(posted[0], ACCOUNTS.clearing)).toBeCloseTo(688.62, 2);
    expect(totalOf(posted[0], 'Debit')).toBeCloseTo(totalOf(posted[0], 'Credit'), 2);
  });

  // Regression: a summing pass folded same-fund donations together and dropped the rest,
  // taking their fee_cents with them - gross right, clearing overstated by the lost fees.
  test('keeps every donation fee when two gifts share a fund', async () => {
    servePco([
      pcoPayload([
        { id: 'd1', cents: 50000, feeCents: -758, receivedAt: '2026-08-23T14:00:00Z' },
        { id: 'd2', cents: 19920, feeCents: -300, receivedAt: '2026-08-23T15:00:00Z' },
      ]),
    ]);
    await run('b1');
    // Both fees, not just the surviving donation's.
    expect(amountFor(posted[0], ACCOUNTS.fees)).toBeCloseTo(10.58, 2);
  });

  test('cash and cheques never reach the entry', async () => {
    servePco([
      pcoPayload([
        { id: 'card', cents: 19920, feeCents: -300, receivedAt: '2026-08-23T14:00:00Z' },
        { id: 'cash', cents: 25000, feeCents: 0, method: 'cash', receivedAt: '2026-08-23T14:30:00Z' },
        { id: 'cheque', cents: 40000, feeCents: 0, method: 'check', receivedAt: '2026-08-23T15:00:00Z' },
      ]),
    ]);
    await run('b1');
    expect(amountFor(posted[0], ACCOUNTS.general)).toBeCloseTo(199.2, 2);
  });

  test('an ACH gift is online giving and is posted', async () => {
    servePco([pcoPayload([{ id: 'ach1', cents: 35000, feeCents: -87, method: 'ach', receivedAt: '2026-08-23T14:00:00Z' }])]);
    await run('b1');
    expect(posted).toHaveLength(1);
    expect(amountFor(posted[0], ACCOUNTS.general)).toBeCloseTo(350, 2);
  });

  test('a gift still in transit waits for a later run', async () => {
    servePco([pcoPayload([{ id: 'p1', cents: 10000, feeCents: 0, method: 'ach', status: 'pending', receivedAt: '2026-08-23T14:00:00Z' }])]);
    const result = await run('b1');
    expect(posted).toHaveLength(0);
    expect(result.postedDays).toEqual([]);
  });

  test('a split gift credits each fund its own share', async () => {
    servePco([
      pcoPayload([
        {
          id: 'split',
          cents: 10000,
          feeCents: -320,
          receivedAt: '2026-08-23T14:00:00Z',
          designations: [
            { id: 's1', cents: 6000, fund: 'General' },
            { id: 's2', cents: 4000, fund: 'Missions' },
          ],
        },
      ]),
    ]);
    await run('b1');
    expect(amountFor(posted[0], ACCOUNTS.general)).toBeCloseTo(60, 2);
    expect(amountFor(posted[0], ACCOUNTS.missions)).toBeCloseTo(40, 2);
    expect(totalOf(posted[0], 'Credit')).toBeCloseTo(100, 2);
  });

  // Regression: splitting a gift whose second fund is unmapped posted only the mapped share
  // while the whole donation's fee was still charged, leaving the clearing account short.
  test('a split gift with an unmapped fund still posts its full value', async () => {
    servePco([
      pcoPayload([
        {
          id: 'split',
          cents: 10000,
          feeCents: -320,
          receivedAt: '2026-08-23T14:00:00Z',
          designations: [
            { id: 's1', cents: 6000, fund: 'General' },
            { id: 's2', cents: 4000, fund: 'Youth Camp' },
          ],
        },
      ]),
    ]);
    await run('b1');
    expect(totalOf(posted[0], 'Credit')).toBeCloseTo(100, 2);
    expect(amountFor(posted[0], ACCOUNTS.clearing)).toBeCloseTo(96.8, 2);
    expect(totalOf(posted[0], 'Debit')).toBeCloseTo(totalOf(posted[0], 'Credit'), 2);
  });
});

describe('pagination', () => {
  // Regression: a single un-paginated GET truncated at Planning Center's default of 25,
  // so any larger batch posted short with no error.
  test('a batch spanning two pages posts every donation', async () => {
    const first = pcoPayload(
      Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, cents: 10000, feeCents: -320, receivedAt: '2026-08-23T14:00:00Z' })),
    );
    (first as any).links = { next: 'https://api.planningcenteronline.com/giving/v2/batches/b1/donations?offset=25' };
    const second = pcoPayload(
      Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, cents: 10000, feeCents: -320, receivedAt: '2026-08-23T14:00:00Z' })),
    );
    servePco([first, second]);

    await run('b1');

    expect(posted).toHaveLength(1);
    expect(amountFor(posted[0], ACCOUNTS.general)).toBeCloseTo(3000, 2); // 30 x $100, not 25
    expect(amountFor(posted[0], ACCOUNTS.fees)).toBeCloseTo(96, 2); // 30 x $3.20
  });
});

describe('the same day arriving twice', () => {
  test('a second batch for a posted day adds an adjusting entry, not a duplicate', async () => {
    servePco([pcoPayload([{ id: 'd1', cents: 50000, feeCents: -758, receivedAt: '2026-08-23T14:00:00Z' }])]);
    await run('b1');

    servePco([pcoPayload([{ id: 'd2', cents: 19920, feeCents: -300, receivedAt: '2026-08-23T16:00:00Z' }])]);
    const second = await run('b2');

    expect(posted).toHaveLength(2);
    expect(second.postedDays).toEqual(['2026-08-23']);
    // The adjusting entry covers only the new money, and says so.
    expect(amountFor(posted[1], ACCOUNTS.general)).toBeCloseTo(199.2, 2);
    expect(String(posted[1].PrivateNote ?? posted[1].DocNumber ?? '')).toMatch(/Adjust/i);

    const ledger = await DailyJeSync.findOne({ where: { userId: USER_ID, day: '2026-08-23' } });
    expect(Number(ledger!.entryCount)).toBe(2);
    expect(Number(ledger!.postedGrossCents)).toBe(69920);
    expect(Number(ledger!.postedFeeCents)).toBe(1058);
  });

  test('re-running the identical batch posts nothing', async () => {
    servePco([pcoPayload([{ id: 'd1', cents: 50000, feeCents: -758, receivedAt: '2026-08-23T14:00:00Z' }])]);
    await run('b1');
    expect(posted).toHaveLength(1);

    servePco([pcoPayload([{ id: 'd1', cents: 50000, feeCents: -758, receivedAt: '2026-08-23T14:00:00Z' }])]);
    const again = await run('b1');

    expect(posted).toHaveLength(1);
    expect(again.postedDays).toEqual([]);
  });
});

describe('refunds', () => {
  const withRefund = (spec: DonationSpec, refund: { amount: number; fee: number; at: string }) => {
    const payload = pcoPayload([spec]);
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.includes('/giving/v2') && !url.includes('/batches/') && !url.includes('/refund')) {
        return { data: { data: { attributes: { time_zone: TZ } } } };
      }
      if (url.includes('/refund')) {
        return {
          data: {
            data: { attributes: { amount_cents: refund.amount, fee_cents: refund.fee, refunded_at: refund.at } },
            included: [
              {
                // PCO's DesignationRefund carries both `designation` and `fund`; the engine
                // reads `fund`, which is what maps the reversal back to a revenue account.
                type: 'DesignationRefund',
                id: `${spec.id}-dr`,
                attributes: { amount_cents: refund.amount },
                relationships: {
                  designation: { data: { type: 'Designation', id: `${spec.id}-des` } },
                  fund: { data: { type: 'Fund', id: FUND_IDS.General } },
                },
              },
            ],
          },
        };
      }
      if (url.includes('/donations')) return { data: payload };
      throw new Error(`unmocked GET ${url}`);
    });
  };

  // Regression: refunds were selected on `refunded === true` alone, so a refunded CASH gift -
  // money no journal entry ever recorded - got a reversal against the Stripe clearing account.
  test('a refunded cash gift is not reversed', async () => {
    withRefund(
      { id: 'cash1', cents: 50000, feeCents: 0, method: 'cash', refunded: true, receivedAt: '2026-08-23T14:00:00Z' },
      { amount: 50000, fee: 0, at: '2026-09-01T10:00:00Z' },
    );
    const result = await run('b1');
    expect(posted).toHaveLength(0);
    expect(result.postedDays).toEqual([]);
  });

  // Regression: the refund pass only ran when the batch also held eligible giving, so a batch
  // whose only news was a refund posted nothing and the money stayed in clearing.
  test('a batch containing only a refund still posts the reversal', async () => {
    withRefund(
      { id: 'card1', cents: 50000, feeCents: -758, refunded: true, receivedAt: '2026-08-23T14:00:00Z' },
      { amount: 50000, fee: 758, at: '2026-09-01T10:00:00Z' },
    );
    const result = await run('b1');
    expect(result.postedDays).toContain('refund:2026-09-01');
    expect(posted).toHaveLength(1);
    // A reversal is the giving entry backwards: revenue debited, clearing credited.
    expect(linesOf(posted[0]).find((l: any) => l.account === ACCOUNTS.general)?.type).toBe('Debit');
    expect(linesOf(posted[0]).find((l: any) => l.account === ACCOUNTS.clearing)?.type).toBe('Credit');
  });

  // Regression: a second refund landing on a day that already had a reversing entry hit the
  // posted claim row and was dropped in silence - the money left the church's Stripe balance
  // but the books never showed it.
  test('a second refund on an already-reversed day posts the difference', async () => {
    withRefund(
      { id: 'card1', cents: 50000, feeCents: -758, refunded: true, receivedAt: '2026-08-23T14:00:00Z' },
      { amount: 20000, fee: 300, at: '2026-09-01T10:00:00Z' },
    );
    await run('b1');
    expect(posted).toHaveLength(1);
    expect(amountFor(posted[0], ACCOUNTS.general)).toBeCloseTo(200, 2);

    // The same day, now carrying a larger refund total.
    withRefund(
      { id: 'card1', cents: 50000, feeCents: -758, refunded: true, receivedAt: '2026-08-23T14:00:00Z' },
      { amount: 50000, fee: 758, at: '2026-09-01T10:00:00Z' },
    );
    const second = await run('b1');

    expect(second.postedDays).toContain('refund:2026-09-01');
    expect(posted).toHaveLength(2);
    // Only the extra $300 is reversed, not the whole $500 again.
    expect(amountFor(posted[1], ACCOUNTS.general)).toBeCloseTo(300, 2);

    const ledger = await DailyJeSync.findOne({ where: { userId: USER_ID, day: '2026-09-01' } });
    expect(Number(ledger!.refundedGrossCents)).toBe(50000);
  });

  test('an unchanged refund is not reversed twice', async () => {
    const spec = { id: 'card1', cents: 50000, feeCents: -758, refunded: true, receivedAt: '2026-08-23T14:00:00Z' } as const;
    withRefund({ ...spec }, { amount: 50000, fee: 758, at: '2026-09-01T10:00:00Z' });
    await run('b1');
    withRefund({ ...spec }, { amount: 50000, fee: 758, at: '2026-09-01T10:00:00Z' });
    const again = await run('b1');
    expect(posted).toHaveLength(1);
    expect(again.postedDays).not.toContain('refund:2026-09-01');
  });

  // Regression: a posted `refund:<day>` row failed the legacy-Deposit test, so the batch looked
  // already-deposited and every later donation in it was blocked forever.
  test('a posted refund does not block later giving in the same batch', async () => {
    withRefund(
      { id: 'card1', cents: 50000, feeCents: -758, refunded: true, receivedAt: '2026-08-23T14:00:00Z' },
      { amount: 50000, fee: 758, at: '2026-09-01T10:00:00Z' },
    );
    await run('b1');
    expect(posted).toHaveLength(1);

    servePco([pcoPayload([{ id: 'new1', cents: 19920, feeCents: -300, receivedAt: '2026-09-02T14:00:00Z' }])]);
    const second = await run('b1');

    expect(second.postedDays).toEqual(['2026-09-02']);
    expect(posted).toHaveLength(2);
  });
});

describe('the church timezone decides the day', () => {
  // The client's rule: a late-evening gift belongs to the day it was given locally, not the
  // next UTC day. 2026-08-23T23:30Z is 7:30pm on the 23rd in New York.
  test('a late-evening gift stays on its local day', async () => {
    servePco([pcoPayload([{ id: 'late', cents: 10000, feeCents: -320, receivedAt: '2026-08-23T23:30:00Z' }])]);
    const result = await run('b1');
    expect(result.postedDays).toEqual(['2026-08-23']);
  });
});

describe('a batch that grows after it was posted', () => {
  // Regression: the claim row was a bare flag, so once a batch/day was posted that batch could
  // never add to the day again. The un-paginated fetch had been truncating batches at 25
  // donations, so fixing pagination meant the engine would fetch the missing gifts and then
  // silently discard them - reporting success while the day stayed short.
  test('tops the day up with the difference instead of discarding it', async () => {
    servePco([pcoPayload([{ id: 'd1', cents: 50000, feeCents: -758, receivedAt: '2026-08-23T14:00:00Z' }])]);
    await run('b1');
    expect(posted).toHaveLength(1);
    expect(amountFor(posted[0], ACCOUNTS.general)).toBeCloseTo(500, 2);

    // Same batch, now returning a donation it had truncated away.
    servePco([
      pcoPayload([
        { id: 'd1', cents: 50000, feeCents: -758, receivedAt: '2026-08-23T14:00:00Z' },
        { id: 'd2', cents: 19920, feeCents: -300, receivedAt: '2026-08-23T15:00:00Z' },
      ]),
    ]);
    const second = await run('b1');

    expect(second.postedDays).toEqual(['2026-08-23']);
    expect(posted).toHaveLength(2);
    // Only the difference, not the whole day again.
    expect(amountFor(posted[1], ACCOUNTS.general)).toBeCloseTo(199.2, 2);
    expect(amountFor(posted[1], ACCOUNTS.fees)).toBeCloseTo(3.0, 2);
    expect(totalOf(posted[1], 'Debit')).toBeCloseTo(totalOf(posted[1], 'Credit'), 2);

    // The day's ledger now matches the full amount actually given.
    const ledger = await DailyJeSync.findOne({ where: { userId: USER_ID, day: '2026-08-23' } });
    expect(Number(ledger!.postedGrossCents)).toBe(69920);
    expect(Number(ledger!.postedFeeCents)).toBe(1058);
  });

  test('an unchanged batch still posts nothing on a re-run', async () => {
    const donations = [{ id: 'd1', cents: 50000, feeCents: -758, receivedAt: '2026-08-23T14:00:00Z' }];
    servePco([pcoPayload(donations)]);
    await run('b1');
    servePco([pcoPayload(donations)]);
    const again = await run('b1');
    expect(posted).toHaveLength(1);
    expect(again.postedDays).toEqual([]);
  });

  test('a new fund appearing in the batch is credited on its own line', async () => {
    servePco([pcoPayload([{ id: 'd1', cents: 50000, feeCents: -758, receivedAt: '2026-08-23T14:00:00Z' }])]);
    await run('b1');

    servePco([
      pcoPayload([
        { id: 'd1', cents: 50000, feeCents: -758, receivedAt: '2026-08-23T14:00:00Z' },
        {
          id: 'd2',
          cents: 10000,
          feeCents: -320,
          receivedAt: '2026-08-23T16:00:00Z',
          designations: [{ id: 'd2-des', cents: 10000, fund: 'Missions' }],
        },
      ]),
    ]);
    await run('b1');

    expect(amountFor(posted[1], ACCOUNTS.missions)).toBeCloseTo(100, 2);
    expect(amountFor(posted[1], ACCOUNTS.general)).toBeCloseTo(0, 2);
  });

  // A claim written before this bookkeeping existed has no baseline. Re-posting the whole day
  // against it would duplicate money already in the books, so it must stay skipped.
  test('a claim with no recorded baseline is left alone', async () => {
    servePco([pcoPayload([{ id: 'd1', cents: 50000, feeCents: -758, receivedAt: '2026-08-23T14:00:00Z' }])]);
    await run('b1');
    await UserSync.update(
      { postedByAccount: null, postedGrossCents: null, postedFeeCents: null },
      { where: { userId: USER_ID, batchId: 'b1', donationId: '2026-08-23' } },
    );

    servePco([
      pcoPayload([
        { id: 'd1', cents: 50000, feeCents: -758, receivedAt: '2026-08-23T14:00:00Z' },
        { id: 'd2', cents: 19920, feeCents: -300, receivedAt: '2026-08-23T15:00:00Z' },
      ]),
    ]);
    const second = await run('b1');

    expect(posted).toHaveLength(1);
    expect(second.postedDays).toEqual([]);
  });
});

describe('donors who cover the Stripe fee', () => {
  // The donor is charged the gift plus the fee, so Stripe deposits the whole gift and the
  // church never pays the fee. Booking it as an expense both overstates costs and leaves the
  // clearing account short of the deposit it is supposed to match.
  test('the whole gift reaches clearing and no fee is expensed', async () => {
    servePco([
      pcoPayload([{ id: 'covered', cents: 10000, feeCents: -320, feeCovered: true, receivedAt: '2026-08-23T14:00:00Z' }]),
    ]);
    await run('b1');

    expect(amountFor(posted[0], ACCOUNTS.general)).toBeCloseTo(100, 2);
    expect(amountFor(posted[0], ACCOUNTS.clearing)).toBeCloseTo(100, 2);
    expect(amountFor(posted[0], ACCOUNTS.fees)).toBeCloseTo(0, 2);
    expect(totalOf(posted[0], 'Debit')).toBeCloseTo(totalOf(posted[0], 'Credit'), 2);
  });

  test('a day mixing covered and uncovered fees matches the real deposit', async () => {
    servePco([
      pcoPayload([
        { id: 'plain', cents: 10000, feeCents: -320, receivedAt: '2026-08-23T14:00:00Z' },
        { id: 'covered', cents: 10000, feeCents: -320, feeCovered: true, receivedAt: '2026-08-23T15:00:00Z' },
      ]),
    ]);
    await run('b1');

    expect(amountFor(posted[0], ACCOUNTS.general)).toBeCloseTo(200, 2);
    expect(amountFor(posted[0], ACCOUNTS.fees)).toBeCloseTo(3.2, 2);
    // $96.80 from the ordinary gift plus $100.00 from the covered one.
    expect(amountFor(posted[0], ACCOUNTS.clearing)).toBeCloseTo(196.8, 2);
  });
});
