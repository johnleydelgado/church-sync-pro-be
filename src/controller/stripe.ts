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
import { SettingsJsonProps, newRequestPayload } from '../utils/mapping';
import axios from 'axios';
import tokens from '../db/models/tokens';
import tokenEntity from '../db/models/tokenEntity';
import { checkEmpty } from '../utils/helper';
const { PC_CLIENT_ID, PC_SECRET_APP, PC_REDIRECT, STRIPE_SECRET_KEY, STRIPE_PUB_KEY, STRIPE_CLIENT_ID } = process.env;

export interface SuccessToken {
  access_token: string;
  refresh_token: string;
}

interface StripeSyncData {
  [key: string]: FundData[] | undefined; // Index signature allowing dynamic keys
}

// The rest of the interfaces remain the same

interface BankData {
  type: string;
  label: string;
  value: string;
}

interface BatchData {
  amount: number;
  created: string;
  fundName: string;
  payoutDate: string;
  totalAmount: number;
  type: 'registration' | 'batch';
  totalFee?: number;
  selectedBankExpense?: string;
  description?: string;
  // Add more fields here if there are any other properties in batchData
}

interface FundData {
  bankData: BankData[];
  batchData: BatchData;
  email: string;
}

export const getStripePayouts = async (req: Request, res: Response) => {
  const { email, selectedDate, cPage } = req.query;

  const fSelectedDate: any = selectedDate;

  try {
    const data = await tokenEntity.findOne({
      where: { email: email as string, isEnabled: true },
      include: tokens,
    });

    const user = await User.findOne({
      where: { email: email as string },
    });

    const arr = data?.tokens.find((item) => item.token_type === 'stripe');

    const userSettingsExist = await UserSettings.findOne({ where: { userId: user.id } });
    const settingsJson = userSettingsExist.dataValues.settingRegistrationData as any;
    const settingsDataJson = userSettingsExist.dataValues.settingsData as any;

    if (arr && !isEmpty(arr)) {
      let tokensFinalJson: { access_token: string; refresh_token: string } = { access_token: '', refresh_token: '' };

      if (arr.access_token && !(await checkAccessTokenValidity(arr.access_token))) {
        console.log('Refreshing access token');
        const result = await refreshAccessToken(email as string);
        if (result && 'access_token' in result) {
          tokensFinalJson = result as SuccessToken;
        } else {
          console.log('Failed to refresh access token, error:', result.error);
          return responseError({ res, code: 500, data: 'Failed to refresh access_token' });
        }
      } else {
        tokensFinalJson = { access_token: arr.access_token, refresh_token: arr.refresh_token };
      }

      if (tokensFinalJson.access_token) {
        const stripe = new Stripe(tokensFinalJson.access_token, { apiVersion: '2023-10-16' });
        const finalData = [];
        let payouts = [];
        let hasMore = true;
        let startingAfter = null;

        while (hasMore) {
          let params = {
            limit: 100,
            created: {
              // Set the starting date to January 1st, 2023
              gte: new Date(fSelectedDate).getTime() / 1000,
            },
          };

          // Add 'starting_after' parameter only if it's not null
          if (startingAfter) {
            params['starting_after'] = startingAfter;
          }

          const response = await stripe.payouts.list(params);

          payouts = payouts.concat(response.data);
          hasMore = response.has_more;

          if (hasMore && response.data.length) {
            // Set the last object's ID of the current batch as the starting point for the next call
            startingAfter = response.data[response.data.length - 1].id;
          } else {
            // In case there are no more items, break out of the loop
            hasMore = false;
          }
        }

        // const newPayouts = allPayouts.sort((a, b) => (a.id > b.id ? 1 : -1));
        // For each payout, retrieve the associated charges
        for (const payout of payouts) {
          console.log(`Payout ID: ${payout.id}`);
          console.log(`Payout amount: ${payout.amount / 100} ${payout.currency}`);
          console.log(`Payout date: ${new Date(payout.created * 1000).toISOString()}`);

          const balanceTransactions = await stripe.balanceTransactions.list({ payout: payout.id });
          const arr = balanceTransactions.data.filter((item) => item.description !== 'STRIPE PAYOUT');

          // let clonedArr = [];

          // for (let i = 0; i < 40; i++) {
          //   arr.forEach((element) => {
          //     let elementCopy = Object.assign({}, element); // Make a deep copy of the element first
          //     clonedArr.push(elementCopy);
          //   });
          // }

          // const clonedElements = arr.slice(0, 2);

          // // // Append cloned elements back to the array using push() in a loop
          // clonedElements.forEach((element) => {
          //   let elementCopy = Object.assign({}, element); // Make a deep copy of the element first
          //   if (elementCopy.description.includes('General')) {
          //     // Modify the copy's description when condition is met
          //     elementCopy.description = `Donation #217485341 - Sarah Ratliff - General ($1000)`;
          //   }
          //   // Push the modified copy to the array
          //   arr.push(elementCopy);
          // });
          const newArr = removeDuplicatesAndSumAmount(arr);

          const registrationPayout = newArr.filter((item) => item.description.includes('Registration'));
          let isOneOfRegistrationDeactivated = !isEmpty(
            newArr.filter((c) => settingsJson?.some((a) => c.description.includes(a.registration) && !a.isActive)),
          );

          // const activeClassValues = arr.filter((item) => {
          //   const isActiveInSettingsJson = settingsJson?.some(
          //     (x) => item.description.includes(x.registration) && x.isActive,
          //   );

          //   const isPresentInSettingsDataJson = settingsDataJson?.some((x) => item.description.includes(x.fundName));

          //   const isInactiveInSettingsJson = settingsJson?.some(
          //     (x) => item.description.includes(x.registration) && !x.isActive,
          //   );

          //   const returnIs =
          //     (isActiveInSettingsJson || isPresentInSettingsDataJson) &&
          //     !isInactiveInSettingsJson &&
          //     !isOneOfRegistrationDeactivated;

          //   return returnIs;
          // });

          if (!isEmpty(newArr)) {
            const totalFees = sumBy(newArr, 'fee');
            const grossAmount = sumBy(newArr, 'amount');
            const net = sumBy(newArr, 'net');
            const date = fromUnixTime(payout.arrival_date);
            const payoutDate = format(date, 'M/d/yyyy');

            const startDate = new Date(fSelectedDate);
            const endDate = new Date();
            endDate.setHours(23, 59, 59, 999);

            const created_at = new Date(payoutDate);
            const isDateValid = created_at >= startDate && created_at <= endDate;
            const nonGivingIncome = !isEmpty(registrationPayout) ? sumBy(registrationPayout, 'net') : 0;

            if (isDateValid) {
              finalData.push({
                totalFees,
                grossAmount,
                net,
                nonGivingIncome,
                payoutDate,
                data: newArr,
                // lastObjectId: fLastObjectId,
              });
            }
          }
        }
        return responseSuccess(res, finalData);
      } else {
        return responseError({ res, code: 500, data: 'No access_token available' });
      }
    } else {
      return responseError({ res, code: 500, data: 'Token not found!' });
    }
  } catch (e) {
    console.log('Exception caught:', e);
    return responseError({ res, code: 500, data: e });
  }
};

