/* eslint-disable @typescript-eslint/no-explicit-any */
import User, { UserAttributes } from '../db/models/user';
import quickBookApi, { tokenProps } from '../utils/quickBookApi';
import quickbookAuth from '../utils/quickbookAuth';
import axios from 'axios';
import { isEmpty, omit, sumBy } from 'lodash';
const { PC_CLIENT_ID, PC_SECRET_APP, QBO_KEY, QBO_SECRET } = process.env;
import { format, fromUnixTime, isSameDay, isToday, isWithinInterval, parseISO, startOfToday, subDays } from 'date-fns';
import { zonedTimeToUtc } from 'date-fns-tz';

import UserSettings from '../db/models/userSettings';
import { SettingsJsonProps, newRequestPayload } from '../utils/mapping';
import UserSync, { UserSyncAttributes } from '../db/models/UserSync';
import { Op } from 'sequelize';
import { checkEmpty, getDayBoundary } from '../utils/helper';
import tokenEntity from '../db/models/tokenEntity';
import tokens from '../db/models/tokens';
import { responseError, responseSuccess } from '../utils/response';
import { getBatchInDonationPCO, isAccessTokenValidPCO } from './planning-center';
import { Request, Response } from 'express';
import { SuccessToken, checkAccessTokenValidity, refreshAccessToken, removeDuplicatesAndSumAmount } from './stripe';
import Stripe from 'stripe';
import userEmailPreferences from '../db/models/userEmailPreferences';
import { dailySyncing, dailySyncingRegistration } from '../utils/automation-helper';
import { id } from 'date-fns/locale';

const { SENDGRID_API_KEY, SETTING_FUND_URL } = process.env;

const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(SENDGRID_API_KEY);

interface PaymentMethodsResponse {
  QueryResponse: {
    PaymentMethod: Array<{
      Id: string;
      Name: string;
      // Add other properties as needed
    }>;
  };
}
const base64encode = (str) => Buffer.from(str).toString('base64');

export const generateQBOToken = async (refreshToken: string, email: string) => {
  // if (!oauthClient.isAccessTokenValid()) {
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
  } catch (error) {
    console.log('====ERROR:====', error);
  }
};

export const getallUsers = async () => {
  try {
    const users = await User.findAll();
    users.map(async (item: UserAttributes) => {
      const userSettingsExist = await UserSettings.findOne({ where: { userId: item.id } });
      const userSyncData = await UserSync.findAll({
        where: {
          userId: item.id,
          createdAt: {
            [Op.between]: [getDayBoundary(0, 0, 0, 0), getDayBoundary(23, 59, 59, 999)],
          },
        },
      });

      if (userSettingsExist) {
        // only automate if setting is exist
        if (userSettingsExist.isAutomationEnable) {
          const tokenEntity = await generatePcToken(String(item.email));
          const { access_token } = tokenEntity;
          if (access_token) {
            // // await generateQBOToken(item.refresh_token_qbo, item.email);
            await generateTodayBatches({
              userId: item.id,
              email: item.email,
              access_token: access_token,
              settingsJson: userSettingsExist.settingsData,
              syncedData: userSyncData,
            });
          }
        }
      }
    });
  } catch (e) {}
};

export const getFundInDonation = async ({ donationId, access_token }: { donationId: number; access_token: string }) => {
  const config = {
    headers: {
      Authorization: `Bearer ${access_token}`,
    },
  };
  try {
    const url = `https://api.planningcenteronline.com/giving/v2/donations/${donationId}/designations`;
    const getDesignation = await axios.get(url, config);
    const dataDesignation = getDesignation.data;

    if (isEmpty(dataDesignation.data)) {
      //return empty here
      return [];
    }

    const fundId = dataDesignation.data[0].relationships.fund.data.id;

    const urlFund = `https://api.planningcenteronline.com/giving/v2/funds?where[id]=${fundId}`;
    const getFound = await axios.get(urlFund, config);
    return getFound.data.data;
  } catch (e) {
    return [];
  }
};

