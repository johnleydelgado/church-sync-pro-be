/* eslint-disable @typescript-eslint/no-explicit-any */
import User, { UserAttributes } from '../db/models/user';
import quickBookApi, { tokenProps } from '../utils/quickBookApi';
import axios from 'axios';
import { isEmpty, omit, sumBy } from 'lodash';
const { PC_CLIENT_ID, PC_SECRET_APP } = process.env;
import { format, fromUnixTime, isSameDay, isToday, isWithinInterval, parseISO, startOfToday, subDays } from 'date-fns';
import { zonedTimeToUtc } from 'date-fns-tz';

import UserSettings from '../db/models/userSettings';
import { SettingsJsonProps, filterStripeElectronic, newRequestPayload } from '../utils/mapping';
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
import { runDailyDonationSync } from '../services/dailyDonationSync';
import { withRetry } from '../utils/httpRetry';
import { id } from 'date-fns/locale';
import EmailLog from '../db/models/emailLog';
import SyncRun from '../db/models/SyncRun';
import { getQboTokensForUser, refreshQboToken } from '../services/qboClient';

const { SENDGRID_API_KEY, SETTING_FUND_URL } = process.env;

const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(SENDGRID_API_KEY);

// Minimal winston logger for the sync path. No existing logger module was found in the
// codebase, so this is created inline to keep failures traceable with correlation context.
const winston = require('winston');
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { module: 'automation' },
  transports: [new winston.transports.Console()],
});

interface PaymentMethodsResponse {
  QueryResponse: {
    PaymentMethod: Array<{
      Id: string;
      Name: string;
      // Add other properties as needed
    }>;
  };
}
// Thin wrapper kept for backwards compatibility. The canonical refresh+persist
// implementation now lives in services/qboClient.ts to avoid an import cycle.
export const generateQBOToken = async (refreshToken: string, email: string) => {
  return refreshQboToken(refreshToken, email);
};

export interface UserSyncResult {
  email: string;
  status: 'ok' | 'failed';
  error?: string;
}

export const getallUsers = async (): Promise<UserSyncResult[]> => {
  const users = await User.findAll();

  const results = await Promise.all(
    users.map(async (item: UserAttributes): Promise<UserSyncResult> => {
      const email = String(item.email);
      try {
        const userSettingsExist = await UserSettings.findOne({ where: { userId: item.id } });
        const userSyncData = await UserSync.findAll({
          where: {
            userId: item.id,
            createdAt: {
              [Op.between]: [getDayBoundary(0, 0, 0, 0), getDayBoundary(23, 59, 59, 999)],
            },
          },
        });

        if (userSettingsExist && userSettingsExist.isAutomationEnable) {
          // only automate if setting exists and automation is enabled
          const tokenEntity = await generatePcToken(email);
          const { access_token } = tokenEntity;
          if (access_token) {
            await generateTodayBatches({
              userId: item.id,
              email: item.email,
              access_token: access_token,
              settingsJson: userSettingsExist.settingsData,
              syncedData: userSyncData,
            });
          }
        }

        return { email, status: 'ok' };
      } catch (e) {
        // Do NOT swallow: log the failure with correlation context and surface it to the caller.
        const error = e instanceof Error ? e.message : String(e);
        logger.error('getallUsers: failed to sync user', { email, error });
        return { email, status: 'failed', error };
      }
    }),
  );

  return results;
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
      // Legitimately empty: no designations on this donation.
      return [];
    }

    const fundId = dataDesignation.data[0].relationships.fund.data.id;

    const urlFund = `https://api.planningcenteronline.com/giving/v2/funds?where[id]=${fundId}`;
    const getFound = await axios.get(urlFund, config);
    return getFound.data.data;
  } catch (e) {
    // RE-THROW: a transient PCO failure must not look like "no data". Let the caller's
    // per-user/per-batch try/catch record this as a failure instead of silently syncing nothing.
    const error = e instanceof Error ? e.message : String(e);
    logger.error('getFundInDonation: PCO request failed', { donationId, error });
    throw e;
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
      // Legitimately empty: no committed batches.
      return [];
    }

    const data = tempData.filter((item) => {
      const created_at = parseISO(item.attributes.created_at);
      return isEmpty(syncedData.find((a) => a.batchId === item.id)) && isSameDay(created_at, startOfToday());
    });

    return data;
  } catch (e) {
    // RE-THROW: distinguish a real PCO failure from "no batches today" so the caller records a failure.
    const error = e instanceof Error ? e.message : String(e);
    logger.error('getBatchInDonation: PCO request failed', { error });
    throw e;
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
      // Only Stripe-processed giving may reach QuickBooks, the same rule the daily
      // journal entry follows - a church's cash and cheques are handled by its own
      // bookkeeping, not by this automation. Filtering here rather than inside the
      // loop also skips a fund lookup per excluded donation.
      const electronicDonations = filterStripeElectronic(responseDonation.data.data);
      for (const donationsData of electronicDonations) {
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
    // RE-THROW: let getallUsers' per-user try/catch record this as a failure rather than
    // silently swallowing it (which would report the user as synced when nothing posted).
    const error = e instanceof Error ? e.message : String(e);
    logger.error('generateTodayBatches: failed to generate/post batches', { email, userId, error });
    throw e;
  }
};