export const syncStripePayout = async (req: Request, res: Response) => {
  const { email, donationId, fundName, payoutDate, bankData } = req.body; //refreshToken is just an empty value

  const bank = bankData as
    | {
        type: 'donation' | 'registration';
        value: string;
        label: string;
      }[]
    | null;

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
    const bankRef = bank?.find((a) => a.type === 'registration') || {};
    const data = response.data.data;

    const donationDate = data.attributes.created_at ? new Date(data.attributes.created_at) : new Date();

    const TxnDate = format(donationDate, 'yyyy-MM-dd');

    const finalData = [
      {
        ...data,
        TxnDate,
        payoutDate,
        accountRef,
        receivedFrom,
        classRef,
        batch: {
          id: `Stripe payout - ${email} - ${payoutDate}`,
          attributes: {
            description: `Stripe payout - ${data.attributes.created_at}`,
            created_at: data.attributes.created_at,
          },
        },
        paymentCheck: '',
        bankRef,
      },
    ];

    const responsePayload = newRequestPayload(finalData);
    const batchIdF = finalData[0].batch.id;

    const synchedBatchesData = await UserSync.findAll({
      where: { userId: user.id, batchId: batchIdF as string },
      attributes: ['id', 'batchId', 'createdAt'],
    });

    if (isEmpty(synchedBatchesData)) {
      const bqoCreatedDataId = await automationDeposit(email as string, responsePayload);
      await UserSync.create({
        syncedData: finalData,
        userId: user.id,
        batchId: `Stripe payout - ${email} - ${payoutDate}`,
        donationId: bqoCreatedDataId['Id'] || '',
      });
    }

    return responseSuccess(res, 'success');
  } catch (e) {
    console.log('ERRO:::', e);
    if (e.response) return responseError({ res, code: 500, data: e });
    return responseError({ res, code: 500, data: e });
  }
};

