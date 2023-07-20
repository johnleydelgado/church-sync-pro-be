/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request, Response } from 'express';
import User from '../db/models/user';
import { responseError, responseSuccess } from '../utils/response';
import Stripe from 'stripe';
import { isEmpty, sumBy } from 'lodash';
import { format, fromUnixTime } from 'date-fns';
import { automationDeposit, generatePcToken } from './automation';
import UserSync from '../db/models/UserSync';
import UserSettings from '../db/models/userSettings';
import { SettingsJsonProps, requestPayload } from '../utils/mapping';
import axios from 'axios';
import tokens from '../db/models/tokens';
import tokenEntity from '../db/models/tokenEntity';
const { PC_CLIENT_ID, PC_SECRET_APP, PC_REDIRECT, STRIPE_SECRET_KEY, STRIPE_PUB_KEY, STRIPE_CLIENT_ID } = process.env;

export const getStripePayouts = async (req: Request, res: Response) => {
  const { email } = req.query;
  try {
    const data = await tokenEntity.findOne({
      where: { email: email as string, isEnabled: true },
      include: tokens,
    });

    const arr = data.tokens.find((item) => item.token_type === 'stripe');

    if (!isEmpty(arr)) {
      let tokensFinalJson = { access_token: '', refresh_token: '' };

      if (!(await checkAccessTokenValidity(arr.access_token))) {
        console.log('goes here ==== ?');
        const result = await refreshAccessToken(email as string);
        tokensFinalJson = result;
      }

      const stripe = new Stripe(tokensFinalJson.access_token, { apiVersion: '2022-11-15' });
      const finalData = [];
      const payouts = await stripe.payouts.list();

      // For each payout, retrieve the associated charges
      for (const payout of payouts.data) {
        console.log(`Payout ID: ${payout.id}`);
        console.log(`Payout amount: ${payout.amount / 100} ${payout.currency}`);
        console.log(`Payout date: ${new Date(payout.created * 1000).toISOString()}`);

        const balanceTransactions = await stripe.balanceTransactions.list({ payout: payout.id });
        const arr = balanceTransactions.data.filter((item) => item.description !== 'STRIPE PAYOUT');
        const registrationPayout = arr.filter((item) => item.description.includes('Registration'));

        if (!isEmpty(arr)) {
          const totalFees = sumBy(arr, 'fee');
          const grossAmount = sumBy(arr, 'amount');
          const net = sumBy(arr, 'net');
          const date = fromUnixTime(payout.arrival_date);
          const payoutDate = format(date, 'M/d/yyyy');
          const nonGivingIncome = !isEmpty(registrationPayout) ? sumBy(registrationPayout, 'net') : 0;
          finalData.push({ totalFees, grossAmount, net, nonGivingIncome, payoutDate, data: arr });
        }
      }

      // const charge = await stripe.charges.list({ expand: ['data.balance_transaction'] });
      // const finalData = charge.data.filter(
      //   (a) => a.description.includes('Donation') || a.description.includes('Registration'),
      // );
      return responseSuccess(res, finalData);
      // return res.json('');
    }
    // return responseError({ res, code: 500, data: 'not found !' });
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

export const syncStripePayout = async (req: Request, res: Response) => {
  const { email, donationId, fundName, payoutDate } = req.query; //refreshToken is just an empty value
  try {
    const tokenEntity = await generatePcToken(email as string);
    const user = await User.findOne({
      where: { email: email as string },
    });

    if (isEmpty(tokenEntity)) {
      return responseError({ res, code: 202, data: 'PCO token is null' });
    }

    const { access_token } = tokenEntity;

    if (isEmpty(user)) {
      return responseError({ res, code: 500, data: 'Empty User' });
    }

    const userSettingsExist = await UserSettings.findOne({ where: { userId: user.id } });

    const config = {
      method: 'get',
      url: `https://api.planningcenteronline.com/giving/v2/donations/${donationId}`,
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    };

    const response = await axios(config);

    const settingsJson = userSettingsExist.dataValues.settingsData as any;
    const settingRegistration = settingsJson.find(
      (item: SettingsJsonProps) => item.fundName.toLowerCase() === String(fundName).toLowerCase(),
    );

    const accountRef = settingRegistration?.account?.value ?? '';
    const receivedFrom = settingRegistration?.customer?.value ?? '';
    const classRef = settingRegistration?.class?.value ?? '';

    const data = response.data.data;
    const finalData = [
      {
        ...data,
        payoutDate,
        accountRef,
        receivedFrom,
        classRef,
        batch: {
          id: `Stripe payout - ${payoutDate}`,
          attributes: {
            description: `Stripe payout ${data.attributes.created_at}`,
            created_at: data.attributes.created_at,
          },
        },
        paymentCheck: '',
      },
    ];
    const responsePayload = requestPayload(finalData);

    for (const payloadJson of responsePayload) {
      const batchIdF = finalData[0].batch.id;

      const synchedBatchesData = await UserSync.findAll({
        where: { userId: user.id, batchId: batchIdF as string },
        attributes: ['id', 'batchId', 'createdAt'],
      });

      if (isEmpty(synchedBatchesData)) {
        const bqoCreatedDataId = await automationDeposit(email as string, payloadJson);
        await UserSync.create({
          syncedData: finalData,
          userId: user.id,
          batchId: `Stripe payout - ${payoutDate}`,
          donationId: bqoCreatedDataId['Id'] || '',
        });
      }
    }

    return responseSuccess(res, 'success');
  } catch (e) {
    console.log('ERRO:::', e.response.data);
    if (e.response) return responseError({ res, code: 204, data: e.response.data.errors[0] });
    return responseError({ res, code: 500, data: e });
  }
};

export const syncStripePayoutRegistration = async (req: Request, res: Response) => {
  const { email, fundName, payoutDate, amount } = req.query; //refreshToken is just an empty value
  try {
    const user = await User.findOne({
      where: { email: email as string },
    });

    if (isEmpty(user)) {
      return responseError({ res, code: 500, data: 'Empty User' });
    }

    const userSettingsExist = await UserSettings.findOne({ where: { userId: user.id } });

    const settingsJson = userSettingsExist.dataValues.settingsData as any;
    const settingRegistration = settingsJson.find(
      (item: SettingsJsonProps) => item.fundName.toLowerCase() === String(fundName).toLowerCase(),
    );
    console.log('fundNamefasd', settingRegistration, fundName);
    const accountRef = settingRegistration?.account?.value ?? '';
    const receivedFrom = settingRegistration?.customer?.value ?? '';
    const classRef = settingRegistration?.class?.value ?? '';

    const now = new Date();
    const unixTimeNow = Math.floor(now.getTime() / 1000);
    // const data = response.data.data;
    const finalData = [
      {
        type: 'Donation',
        id: 'stripe_' + unixTimeNow,
        payoutDate,
        accountRef,
        receivedFrom,
        classRef,
        attributes: {
          amount_cents: amount,
          amount_currency: 'USD',
          completed_at: '2023-04-04T13:45:06Z',
          created_at: '2023-04-04T13:44:54Z',
          fee_cents: 0,
          fee_currency: 'USD',
          payment_brand: null,
          payment_check_dated_at: null,
          payment_check_number: null,
          payment_last4: null,
          payment_method: 'stripe',
          payment_method_sub: null,
          payment_status: 'succeeded',
          received_at: '2023-04-04T13:44:54Z',
          refundable: true,
          refunded: false,
          updated_at: '2023-04-04T13:45:06Z',
        },
        batch: {
          attributes: {
            description: `Stripe payout ${payoutDate}`,
            created_at: payoutDate,
          },
        },
        paymentCheck: '',
      },
    ];
    const responsePayload = requestPayload(finalData);

    for (const payloadJson of responsePayload) {
      const bqoCreatedDataId = await automationDeposit(email as string, payloadJson);
      const synchedBatchesData = await UserSync.findAll({
        where: { userId: user.id, batchId: `Stripe payout - ${payoutDate}` },
        attributes: ['id', 'batchId', 'createdAt'],
      });
      if (isEmpty(synchedBatchesData)) {
        await UserSync.create({
          syncedData: finalData,
          userId: user.id,
          batchId: `Stripe payout - ${payoutDate}`,
          donationId: bqoCreatedDataId['Id'] || '',
        });
      }
    }

    return responseSuccess(res, 'success');
  } catch (e) {
    if (e.response) return responseError({ res, code: 204, data: e.response.data.errors[0] });
    return responseError({ res, code: 204, data: e });
  }
};

const checkAccessTokenValidity = async (accessToken: string) => {
  try {
    const connectedStripe = new Stripe(accessToken, { apiVersion: '2022-11-15' });
    const account = await connectedStripe.accounts.retrieve('acct_yourAccountId');
    console.log('Account details:', account);
    return true;
  } catch (error) {
    console.error('Error fetching account details:', error);
    return false;
  }
};

// Add this function
const refreshAccessToken = async (email: string) => {
  const data = await tokenEntity.findOne({
    where: { email: email as string, isEnabled: true },
    include: tokens,
  });

  const arr = data.tokens.find((item) => item.token_type === 'stripe');

  try {
    const response = await axios.post('https://connect.stripe.com/oauth/token', {
      grant_type: 'refresh_token',
      client_id: STRIPE_CLIENT_ID,
      client_secret: STRIPE_SECRET_KEY,
      refresh_token: arr.refresh_token,
    });

    // console.log('New access token:', response.data.access_token);
    // console.log('New refresh token:', response.data.refresh_token);

    await tokens.update(
      { access_token: response.data.access_token, refresh_token: response.data.refresh_token },
      { where: { id: arr.id } },
    );

    return { access_token: response.data.access_token, refresh_token: response.data.refresh_token };
  } catch (error) {
    console.error('Error refreshing access token:', error);
    return null;
  }
};
