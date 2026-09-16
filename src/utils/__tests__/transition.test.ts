import { transitionFigures } from '../transition';

describe('transitionFigures', () => {
  test("Matt's example: $3,000 posted, a $5,000 deposit cleared in full", () => {
    // Go-live balance 0. CSP posted 3,000. The bookkeeper cleared 5,000, so QuickBooks reads -2,000.
    const f = transitionFigures({ balanceAtGoLiveCents: 0, postedSinceGoLiveCents: 300000, qboBalanceCents: -200000 });
    expect(f.releasedCents).toBe(500000);
    expect(f.trueUpCents).toBe(200000);
    expect(f.inTransitCents).toBe(0);
  });

  test('nothing cleared yet: everything CSP posted is still in transit', () => {
    const f = transitionFigures({ balanceAtGoLiveCents: 0, postedSinceGoLiveCents: 300000, qboBalanceCents: 300000 });
    expect(f.releasedCents).toBe(0);
    expect(f.inTransitCents).toBe(300000);
    expect(f.trueUpCents).toBe(0);
  });

  test('a non-zero starting balance is not mistaken for a true-up', () => {
    // The local sandbox: Undeposited Funds held 3,662.20 that was never CSP's; CSP posted 0.68.
    const f = transitionFigures({ balanceAtGoLiveCents: 366220, postedSinceGoLiveCents: 68, qboBalanceCents: 366288 });
    expect(f.releasedCents).toBe(0);
    expect(f.inTransitCents).toBe(68);
    expect(f.trueUpCents).toBe(0);
  });

  test('exactly balanced: nothing in transit, nothing to true up', () => {
    const f = transitionFigures({ balanceAtGoLiveCents: 0, postedSinceGoLiveCents: 100000, qboBalanceCents: 0 });
    expect(f).toEqual({ releasedCents: 100000, inTransitCents: 0, trueUpCents: 0 });
  });
});
