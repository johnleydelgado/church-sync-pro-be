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
  const authUri = quickbookAuth.authorizeUri({
    scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId],
    state: 'intuit-test',
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
        expiresIn: '1h',
      });

      res.json({
        access_token: responseJson.access_token,
        refresh_token: responseJson.refresh_token,
        tokenJwt,
      });
    })
    .catch(function (e: any) {
      console.log('json', {
        e,
      });

      res.status(500).json({ error: e.message });
    });
};

export const authPlanningCenter = async (req: Request, res: Response) => {
  try {
    res.send(
      `https://api.planningcenteronline.com/oauth/authorize?client_id=${PC_CLIENT_ID}&redirect_uri=${PC_REDIRECT}&response_type=code&scope=giving`,
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
      expiresIn: '1h',
    });
    console.log('responseJson.refresh_token', responseJson.refresh_token);
    res.json({
      access_token: responseJson.access_token,
      refresh_token: responseJson.refresh_token,
      tokenJwt,
    });
  } catch (e: any) {
    console.log('ERROR: ', e);
    res.status(500).json({ error: e.message });
  }
};