export const getBatchInDonation = async ({
  access_token,
  syncedData,
}: {
  access_token: string;
  syncedData: UserSyncAttributes[];
}) => {
  const config = {
    headers: {
      Authorization: `Bearer ${access_token}`,
    },
  };
  try {
    const url = `https://api.planningcenteronline.com/giving/v2/batches?filter=committed`;
    const getBatchesRes = await axios.get(url, config);
    const tempData = getBatchesRes.data.data;

    if (isEmpty(tempData)) {
      return [];
    }

    const data = tempData.filter((item) => {
      const created_at = parseISO(item.attributes.created_at);
      return isEmpty(syncedData.find((a) => a.batchId === item.id)) && isSameDay(created_at, startOfToday());
    });

    return data;
  } catch (e) {
    return [];
  }
};

export const generateTodayBatches = async ({
  userId,
  email,
  access_token,
  settingsJson,
  syncedData,
}: {
  userId: number;
  email: string;
  access_token: string;
  settingsJson: any;
  syncedData: any;
}) => {
  const config = {
    headers: {
      Authorization: `Bearer ${access_token}`,
    },
  };

  const jsonRes = { donation: [] as any }; //this is an array object

  try {
    // get todays batches
    const batchesData = await getBatchInDonation({ access_token: String(access_token), syncedData });
    for (const dataOfBatches of batchesData) {
      // get donation per batch
      const donationUrl = `https://api.planningcenteronline.com/giving/v2/batches/${dataOfBatches.id}/donations`;
      const responseDonation = await axios.get(donationUrl, config);
      // jsonRes.donation = {...jsonRes.donation, responseDonation.data.data}
      for (const donationsData of responseDonation.data.data) {
        const fundsData = await getFundInDonation({
          donationId: Number(donationsData.id),
          access_token: String(access_token),
        });
        const fundName = fundsData[0].attributes.name;
        const settingsItem = settingsJson.find((item: SettingsJsonProps) => item.fundName === fundName);
        const accountRef = settingsItem?.account?.value ?? '';
        const receivedFrom = settingsItem?.customer?.value ?? '';
        const classRef = settingsItem?.class?.value ?? '';
        const donationDate = donationsData?.attributes?.completed_at
          ? new Date(donationsData?.attributes?.completed_at)
          : new Date();

        const TxnDate = format(donationDate, 'yyyy-MM-dd');

        jsonRes.donation = [
          ...jsonRes.donation,
          {
            ...donationsData,
            fund: fundsData[0] || {},
            batch: dataOfBatches,
            accountRef,
            receivedFrom,
            classRef,
            TxnDate,
          },
        ];
      }
    }

    if (!isEmpty(jsonRes.donation)) {
      const data = newRequestPayload(jsonRes.donation);
      await automationDeposit(email, data);
      await UserSync.create({ syncedData: jsonRes.donation, userId, batchId: jsonRes.donation[0].batch.id });
    }
  } catch (e) {
    console.log('generate data', e);
  }
};

