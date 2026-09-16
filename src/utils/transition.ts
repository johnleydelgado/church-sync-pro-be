export interface TransitionInputs {
  /** The clearing account's balance on the go-live day, EXCLUDING anything CSP had posted. */
  balanceAtGoLiveCents: number;
  /** Net CSP has posted for days on or after go-live. */
  postedSinceGoLiveCents: number;
  /** The account's live balance in QuickBooks right now. */
  qboBalanceCents: number;
}

export interface TransitionFigures {
  /** Money the bookkeeper has cleared out of the account since go-live. */
  releasedCents: number;
  /** CSP money that has not landed in the bank yet. Zero when there is a true-up. */
  inTransitCents: number;
  /** Old-process money cleared through the account: the one-time adjusting entry. Zero while money is still in transit. */
  trueUpCents: number;
}

/**
 * The transition arithmetic, from the one identity the clearing account obeys:
 *
 *     balance now = balance at go-live + CSP posted since − cleared out since
 *
 * CSP knows the first two and can read the third, so what was cleared out falls out directly.
 * If more was cleared than CSP ever put in, the excess is money from the old process that came
 * through a Stripe deposit after go-live - which is exactly the one-time true-up a church needs
 * when it switches over mid-period. No deposit is ever split; the account does the sum itself.
 *
 * Understated by whatever CSP money is still in transit at the moment of reading, so the panel
 * tells the reader to wait until the last pre-go-live deposit has landed.
 */
export const transitionFigures = (i: TransitionInputs): TransitionFigures => {
  const releasedCents = i.balanceAtGoLiveCents + i.postedSinceGoLiveCents - i.qboBalanceCents;
  const gap = i.balanceAtGoLiveCents - i.qboBalanceCents;
  return {
    releasedCents,
    inTransitCents: Math.max(0, -gap),
    trueUpCents: Math.max(0, gap),
  };
};