export const automationDeposit = async (email: string, jsonArr: any) => {
  const qboTokens = await getQboTokensForUser(email);

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

export const automationJournalEntry = async (email: string, jePayload: any) => {
  const qboTokens = await getQboTokensForUser(email);

  return new Promise(async (resolve, reject) => {
    await quickBookApi(qboTokens).createJournalEntry(jePayload, function (err, createdData) {
      if (err) {
        return reject(err);
      }

      const data = isEmpty(createdData) ? [] : createdData;
      resolve(data);
    });
  });
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
  const run = await SyncRun.create({ trigger: 'automationScheduler', startedAt: new Date(), status: 'running' });
  try {
    const results = await getallUsers();
    const failures = results.filter((r) => r.status === 'failed');
    const summary = {
      processed: results.length,
      succeeded: results.length - failures.length,
      failed: failures.length,
      failures: failures.map((f) => ({ email: f.email, error: f.error })),
    };

    if (summary.failed > 0) {
      logger.warn('automationScheduler: completed with failures', summary);
    } else {
      logger.info('automationScheduler: completed', { processed: summary.processed, succeeded: summary.succeeded });
    }

    await run.update({
      finishedAt: new Date(),
      processed: summary.processed,
      succeeded: summary.succeeded,
      failed: summary.failed,
      failures: summary.failures,
      status: 'completed',
    });

    return responseSuccess(res, summary);
  } catch (err) {
    // handle error here, perhaps by sending an error response
    const error = err instanceof Error ? err.message : String(err);
    logger.error('automationScheduler: unexpected error', { error });
    await run.update({ finishedAt: new Date(), status: 'errored', failures: [{ email: '', error }] });
    return res.status(500).json({ error: 'An error occurred' });
  }
};

export const latestFundAutomation = async (req: Request, res: Response) => {
  const run = await SyncRun.create({ trigger: 'latestFundAutomation', startedAt: new Date(), status: 'running' });
  try {
    const users = await User.findAll({
      include: [UserSettings, tokens],
    });

    const failures: { email: string; error: string }[] = [];
    let processed = 0;

    for (const a of users) {
      if (
        !isEmpty(a.UserSetting) &&
        !checkEmpty(a.UserSetting.settingBankData) &&
        a.UserSetting.startDateAutomationFund &&
        a.UserSetting.isAutomationEnable &&
        a.role === 'client'
      ) {
        processed += 1;
        // Per-user isolation: one user's failure must not abort the rest of the run.
        try {
          const tokenEntity = await generatePcToken(a.email as string);
          const { access_token } = tokenEntity;

          const headers = { Authorization: `Bearer ${access_token}` };
          const start_date = new Date(a.UserSetting.startDateAutomationFund);
          const end_date = new Date(); // Today's date

          // Paginate PCO batches via `links.next` (a full URL) instead of capping at the first
          // page of 50. The list is ordered by `-updated_at`, so once a page's batches are all
          // older than the automation window we can stop early. Each page GET is retried on
          // transient failures (429/5xx/network).
          const batchesInWindow: any[] = [];
          let nextUrl: string | null =
            'https://api.planningcenteronline.com/giving/v2/batches?per_page=50&order=-updated_at&filter=committed';

          while (nextUrl) {
            const response = await withRetry(() => axios({ method: 'get', url: nextUrl as string, headers }));
            const pageData: any[] = response.data?.data ?? [];

            for (const item of pageData) {
              const created_at = parseISO(item.attributes.created_at);
              if (isWithinInterval(created_at, { start: start_date, end: end_date })) {
                batchesInWindow.push(item);
              }
            }

            // Early stop: ordered by -updated_at, so once a page's newest-to-oldest stream
            // drops below the window start there are no more in-window batches to find.
            const oldestUpdatedOnPage = pageData.reduce<Date | null>((oldest, item) => {
              const updatedAt = parseISO(item.attributes.updated_at ?? item.attributes.created_at);
              return oldest === null || updatedAt < oldest ? updatedAt : oldest;
            }, null);

            if (oldestUpdatedOnPage !== null && oldestUpdatedOnPage < start_date) {
              break;
            }

            nextUrl = response.data?.links?.next ?? null;
          }

          // Collect per-batch promises for this user (keeps existing dailySyncing calls).
          const innerPromises = batchesInWindow.map((item) =>
            dailySyncing(a, item, item.id, `${item.id} - ${a.email}`, a.UserSetting.settingBankData),
          );

          await Promise.all(innerPromises);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logger.error('latestFundAutomation: failed to sync user', { email: a.email, error });
          failures.push({ email: a.email as string, error });
        }
      }
    }

    const summary = {
      processed,
      succeeded: processed - failures.length,
      failed: failures.length,
      failures,
    };

    if (summary.failed > 0) {
      logger.warn('latestFundAutomation: completed with failures', summary);
    } else {
      logger.info('latestFundAutomation: completed', { processed: summary.processed, succeeded: summary.succeeded });
    }

    await run.update({
      finishedAt: new Date(),
      processed: summary.processed,
      succeeded: summary.succeeded,
      failed: summary.failed,
      failures: summary.failures,
      status: 'completed',
    });

    return responseSuccess(res, summary);
  } catch (err) {
    // handle error here, perhaps by sending an error response
    const error = err instanceof Error ? err.message : String(err);
    logger.error('latestFundAutomation: unexpected error', { error });
    await run.update({ finishedAt: new Date(), status: 'errored', failures: [{ email: '', error }] });
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

    const twoDaysAgo = subDays(new Date(), 2);

    const isMailAlreadyExist = await EmailLog.findOne({
      where: {
        userId: a.id,
        emailType: 'fund',
      },
      order: [['createdAt', 'DESC']],
    });

    if (isMailAlreadyExist) {
      const createdAtDate = new Date(isMailAlreadyExist.createdAt);
      if (isWithinInterval(createdAtDate, { start: twoDaysAgo, end: new Date() })) {
        console.log('Email was sent within the last 2 days');
        continue;
      } else {
        console.log('Email was not sent within the last 2 days');
      }
    }

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
        continue;
      }

      const msg = {
        to: newFundEmail ? newFundEmail : userEmail, // Change to your recipient
        from: 'support@churchsyncpro.com', // Change to your verified sender
        templateId: 'd-3d206cfca5c845659add95f31d9ff58c',
        dynamicTemplateData: {
          url: SETTING_FUND_URL,
          fund: formattedFundList,
          name: a.firstName + ' ' + a.lastName,
        },
      };
      await sgMail.send(msg);
      await EmailLog.create({ emailType: 'fund', userId });

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

  const filteredUsers = users.filter((user) => user.role === 'client');

  const twoDaysAgo = subDays(new Date(), 2);

  try {
    for (const a of filteredUsers) {
      const isMailAlreadyExist = await EmailLog.findOne({
        where: {
          userId: a.id,
          emailType: 'stripe',
        },
        order: [['createdAt', 'DESC']],
      });

      if (isMailAlreadyExist) {
        const createdAtDate = new Date(isMailAlreadyExist.createdAt);
        if (isWithinInterval(createdAtDate, { start: twoDaysAgo, end: new Date() })) {
          console.log('Email was sent within the last 2 days');
          continue;
        } else {
          console.log('Email was not sent within the last 2 days');
        }
      }

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
          }

          const flattenedArray = listOfRegistrationThatIsNotSetup.flat();
          const newListOfRegistrationThatIsNotSetup = [...new Set(flattenedArray)];

          const formattedEventList = formatFundList(newListOfRegistrationThatIsNotSetup);

          if (formattedEventList === 'No events') {
            continue;
          }

          if (!isEmpty(newListOfRegistrationThatIsNotSetup)) {
            const msg = {
              to: newRegistrationEmail ? newRegistrationEmail : a.email, // Change to a.email
              from: 'support@churchsyncpro.com',
              templateId: 'd-40cbb2e448bc42ab8db3c8184bed1628',
              dynamicTemplateData: {
                fund: formatEventList(newListOfRegistrationThatIsNotSetup),
                name: a.firstName + ' ' + a.lastName,
                url: SETTING_FUND_URL,
              },
            };
            await sgMail.send(msg);
            await EmailLog.create({ emailType: 'stripe', userId: a.id });
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
  } else {
    return `<ul style="text-align: left; color: #7B7B7B;">${events.map((event) => `<li>${event}</li>`).join('')}</ul>`;
  }
}

function formatFundList(events) {
  if (events.length === 0) {
    return 'No fund';
  } else {
    return `<ul style="text-align: left; color: #7B7B7B;">${events.map((event) => `<li>${event}</li>`).join('')}</ul>`;
  }
}

// function formatFundList(events) {
//   if (events.length === 0) {
//     return 'No fund';
//   } else if (events.length === 1) {
//     return `A fund ${events[0]}`;
//   } else {
//     const lastEvent = events.pop();
//     return `A fund ${events.join(', ')} and ${lastEvent}`;
//   }
// }

/**
 * The nightly journal-entry run.
 *
 * Replaces `latestFundAutomation` as the automatic path. That one enumerated committed Planning
 * Center batches, and online giving is not in batches - cash, cheques and imports are - so it
 * was looking for Stripe money in the one place Planning Center never puts it. This sweeps each
 * church's recent days from the organisation-level donations endpoint instead.
 *
 * Runs at 8am and settles the day that has just ended, then re-examines the days before it,
 * because ACH gifts settle a few days after they are given. A day whose total has not changed
 * posts nothing.
 *
 * Every church is accounted for: synced, failed, or skipped with a named reason. A run that
 * touched nobody used to report `processed: 0, completed`, which read exactly like a quiet
 * night with no giving.
 */
export const dailyJournalSync = async (req: Request, res: Response) => {
  const run = await SyncRun.create({ trigger: 'dailyJournalSync', startedAt: new Date(), status: 'running' });
  const now = new Date();

  try {
    const users = await User.findAll({ where: { role: 'client' } });

    const failures: { email: string; error: string }[] = [];
    const skips: { email: string; reason: string }[] = [];
    let processed = 0;
    let succeeded = 0;

    for (const user of users) {
      try {
        const result = await runDailyDonationSync(user, { now });
        if (result.status === 'skipped') {
          skips.push({ email: result.email, reason: result.reason ?? 'unknown' });
          continue;
        }
        processed += 1;
        if (result.status === 'synced') {
          succeeded += 1;
        } else {
          failures.push({ email: result.email, error: `days failed: ${result.failedDays.join(', ')}` });
        }
        logger.info('dailyJournalSync: church settled', {
          email: result.email,
          status: result.status,
          daysExamined: result.daysExamined.length,
          postedDays: result.postedDays,
        });
      } catch (e) {
        processed += 1;
        const error = e instanceof Error ? e.message : String(e);
        logger.error('dailyJournalSync: church failed', { email: user.email, error });
        failures.push({ email: String(user.email), error });
      }
    }

    await run.update({
      finishedAt: new Date(),
      processed,
      succeeded,
      failed: failures.length,
      failures,
      skipped: skips.length,
      skips,
      status: 'completed',
    });

    return responseSuccess(res, { processed, succeeded, failed: failures.length, failures, skipped: skips.length, skips });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await run.update({ finishedAt: new Date(), status: 'errored', failures: [{ email: 'run', error }] });
    logger.error('dailyJournalSync: run errored', { error });
    return responseError({ res, code: 500, data: error });
  }
};
