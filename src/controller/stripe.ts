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
const { PC_CLIENT_ID, PC_SECRET_APP, PC_REDIRECT, STRIPE_SECRET_KEY, STRIPE_PUB_KEY, STRIPE_CLIENT_ID } = process.env;

export const getStripePayouts = async (req: Request, res: Response) => {
  const { email } = req.query;
  try {
    const user = await User.findOne({ where: { email: email as string } });

    if (user) {
      let userJson = user.toJSON();

      if (!(await checkAccessTokenValidity(userJson.access_token_stripe))) {
        console.log('goes here ==== ?');
        const userResult = await refreshAccessToken(email as string);
        userJson = userResult;
      }

      const stripe = new Stripe(userJson.access_token_stripe, { apiVersion: '2022-11-15' });
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
  const { email, donationId, fundName, payoutDate, refreshToken } = req.query; //refreshToken is just an empty value
  try {
    const user = await generatePcToken(refreshToken as string, email as string);

    if (isEmpty(user)) {
      return responseError({ res, code: 500, data: 'Empty User' });
    }

    const userSettingsExist = await UserSettings.findOne({ where: { userId: user.id } });

    const config = {
      method: 'get',
      url: `https://api.planningcenteronline.com/giving/v2/donations/${donationId}`,
      headers: {
        Authorization: `Bearer ${user.access_token_pc}`,
      },
    };
    const response = await axios(config);

    const settingsJson = userSettingsExist.dataValues.settingsData as any;
    const settingsItem = settingsJson.find(
      (item: SettingsJsonProps) => item.fundName.toLowerCase() === String(fundName).toLowerCase(),
    );

    const accountRef = settingsItem?.account?.value ?? '';
    const receivedFrom = settingsItem?.customer?.value ?? '';
    const classRef = settingsItem?.class?.value ?? '';

    const data = response.data.data;
    const finalData = [
      {
        ...data,
        payoutDate,
        accountRef,
        receivedFrom,
        classRef,
        batch: {
          attributes: {
            description: `Stripe payout ${data.attributes.created_at}`,
            created_at: data.attributes.created_at,
          },
        },
      },
    ];
    const responsePayload = requestPayload(finalData);

    for (const payloadJson of responsePayload) {
      await automationDeposit(email as string, payloadJson);
      await UserSync.create({
        syncedData: finalData,
        userId: user.id,
        batchId: `Stripe payout - ${payoutDate}`,
      });
    }

    return responseSuccess(res, 'success');
  } catch (e) {
    if (e.response) return responseError({ res, code: 500, data: e.response.data.errors[0] });
    return responseError({ res, code: 500, data: e });
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
  const user = (await User.findOne({ where: { email: email } })).toJSON();

  try {
    const response = await axios.post('https://connect.stripe.com/oauth/token', {
      grant_type: 'refresh_token',
      client_id: STRIPE_CLIENT_ID,
      client_secret: STRIPE_SECRET_KEY,
      refresh_token: user.refresh_token_stripe,
    });

    // console.log('New access token:', response.data.access_token);
    // console.log('New refresh token:', response.data.refresh_token);

    await User.update(
      { access_token_stripe: response.data.access_token, refresh_token_stripe: response.data.refresh_token },
      { where: { email: email } },
    );
    const updatedUser = (await User.findOne({ where: { email: email } })).toJSON();
    return updatedUser;
  } catch (error) {
    console.error('Error refreshing access token:', error);
    return null;
  }
};
