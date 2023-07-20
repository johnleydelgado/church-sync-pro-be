/* eslint-disable @typescript-eslint/no-explicit-any */
import User, { UserAttributes } from '../db/models/user';
import quickBookApi, { tokenProps } from '../utils/quickBookApi';
import quickbookAuth from '../utils/quickbookAuth';
import axios from 'axios';
import { isEmpty, omit } from 'lodash';
const { PC_CLIENT_ID, PC_SECRET_APP, QBO_KEY, QBO_SECRET } = process.env;
import { isSameDay, isToday, isWithinInterval, parseISO, startOfToday } from 'date-fns';
import { zonedTimeToUtc } from 'date-fns-tz';

import UserSettings from '../db/models/userSettings';
import { SettingsJsonProps, requestPayload } from '../utils/mapping';
import UserSync, { UserSyncAttributes } from '../db/models/UserSync';
import { Op } from 'sequelize';
import { getDayBoundary } from '../utils/helper';
import tokenEntity from '../db/models/tokenEntity';
import tokens from '../db/models/tokens';
import { responseError, responseSuccess } from '../utils/response';
import { getBatchInDonationPCO } from './planning-center';
import { Request, Response } from 'express';

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

        jsonRes.donation = [
          ...jsonRes.donation,
          { ...donationsData, fund: fundsData[0] || {}, batch: dataOfBatches, accountRef, receivedFrom, classRef },
        ];
      }
    }

    if (!isEmpty(jsonRes.donation)) {
      const data = requestPayload(jsonRes.donation);
      let count = 0;
      for (const payloadJson of data) {
        await automationDeposit(email, payloadJson);
        await UserSync.create({ syncedData: jsonRes.donation, userId, batchId: jsonRes.donation[count].batch.id });
        count += 1;
      }
    }
  } catch (e) {
    console.log('generate data', e);
  }
};

export const automationDeposit = async (email: string, json: any) => {
  let fJson = { ...json };

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

    if (!isEmpty(paymentMethods)) {
      const paymentMethodsList = paymentMethods.QueryResponse.PaymentMethod;
      const tempPayment =
        fJson.tempPaymentMethod.toLowerCase() === 'stripe' ? 'visa' : fJson.tempPaymentMethod.toLowerCase();
      const paymentMethod = paymentMethodsList.find((el) => el.Name.toLowerCase() === tempPayment);
      fJson.Line[0].DepositLineDetail.PaymentMethodRef = { value: paymentMethod.Id };

      fJson = omit(fJson, 'tempPaymentMethod');
    }
    return new Promise(async (resolve, reject) => {
      await quickBookApi(qboTokens).createDeposit(fJson, function (err, createdData) {
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

    if (!isEmpty(await getBatchInDonationPCO({ accessToken: arr.access_token as string }))) {
      console.log('asdasdasdasd');
      return { access_token: arr.access_token, refresh_token: arr.refresh_token };
    }

    console.log('asdasdasd', refresh_token);

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
  try {
    await getallUsers();
    return responseSuccess(res, 'Sync completed');
  } catch (err) {
    // handle error here, perhaps by sending an error response
    console.error(err);
    return res.status(500).json({ error: 'An error occurred' });
  }
};