export const automationDeposit = async (email: string, jsonArr: any) => {
  const data = await tokenEntity.findOne({
    where: { email: email as string, isEnabled: true },
    include: tokens,
  });

  const arr = data.tokens.find((item) => item.token_type === 'qbo');

  let tokenJson = { access_token: arr.access_token, refresh_token: arr.refresh_token, realm_id: arr.realm_id };

  if (!quickbookAuth.isAccessTokenValid()) {
    const result = await generateQBOToken(arr.refresh_token, email);
    tokenJson = result;
  }

  const qboTokens = {
    ACCESS_TOKEN: tokenJson.access_token,
    REALM_ID: tokenJson.realm_id,
    REFRESH_TOKEN: tokenJson.refresh_token,
  };

  try {
    const paymentMethods = await new Promise<PaymentMethodsResponse>((resolve, reject) => {
      quickBookApi(qboTokens).findPaymentMethods({}, function (err, paymentMethods) {
        if (err) {
          reject(err);
        } else {
          resolve(paymentMethods);
        }
      });
    });

    // if (!isEmpty(paymentMethods)) {
    //   const paymentMethodsList = paymentMethods.QueryResponse.PaymentMethod;
    //   const tempPayment =
    //     fJson.tempPaymentMethod.toLowerCase() === 'stripe' ? 'visa' : fJson.tempPaymentMethod.toLowerCase();
    //   const paymentMethod = paymentMethodsList.find((el) => el.Name.toLowerCase() === tempPayment);
    //   fJson.Line[0].DepositLineDetail.PaymentMethodRef = { value: paymentMethod.Id };

    //   fJson = omit(fJson, 'tempPaymentMethod');
    // }

    if (!isEmpty(paymentMethods)) {
      jsonArr.Line.forEach((line) => {
        paymentMethods.QueryResponse.PaymentMethod.forEach((method) => {
          if (method.Name.toLowerCase() === line.tempPaymentMethod.toLowerCase()) {
            line.DepositLineDetail.PaymentMethodRef = { value: method.Id };
          }
        });
        delete line.tempPaymentMethod;
      });
    }
    return new Promise(async (resolve, reject) => {
      await quickBookApi(qboTokens).createDeposit(jsonArr, function (err, createdData) {
        if (err) {
          reject(err);
        }

        const data = isEmpty(createdData) ? [] : createdData;
        resolve(data);
      });
    });
  } catch (err) {
    console.log('automationDeposit ERROR:', err);
    throw new Error(err);
  }

  // try {
  //   await createDepositInQBO();
  // } catch (err) {}
};

export const generatePcToken = async (email: string) => {
  let refresh_token = '';

  try {
    const data = await tokenEntity.findOne({
      where: { email: email as string, isEnabled: true },
      include: tokens,
    });

    const arr = data.tokens.find((item) => item.token_type === 'pco');

    if (isEmpty(arr)) {
      throw new Error('Not found !');
    }

    if (!refresh_token) {
      refresh_token = arr.refresh_token;
    }

    if (await isAccessTokenValidPCO({ accessToken: arr.access_token as string })) {
      console.log('pco token still valid !');
      return { access_token: arr.access_token, refresh_token: arr.refresh_token };
    }

    console.log('refresh token is 1: ', refresh_token);

    const response = await axios({
      method: 'post',
      url: 'https://api.planningcenteronline.com/oauth/token',
      headers: {
        'Content-Type': 'application/json',
      },
      data: {
        client_id: PC_CLIENT_ID,
        client_secret: PC_SECRET_APP,
        refresh_token,
        grant_type: 'refresh_token',
      },
    });

    console.log('refresh token is: ', refresh_token, response.data);

    await tokens.update(
      { access_token: response.data.access_token, refresh_token: response.data.refresh_token },
      { where: { id: arr.id } },
    );

    // Retrieve the updated user data
    // const updatedUser = (await User.findOne({ where: { email: email } })).toJSON();
    return { access_token: response.data.access_token, refresh_token: response.data.refresh_token };
  } catch (error) {
    // await tokens.destroy({ where: { id: tokenEntityId } });
    throw new Error('invalid refresh token');
  }
};

export const automationScheduler = async (req: Request, res: Response) => {
  try {
    await getallUsers();
    return responseSuccess(res, 'Sync completed');
  } catch (err) {
    // handle error here, perhaps by sending an error response
    console.error(err);
    return res.status(500).json({ error: 'An error occurred' });
  }
};