export const syncStripePayoutRegistration = async (req: Request, res: Response) => {
  const { email, fundName, payoutDate, amount, bankData } = req.body; //refreshToken is just an empty value
  const bank = bankData as
    | {
        type: 'donation' | 'registration';
        value: string;
        label: string;
      }[]
    | null;
  try {
    const user = await User.findOne({
      where: { email: email as string },
    });

    if (isEmpty(user)) {
      return responseError({ res, code: 500, data: 'Empty User' });
    }

    const userSettingsExist = await UserSettings.findOne({ where: { userId: user.id } });

    const settingsJson = userSettingsExist.dataValues.settingRegistrationData as any;
    const settingRegistration = settingsJson.find(
      (item: { class: { label: string } }) => item.class.label.toLowerCase() === String(fundName).toLowerCase(),
    );

    const accountRef = settingRegistration?.account?.value ?? '';
    const receivedFrom = settingRegistration?.customer?.value ?? '';
    const classRef = settingRegistration?.class?.value ?? '';

    const now = new Date();
    const unixTimeNow = Math.floor(now.getTime() / 1000);
    const bankRef = bank?.find((a) => a.type === 'registration') || {};

    const donationDate = payoutDate ? new Date(payoutDate) : new Date();

    const TxnDate = format(donationDate, 'yyyy-MM-dd');
    // const data = response.data.data;
    const finalData = [
      {
        type: 'Donation',
        id: 'stripe_' + unixTimeNow,
        payoutDate,
        accountRef,
        receivedFrom,
        classRef,
        TxnDate,
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
        bankRef,
      },
    ];

    const responsePayload = newRequestPayload(finalData);
    const bqoCreatedDataId = await automationDeposit(email as string, responsePayload);
    const synchedBatchesData = await UserSync.findAll({
      where: { userId: user.id, batchId: `Stripe payout - ${email} - ${payoutDate}` },
      attributes: ['id', 'batchId', 'createdAt'],
    });
    if (isEmpty(synchedBatchesData)) {
      await UserSync.create({
        syncedData: finalData,
        userId: user.id,
        batchId: `Stripe payout - ${email} - ${payoutDate}`,
        donationId: bqoCreatedDataId['Id'] || '',
      });
    }

    return responseSuccess(res, 'success');
  } catch (e) {
    if (e.response) return responseError({ res, code: 500, data: e });
    return responseError({ res, code: 500, data: e });
  }
};

