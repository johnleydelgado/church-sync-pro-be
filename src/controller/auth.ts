/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */
import quickbookAuth from '../utils/quickbookAuth';
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { storageKey } from '../constant/storage';
import User from '../db/models/user';
const OAuthClient = require('intuit-oauth');
import Stripe from 'stripe';

const { PC_CLIENT_ID, PC_SECRET_APP, PC_REDIRECT, STRIPE_SECRET_KEY, STRIPE_PUB_KEY, STRIPE_CLIENT_ID } = process.env;
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

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
        expiresIn: '12h',
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
      `https://api.planningcenteronline.com/oauth/authorize?client_id=${PC_CLIENT_ID}&redirect_uri=${PC_REDIRECT}&response_type=code&scope=giving+calendar`,
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

export const authStripe = async (req: Request, res: Response) => {
  try {
    const clientId = STRIPE_CLIENT_ID;
    const responseType = 'code';
    const scope = 'read_write';
    const redirectUri = PC_REDIRECT;

    const authorizationUrl = `https://connect.stripe.com/oauth/authorize?response_type=${responseType}&client_id=${clientId}&scope=${scope}&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}`;
    res.send(authorizationUrl);
  } catch (e) {}
};

export const callBackStripe = async (req: Request, res: Response) => {
  // const clientId = STRIPE_PUB_KEY;
  // const clientSecret = STRIPE_SECRET_KEY;
  const code = req.body.code as string;
  console.log('code', code);
  try {
    const response = await stripe.oauth.token({ grant_type: 'authorization_code', code });

    // const stripe2 = new Stripe(response.access_token, { apiVersion: '2022-11-15' });

    // const charges = await stripe2.charges.list({ limit: 100 }); // Retrieve up to 100 charges at once, the maximum allowed by Stripe API

    // // console.log(charges.data[0]);
    // // console.log(charges.data[0].payment_method_details);
    // console.log('aa', charges.data[0].balance_transaction);
    // if (charges.data[0].balance_transaction) {
    //   const chargea = await stripe2.charges.retrieve(charges.data[0].id, {
    //     expand: ['balance_transaction'],
    //   });

    //   console.log(chargea);
    // }

    // Save the access_token, refresh_token, and other information as needed
    console.log('Access Token:', response.access_token);
    console.log('Refresh Token:', response.refresh_token);
    console.log('Stripe User ID:', response.stripe_user_id);

    res.json({ access_token: response.access_token, refresh_token: response.refresh_token });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).send('An error occurred during the OAuth process');
  }
};