export const latestFundAutomation = async (req: Request, res: Response) => {
  try {
    const users = await User.findAll({
      include: [UserSettings, tokens],
    });

    const promises = [];

    for (const a of users) {
      if (
        !isEmpty(a.UserSetting) &&
        !checkEmpty(a.UserSetting.settingBankData) &&
        a.UserSetting.startDateAutomationFund &&
        a.UserSetting.isAutomationEnable &&
        a.role === 'client'
      ) {
        const tokenEntity = await generatePcToken(a.email as string);
        const { access_token } = tokenEntity;
        const config = {
          method: 'get',
          url: 'https://api.planningcenteronline.com/giving/v2/batches?per_page=50&order=-updated_at&filter=committed',
          headers: {
            Authorization: `Bearer ${access_token}`,
          },
        };

        // Note: axios call is outside of the inner map to ensure proper handling of async operations
        const response = await axios(config);

        // Collect promises from map() operation
        const innerPromises = response.data.data
          .filter((item) => {
            const start_date = new Date(a.UserSetting.startDateAutomationFund);
            const end_date = new Date(); // Today's date
            const created_at = parseISO(item.attributes.created_at);
            return isWithinInterval(created_at, { start: start_date, end: end_date });
          })
          .map((item) => dailySyncing(a, item, item.id, `${item.id} - ${a.email}`, a.UserSetting.settingBankData));

        // Add all inner promises to the main promises array
        promises.push(...innerPromises);
      }
    }

    // Wait for all promises to resolve
    await Promise.all(promises);

    return responseSuccess(res, 'Sync completed');
  } catch (err) {
    // handle error here, perhaps by sending an error response
    console.error(err);
    return res.status(500).json({ error: 'An error occurred' });
  }
};

export const latestRegistrationAutomation = async (req: Request, res: Response) => {
  try {
    const users = await User.findAll({
      include: [UserSettings, tokens],
    });

    let stripeData = [];

    for (const a of users) {
      if (
        !isEmpty(a.UserSetting) &&
        !checkEmpty(a.UserSetting.settingBankData) &&
        a.UserSetting.startDateAutomationRegistration &&
        a.UserSetting.isAutomationRegistration &&
        a.role === 'client'
      ) {
        const arr = a?.tokens.find((item) => item.token_type === 'stripe');
        const fSelectedDate = new Date(a.UserSetting.startDateAutomationRegistration);
        try {
          const tokenEntity = await generatePcToken(a.email as string);
          const { access_token: access_tokenPCO } = tokenEntity;
          if (arr && !isEmpty(arr)) {
            let tokensFinalJson: { access_token: string; refresh_token: string } = {
              access_token: '',
              refresh_token: '',
            };

            const config = {
              method: 'get',
              url: 'https://api.planningcenteronline.com/giving/v2/funds',
              headers: {
                Authorization: `Bearer ${access_tokenPCO}`,
              },
            };

            const response = await axios(config);

            const filterFundName = response.data?.data?.map(
              (item: { id: string; attributes: { name: string; description: string } }) => item.attributes.name,
            );

            if (arr.access_token && !isEmpty(filterFundName) && !(await checkAccessTokenValidity(arr.access_token))) {
              console.log('Refreshing access token');
              const result = await refreshAccessToken(a.email as string);
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
              const payouts = await stripe.payouts.list({ limit: 100 });

              const settingsJson = a.UserSetting.settingRegistrationData as any;
              const settingsDataJson = a.UserSetting.settingsData as any;

              // For each payout, retrieve the associated charges
              payouts.data.map(async (payout) => {
                try {
                  const balanceTransactions = await stripe.balanceTransactions.list({ payout: payout.id });
                  const arr = balanceTransactions.data.filter((item) => item.description !== 'STRIPE PAYOUT');
                  const newArr = removeDuplicatesAndSumAmount(arr);
                  const registrationPayout = newArr.filter((item) => item.description.includes('Registration'));
                  let isOneOfRegistrationDeactivated = !isEmpty(
                    newArr.filter((c) =>
                      settingsJson?.some((a) => c.description.includes(a.registration) && !a.isActive),
                    ),
                  );

                  const activeClassValues = newArr.filter((item) => {
                    const isActiveInSettingsJson = settingsJson?.some(
                      (x) => item.description.includes(x.registration) && x.isActive,
                    );

                    const isPresentInSettingsDataJson = settingsDataJson?.some((x) =>
                      item.description.includes(x.fundName),
                    );

                    const isInactiveInSettingsJson = settingsJson?.some(
                      (x) => item.description.includes(x.registration) && !x.isActive,
                    );

                    const returnIs =
                      (isActiveInSettingsJson || isPresentInSettingsDataJson) &&
                      !isInactiveInSettingsJson &&
                      !isOneOfRegistrationDeactivated;

                    return returnIs;
                  });

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
                      finalData.push({ totalFees, grossAmount, net, nonGivingIncome, payoutDate, data: newArr });
                      await dailySyncingRegistration(a.dataValues, filterFundName, {
                        totalFees,
                        grossAmount,
                        net,
                        nonGivingIncome,
                        payoutDate,
                        data: newArr,
                      });
                    }
                  }
                } catch (error) {
                  console.error('Error processing payout:', payout.id, error);
                  // Handle the error or continue to the next payout
                }
              });

              stripeData.push(finalData);
              // return responseSuccess(res, finalData);
            } else {
              continue;
            }
          }
        } catch (error) {
          console.error('Error processing user:', a.email, error);
          // Handle the error or continue to the next user
        }
      }
      continue;
    }

    return responseSuccess(res, stripeData);
  } catch (err) {
    // handle error here, perhaps by sending an error response
    console.error(err);
    return res.status(500).json({ error: 'An error occurred' });
  }
};

