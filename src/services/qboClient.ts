/* eslint-disable @typescript-eslint/no-explicit-any */
import axios from 'axios';
import tokenEntity from '../db/models/tokenEntity';
import tokens from '../db/models/tokens';
import quickBookApi, { tokenProps } from '../utils/quickBookApi';

const { QBO_KEY, QBO_SECRET } = process.env;

const base64encode = (str: string) => Buffer.from(str).toString('base64');

/**
 * Refresh the QBO access/refresh token pair for a user via Intuit and persist the
 * rotated tokens back to the DB. This is the canonical per-user refresh implementation
 * (previously duplicated as `generateQBOToken` in automation.ts).
 *
 * Lives here (and not in automation.ts) so the new client helper can reuse it without
 * creating an import cycle: automation.ts imports from qboClient.ts, never the reverse.
 */
export const refreshQboToken = async (refreshToken: string, email: string) => {
  const authHeader = 'Basic ' + base64encode(QBO_KEY + ':' + QBO_SECRET);
  const requestBody = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  try {
    const data = await tokenEntity.findOne({
      where: { email: email as string, isEnabled: true },
      include: tokens,
    });

    const arr = data.tokens.find((item) => item.token_type === 'qbo');

    const response = await axios.post('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', requestBody, {
      headers: {
        Accept: 'application/json',
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    await tokens.update(
      { access_token: response.data.access_token, refresh_token: response.data.refresh_token },
      { where: { id: arr.id } },
    );

    return {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      realm_id: arr.realm_id,
    };
  } catch (err) {
    console.error('QBO token refresh failed for', email, err?.response?.data || err?.message || err);
    throw new Error(
      `QBO token refresh failed for ${email}: ${
        err?.response?.data?.error_description || err?.response?.data?.error || err?.message || 'unknown error'
      }`,
    );
  }
};

/**
 * Resolve the QuickBooks-shaped token object for a user. Looks up the enabled token
 * entity, finds the qbo token, refreshes per-user (always, not gated by a process-wide
 * singleton), and returns tokens in the shape `quickBookApi` expects.
 */
export const getQboTokensForUser = async (email: string): Promise<tokenProps> => {
  const data = await tokenEntity.findOne({
    where: { email: email as string, isEnabled: true },
    include: tokens,
  });

  if (!data) {
    throw new Error('Empty user data');
  }

  const arr = data.tokens.find((item) => item.token_type === 'qbo');

  if (!arr) {
    throw new Error('No qbo token');
  }

  const tokenJson = await refreshQboToken(arr.refresh_token, email);

  return {
    ACCESS_TOKEN: tokenJson.access_token,
    REALM_ID: tokenJson.realm_id,
    REFRESH_TOKEN: tokenJson.refresh_token,
  };
};

/**
 * Build a ready-to-use node-quickbooks client for a user, with freshly refreshed tokens.
 */
export const getQboClientForUser = async (email: string) => {
  return quickBookApi(await getQboTokensForUser(email));
};
