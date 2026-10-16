/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */
import quickbookAuth from '../utils/quickbookAuth';
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { storageKey } from '../constant/storage';
import User from '../db/models/user';
const OAuthClient = require('intuit-oauth');

const { PC_CLIENT_ID, PC_SECRET_APP, PC_REDIRECT } = process.env;

// GET /authQB and /authPC take the browser's one-time state (16 to 32 random bytes, lowercase hex) and
// put it in the provider's sign-in address unchanged. The browser refuses a return carrying any other,
// so a sign-in it never started cannot be finished here (OAuth CSRF). No well-formed state, no address:
// intuit-oauth would quietly invent one of its own.
const OAUTH_STATE = /^[0-9a-f]{32,64}$/;
const stateFrom = (req: Request): string | null => {
  const { state } = req.query;
  return typeof state === 'string' && OAUTH_STATE.test(state) ? state : null;
};
const INVALID_STATE = { success: false, message: 'Missing or invalid state' };

interface tokenObj {
  access_token: string;
  token_type: string;
  x_refresh_token_expires_in: number;
  id_token: string;
  refresh_token: string;
  expires_in: number;
}

interface tokenPcObj {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  created_at: number;
}

export const authQuickBook = async (req: Request, res: Response) => {
  const state = stateFrom(req);
  if (!state) return res.status(400).json(INVALID_STATE);
  const authUri = quickbookAuth.authorizeUri({
    scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId],
    state,
  });
  res.send(authUri);
};

export const callBackQBO = async (req: Request, res: Response) => {
  const { url } = req.body;
  quickbookAuth
    .createToken(url)
    .then(function (authResponse: any) {
      const responseJson: tokenObj = authResponse.getJson();

      const tokenJwt = jwt.sign({ accessToken: responseJson.access_token }, storageKey.QBQ_ACCESS_TOKEN, {
        expiresIn: '12h',
      });

      res.json({
        access_token: responseJson.access_token,
        refresh_token: responseJson.refresh_token,
        tokenJwt,
      });
    })
    .catch(function (e: any) {
      // Never log the whole error: it carries the request, and with it the app's credentials.
      console.log('callBackQBO failed:', e?.error || e?.originalMessage || e?.message, e?.intuit_tid || '');
      res.status(500).json({ error: e.message });
    });
};

export const authPlanningCenter = async (req: Request, res: Response) => {
  const state = stateFrom(req);
  if (!state) return res.status(400).json(INVALID_STATE);
  try {
    res.send(
      `https://api.planningcenteronline.com/oauth/authorize?client_id=${PC_CLIENT_ID}&redirect_uri=${PC_REDIRECT}&response_type=code&scope=giving+calendar` +
        `&state=${encodeURIComponent(state)}`,
    );
  } catch (e: any) {
    console.log('authUri', e);
    res.status(500).json({ error: e.message });
  }
};

export const callBackPC = async (req: Request, res: Response) => {
  const { code } = req.body;

  try {
    const data = {
      grant_type: 'authorization_code',
      code: code,
      client_id: PC_CLIENT_ID,
      client_secret: PC_SECRET_APP,
      redirect_uri: PC_REDIRECT,
    };

    const config = {
      method: 'post',
      url: 'https://api.planningcenteronline.com/oauth/token',
      data: data,
    };

    const result = await axios.post(config.url, data);
    const responseJson: tokenPcObj = result.data;
    const tokenJwt = jwt.sign({ accessToken: responseJson.access_token }, storageKey.QBQ_ACCESS_TOKEN, {
      expiresIn: '12h',
    });
    res.json({
      access_token: responseJson.access_token,
      refresh_token: responseJson.refresh_token,
      tokenJwt,
    });
  } catch (e: any) {
    // Never log the whole AxiosError: its config holds the client secret and the code.
    console.log('callBackPC failed:', e?.response?.status, e?.response?.data?.error ?? e?.message);
    res.status(500).json({ error: e.message });
  }
};