export const checkLatestFund = async (req: Request, res: Response) => {
  const users = await User.findAll({
    include: [tokens, userEmailPreferences],
  });

  const filteredUsers = users.filter((user) => user.role === 'client');

  const BASE_URL = 'https://api.planningcenteronline.com/giving/v2/funds';

  for (const a of filteredUsers) {
    const userId = a.id;
    const userEmail = a.email;
    const access_token = a.tokens.find((a) => a.token_type === 'pco')?.access_token;
    const newFundEmail = a.userEmailPreferences.find((a) => a.type === 'new-fund')?.email || '';

    const config = {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    };

    try {
      const resultPCOFund = await axios.get(BASE_URL, config);
      const fund = resultPCOFund.data.data as {
        type: string;
        id: string;
        attributes: { name: string; description: string };
      }[];

      const settings = await UserSettings.findOne({ where: { userId } });

      const jsonData = JSON.stringify(settings.settingsData);

      let fundNames = [];
      for (const y of fund) {
        const isFundExist = JSON.parse(jsonData).find((x) => x.fundName === y.attributes.name);
        if (!isFundExist) {
          fundNames.push(y.attributes.name);
        }
      }

      const formattedFundList = formatFundList(fundNames);

      if (formattedFundList === 'No fund') {
        return responseSuccess(res, formattedFundList);
      }

      const msg = {
        to: newFundEmail ? newFundEmail : userEmail, // Change to your recipient
        from: 'support@churchsyncpro.com', // Change to your verified sender
        templateId: 'd-689ab576079d4909beadc88e16e30f55',
        dynamicTemplateData: {
          url: SETTING_FUND_URL,
          fund: formattedFundList,
          name: a.firstName + ' ' + a.lastName,
        },
      };
      await sgMail.send(msg);

      // If the code reaches here, the token is valid
      return responseSuccess(res, 'email sent');
    } catch (error) {
      if (error.response && error.response.status === 401) {
        // If you get a 401 Unauthorized error, the token is invalid
        return res.status(500).json({ error: 'An error occurred' });
      }
      return res.status(500).json({ error: 'An error occurred' });
    }
    // If the error is something else, it may not be a token issue
  }
};