export const finalSyncStripe = async (req: Request, res: Response) => {
  const { data } = req.body; //refreshToken is just an empty valuec
  const batchData: StripeSyncData = data;
  try {
    let finalData: any = [];
    const keys = Object.keys(batchData);

    for (const key of keys) {
      // console.log(`Key: ${key}, Value: ${batchData[key]}`);
      const promises = batchData[key].map(async (batchItem) => {
        if (key !== 'Charge') {
          const tokenEntity = await generatePcToken(batchItem.email as string);
          const user = await User.findOne({
            where: { email: batchItem.email as string },
          });

          if (isEmpty(tokenEntity)) {
            return responseError({ res, code: 202, data: 'PCO token is null' });
          }

          if (isEmpty(user)) {
            return responseError({ res, code: 500, data: 'Empty User' });
          }

          const userSettingsExist = await UserSettings.findOne({ where: { userId: user.id } });

          const settingsJson = userSettingsExist.settingsData as any;
          const settingRegistrationJson = userSettingsExist.settingRegistrationData as any;

          let settingRegistration: any;

          if (batchItem.batchData.type === 'batch') {
            settingRegistration = settingsJson.find(
              (item: SettingsJsonProps) =>
                item.fundName?.toLowerCase() === String(batchItem.batchData.fundName).toLowerCase(),
            );
          } else {
            settingRegistration = settingRegistrationJson.find(
              (item: { class: { label: string } }) =>
                item.class?.label?.toLowerCase() === String(batchItem.batchData.fundName).toLowerCase(),
            );
          }

          if (batchItem.batchData.description) {
            const isRegistrationNameExist = settingRegistrationJson?.find(
              (item: { registration: string }) =>
                item?.registration?.toLowerCase() === String(batchItem.batchData.description).toLowerCase(),
            );

            const isRegistrationActive = settingRegistrationJson?.find((item: { isActive: boolean }) => item?.isActive);

            if (!isRegistrationNameExist) {
              throw new Error(`Settings for registration name "${batchItem.batchData.description}" not found.`);
            }

            if (!isRegistrationActive) {
              throw new Error(`Settings for registration name "${batchItem.batchData.description}" is Deactivated`);
            }
          }

          if (checkEmpty(settingRegistration)) {
            throw new Error(`Settings for fund name "${batchItem.batchData.fundName}" not found.`);
          }

          const accountRef = settingRegistration?.account?.value ?? '';
          const receivedFrom = settingRegistration?.customer?.value ?? '';
          const classRef = settingRegistration?.class?.value ?? '';

          const bankRef = batchItem.bankData.find((a) => a.type === 'registration') || {};
          const donationDate = batchItem.batchData.payoutDate ? new Date(batchItem.batchData.payoutDate) : new Date();

          const TxnDate = format(donationDate, 'yyyy-MM-dd');
          finalData.push({
            TxnDate,
            payoutDate: batchItem.batchData.payoutDate,
            accountRef,
            receivedFrom,
            classRef,
            batch: {
              id: `Stripe payout - ${user.email} - ${batchItem.batchData.payoutDate}`,
              attributes: {
                description: `Stripe payout ${batchItem.batchData.payoutDate}`,
                created_at: batchItem.batchData.payoutDate,
                total_cents: batchItem.batchData.totalAmount,
              },
            },
            paymentCheck: '',
            bankRef,
            attributes: { payment_method: 'Stripe', amount_cents: batchItem.batchData.amount },
            other: { email: batchItem.email, payoutDate: batchItem.batchData.payoutDate, userId: user.id },
          });
        } else {
          const tokenEntity = await generatePcToken(batchItem.email as string);
          const user = await User.findOne({
            where: { email: batchItem.email as string },
          });

          if (isEmpty(tokenEntity)) {
            return responseError({ res, code: 202, data: 'PCO token is null' });
          }

          if (isEmpty(user)) {
            return responseError({ res, code: 500, data: 'Empty User' });
          }

          const userSettingsExist = await UserSettings.findOne({ where: { userId: user.id } });

          const settingBankChargesJson = userSettingsExist.settingBankCharges as any;

          const settingRegistrationJson = userSettingsExist.settingRegistrationData as any;

          if (checkEmpty(settingRegistrationJson)) {
            throw new Error(
              `Please ensure that your settings are configured correctly, as some registrations appear to be incomplete.`,
            );
          }

          const accountRef = settingBankChargesJson?.account?.value ?? '';
          const receivedFrom = '';
          const classRef = settingBankChargesJson?.class?.value ?? '';

          const bankRef = batchItem.bankData.find((a) => a.type === 'registration') || {};
          const donationDate = batchItem.batchData.payoutDate ? new Date(batchItem.batchData.payoutDate) : new Date();

          const TxnDate = format(donationDate, 'yyyy-MM-dd');
          finalData.push({
            TxnDate,
            payoutDate: batchItem.batchData.payoutDate,
            accountRef,
            receivedFrom,
            classRef,
            batch: {
              id: `Stripe payout - ${user.email} - ${batchItem.batchData.payoutDate}`,
              attributes: {
                description: `Stripe payout ${batchItem.batchData.payoutDate}`,
                created_at: batchItem.batchData.payoutDate,
                total_cents: batchItem.batchData.totalAmount,
              },
            },
            paymentCheck: '',
            bankRef,
            attributes: { payment_method: 'Stripe', amount_cents: -batchItem.batchData.totalFee },
            other: { email: batchItem.email, payoutDate: batchItem.batchData.payoutDate, userId: user.id },
          });
        }
      });
      await Promise.all(promises);
    }

    const responsePayload = newRequestPayload(finalData);
    const bqoCreatedDataId = await automationDeposit(finalData[0]?.other?.email as string, responsePayload);
    const synchedBatchesData = await UserSync.findAll({
      where: {
        userId: finalData[0].other.userId,
        batchId: `Stripe payout - ${finalData[0]?.other?.email} -  ${finalData[0]?.other?.payoutDate}`,
      },
      attributes: ['id', 'batchId', 'createdAt'],
    });
    if (isEmpty(synchedBatchesData)) {
      await UserSync.create({
        syncedData: finalData,
        userId: finalData[0]?.other?.userId,
        batchId: `Stripe payout - ${finalData[0]?.other?.email} - ${finalData[0]?.other?.payoutDate}`,
        donationId: bqoCreatedDataId['Id'] || '',
      });
    }
    return responseSuccess(res, 'success');
  } catch (e) {
    if (e.Fault) return responseError({ res, code: 404, message: e.Fault.Error[0].Message });
    return responseError({ res, code: 404, message: e.message || 'Error' });
  }
};

