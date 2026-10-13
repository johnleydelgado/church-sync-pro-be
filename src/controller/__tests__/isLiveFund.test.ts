/**
 * Which Planning Center funds belong on the Mapping page.
 *
 * Planning Center's labels and its API values do not line up (verified against Active Church's
 * funds, 2026-10-13): "Hidden" in the app is `admin_only`, "Link Only" is `hidden`, and only
 * "Closed" is `nowhere`. A Link Only fund is live - donors reach it through a direct link - so
 * leaving it off the Mapping page meant its gifts could never be posted.
 */
jest.mock('../automation', () => ({ generatePcToken: jest.fn() }));
jest.mock('../../services/qboClient', () => ({ getQboTokensForUser: jest.fn() }));
jest.mock('../../utils/quickBookApi', () => ({ __esModule: true, default: jest.fn() }));

import { isLiveFund } from '../planning-center';

const fund = (visibility: string) => ({ attributes: { visibility } });

test.each([
  ['everywhere', true], // shown on Church Center
  ['admin_only', true], // "Hidden" in Planning Center: staff record gifts against it
  ['hidden', true], // "Link Only": donors give through a direct link (Legacy Offering)
  ['nowhere', false], // "Closed": no new gifts
])('visibility %s -> listed: %s', (visibility, listed) => {
  expect(isLiveFund(fund(visibility))).toBe(listed);
});