export const checkLatestRegistration = async (req: Request, res: Response) => {
  const users = await User.findAll({
    include: [tokens, userEmailPreferences],
  });
  // const BASE_URL = 'https://api.planningcenteronline.com/giving/v2/funds';
  try {
    for (const a of users) {
      const access_token = a.tokens.find((a) => a.token_type === 'stripe')?.access_token;
      const refresh_token = a.tokens.find((a) => a.token_type === 'stripe')?.refresh_token;
      const newRegistrationEmail = a.userEmailPreferences.find((a) => a.type === 'new-registration')?.email || '';
      if (access_token) {
        let tokensFinalJson: { access_token: string; refresh_token: string } = { access_token: '', refresh_token: '' };
        const userSettingsExist = await UserSettings.findOne({ where: { userId: a.id } });
        const settingsJson = userSettingsExist.dataValues.settingRegistrationData as any;

        if (access_token && !(await checkAccessTokenValidity(access_token))) {
          const result = await refreshAccessToken(a.email as string);
          if (result && 'access_token' in result) {
            tokensFinalJson = result as SuccessToken;
          } else {
            console.log('Failed to refresh access token, error:', result.error);
            return responseError({ res, code: 500, data: 'Failed to refresh access_token' });
          }
        } else {
          tokensFinalJson = { access_token: access_token, refresh_token: refresh_token };
        }

        if (tokensFinalJson.access_token) {
          const stripe = new Stripe(tokensFinalJson.access_token, { apiVersion: '2023-10-16' });
          const payouts = await await stripe.payouts.list({ limit: 100 });
          let listOfRegistrationThatIsNotSetup = [];
          // For each payout, retrieve the associated charges
          for (const payout of payouts.data) {
            const balanceTransactions = await stripe.balanceTransactions.list({ payout: payout.id });
            const arr = balanceTransactions.data.filter((item) => item.description.includes('Registration'));
            // const registrationPayout = arr.filter((item) => item.description.includes('Registration'));
            let isOneOfRegistrationDeactivated = !isEmpty(
              arr.filter((c) => settingsJson?.some((a) => c.description.includes(a.registration) && !a.isActive)),
            );

            const activeClassValues = arr.filter((item) => {
              const isActiveInSettingsJson = settingsJson?.some(
                (x) => item.description.includes(x.registration) && x.isActive,
              );

              const isInactiveInSettingsJson = settingsJson?.some(
                (x) => item.description.includes(x.registration) && !x.isActive,
              );
              const returnIs = isActiveInSettingsJson && !isInactiveInSettingsJson && !isOneOfRegistrationDeactivated;
              return returnIs;
            });

            if (!isEmpty(arr) && isEmpty(activeClassValues)) {
              listOfRegistrationThatIsNotSetup.push(
                arr.map((item) => {
                  const parts = item.description.split(' - ');
                  if (parts.length > 2) {
                    // Join all parts after the first two parts to get the desired result
                    return parts.slice(2).join(' - ');
                  }
                  return parts[parts.length - 1]; // Fallback to the last part if there are not enough parts
                }),
              );
            }
            console.log('arr', arr);
          }

          const formattedEventList = formatFundList(listOfRegistrationThatIsNotSetup);

          console.log('formattedEventList', formattedEventList);

          if (formattedEventList === 'No events') {
            return responseSuccess(res, formattedEventList);
          }

          if (!isEmpty(listOfRegistrationThatIsNotSetup)) {
            const msg = {
              to: newRegistrationEmail ? newRegistrationEmail : a.email, // Change to a.email
              from: 'support@churchsyncpro.com',
              templateId: 'd-40cbb2e448bc42ab8db3c8184bed1628',
              dynamicTemplateData: {
                fund: formatEventList(listOfRegistrationThatIsNotSetup),
                name: a.firstName + ' ' + a.lastName,
                url: SETTING_FUND_URL,
              },
            };
            await sgMail.send(msg);
          }
        } else {
          console.error('No access_token available');
        }
      } else {
        console.error('No access_token available');
        continue;
        // return responseError({ res, code: 500, data: 'No access_token available' });
      }
    }

    return responseSuccess(res, 'email sent');
  } catch (e) {
    console.log('Exception caught:', e);
    return responseError({ res, code: 500, data: e });
  }
};

function formatEventList(events) {
  if (events.length === 0) {
    return 'No events';
  } else if (events.length === 1) {
    return `A registration ${events[0]}`;
  } else {
    const lastEvent = events.pop();
    return `A registration ${events.join(', ')} and ${lastEvent}`;
  }
}

function formatFundList(events) {
  if (events.length === 0) {
    return 'No fund';
  } else if (events.length === 1) {
    return `A fund ${events[0]}`;
  } else {
    const lastEvent = events.pop();
    return `A fund ${events.join(', ')} and ${lastEvent}`;
  }
}