export const checkAccessTokenValidity = async (accessToken: string) => {
  try {
    const connectedStripe = new Stripe(accessToken, { apiVersion: '2023-10-16' });
    const account = await connectedStripe.accounts.retrieve(); // Replace with actual Account ID
    // console.log('Account details:', account);
    return true;
  } catch (error) {
    console.error('Error fetching account details:', error);
    return false;
  }
};

type RefreshTokenResult =
  | { access_token: string; refresh_token: string; error?: never }
  | { error: string; access_token?: never; refresh_token?: never };

export const refreshAccessToken = async (email: string): Promise<RefreshTokenResult> => {
  try {
    const data = await tokenEntity.findOne({
      where: { email: email as string, isEnabled: true },
      include: tokens,
    });

    if (!data || !data.tokens) {
      console.error('Data or tokens not found');
      return { error: 'Data or tokens not found' };
    }

    const arr = data.tokens.find((item) => item.token_type === 'stripe');

    if (!arr || !arr.refresh_token) {
      console.error('Refresh token not found');
      return { error: 'Refresh token not found' };
    }

    const response = await axios.post('https://connect.stripe.com/oauth/token', {
      grant_type: 'refresh_token',
      client_id: STRIPE_CLIENT_ID,
      client_secret: STRIPE_SECRET_KEY,
      refresh_token: arr.refresh_token,
    });

    await tokens.update(
      { access_token: response.data.access_token, refresh_token: response.data.refresh_token },
      { where: { id: arr.id } },
    );

    return { access_token: response.data.access_token, refresh_token: response.data.refresh_token };
  } catch (error) {
    console.error('Error refreshing access token:', error);
    return { error: 'Error refreshing access token' };
  }
};

export const removeDuplicatesAndSumAmount = (arr: any[]) => {
  let uniqueArr: any[] = [];
  let sumAmounts: { [key: string]: number } = {};
  let sumNets: { [key: string]: number } = {};
  let sumStripeFees: { [key: string]: number } = {};

  let uniqueDescriptions: { [key: string]: boolean } = {};

  arr.forEach((item) => {
    const parts = item.description.split('-').map((part) => part.trim());
    let category;

    if (/\(\$.*\)$/.test(parts[parts.length - 1])) {
      if (parts.length === 3 && /\(.*\)$/.test(parts[2])) {
        category = parts[2].replace(/\s*\(.*\)$/, '');
      } else {
        category = parts.slice(0, -1).join(' - ');
        category = category.split(' - ').slice(2).join(' - ');
      }
    } else {
      category = parts.slice(2).join(' - ');
    }

    if (!uniqueDescriptions[category]) {
      uniqueDescriptions[category] = true;
      sumAmounts[category] = item.amount;
      sumNets[category] = item.net;
      sumStripeFees[category] = item.fee;
      // Push the item without altering its description
      uniqueArr.push(item);
    } else {
      // Aggregate amounts and nets for duplicates without altering descriptions
      sumAmounts[category] += item.amount;
      sumNets[category] += item.net;
      sumStripeFees[category] += item.fee;
    }
  });

  // There's no need to map through uniqueArr to update descriptions since we're keeping them unchanged
  // Instead, ensure that the amount and net are correctly updated for items based on their category

  return uniqueArr.map((item) => {
    const parts = item.description.split('-').map((part) => part.trim());
    // Determine the category the same way as before to find the updated amounts and nets
    let category;
    if (/\(\$.*\)$/.test(parts[parts.length - 1])) {
      if (parts.length === 3 && /\(.*\)$/.test(parts[2])) {
        category = parts[2].replace(/\s*\(.*\)$/, '');
      } else {
        category = parts.slice(0, -1).join(' - ');
        category = category.split(' - ').slice(2).join(' - ');
      }
    } else {
      category = parts.slice(2).join(' - ');
    }

    // Update the item's amount and net to the aggregated values
    item.amount = sumAmounts[category];
    item.net = sumNets[category];
    item.fee = sumStripeFees[category];
    return item; // Return the item with updated amount and net but original description
  });
};
