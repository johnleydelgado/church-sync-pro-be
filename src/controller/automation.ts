/* eslint-disable @typescript-eslint/no-explicit-any */
import User, { UserAttributes } from '../db/models/user';
import quickBookApi, { tokenProps } from '../utils/quickBookApi';
import quickbookAuth from '../utils/quickbookAuth';
import axios from 'axios';
import { isEmpty } from 'lodash';
const { PC_CLIENT_ID, PC_SECRET_APP, QBO_KEY, QBO_SECRET } = process.env;
import { isToday, parseISO } from 'date-fns';
import { zonedTimeToUtc } from 'date-fns-tz';

import UserSettings from '../db/models/userSettings';
import { SettingsJsonProps, requestPayload } from '../utils/mapping';
import UserSync, { UserSyncAttributes } from '../db/models/UserSync';
import { Op } from 'sequelize';

export const generateQBOToken = async (refreshToken: string, email: string) => {
  // if (!oauthClient.isAccessTokenValid()) {
  try {
    const response = await axios.post(
      'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        auth: {
          username: QBO_KEY,
          password: QBO_SECRET,
        },
      },
    );

    await User.update({ access_token_qbo: response.data.access_token }, { where: { email: email } });
    console.log('qbo', response.data.access_token);
  } catch (error) {
    console.error(error);
  }
};

export const getallUsers = async () => {
  try {
    const users = await User.findAll();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    users.map(async (item: UserAttributes) =>
      // await isQboTokenValid({
      //   ACCESS_TOKEN: item.access_token_qbo,
      //   REALM_ID: item.realm_id,
      //   REFRESH_TOKEN: item.refresh_token_qbo,
      // }),
      {
        const userSettingsExist = await UserSettings.findOne({ where: { userId: item.id } });
        const userSyncData = await UserSync.findAll({
          where: {
            userId: item.id,
            createdAt: {
              [Op.between]: [todayStart, todayEnd],
            },
          },
        });

        if (userSettingsExist) {
          // only automate if setting is exist
          if (userSettingsExist.isAutomationEnable) {
            console.log('userSyncData', userSyncData);
            await generatePcToken(item.refresh_token_pc, item.email);
            // // await generateQBOToken(item.refresh_token_qbo, item.email);
            await generateTodayBatches({
              userId: item.id,
              email: item.email,
              access_token: item.access_token_pc,
              settingsJson: userSettingsExist.settingsData,
              syncedData: userSyncData,
            });
          }
        }
      },
    );
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
    const url = `https://api.planningcenteronline.com/giving/v2/batches`;
    const getBatchesRes = await axios.get(url, config);
    const tempData = getBatchesRes.data.data;

    if (isEmpty(tempData)) {
      return [];
    }
    const data = tempData.filter((item) => {
      const created_at = zonedTimeToUtc(parseISO(item.attributes.created_at), 'UTC');
      return (
        isEmpty(syncedData.find((a) => a.batchId === item.id)) &&
        item.attributes.status === 'committed' &&
        isToday(created_at)
      );
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
    const batchesData = await getBatchInDonation({ access_token: String(access_token), syncedData });

    for (const dataOfBatches of batchesData) {
      const donationUrl = `https://api.planningcenteronline.com/giving/v2/batches/${dataOfBatches.id}/donations`;
      const responseDonation = await axios.get(donationUrl, config);
      // jsonRes.donation = {...jsonRes.donation, responseDonation.data.data}
      for (const donationsData of responseDonation.data.data) {
        const fundsData = await getFundInDonation({
          donationId: Number(donationsData.id),
          access_token: String(access_token),
        });
        const fundName = fundsData[0].attributes.name;
        const {
          account: { value: accountRef },
          customer: { value: receivedFrom },
          class: { value: classRef },
        } = settingsJson.find((item: SettingsJsonProps) => item.fundName === fundName);

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

const automationDeposit = async (email: string, json: any) => {
  const userData = await User.findOne({ where: { email: email } });

  const userJson = userData.toJSON();

  if (!quickbookAuth.isAccessTokenValid()) {
    await generateQBOToken(userJson.refresh_token_qbo, email);
  }

  const qboTokens = {
    ACCESS_TOKEN: userJson.access_token_qbo,
    REALM_ID: userJson.realm_id,
    REFRESH_TOKEN: userJson.refresh_token_qbo,
  };

  return new Promise(async (resolve, reject) => {
    await quickBookApi(qboTokens).createDeposit(json, function (err, createdData) {
      if (err) {
        reject(err);
      }
      const data = isEmpty(createdData) ? createdData : [];
      resolve(data);
    });
  });

  // try {
  //   await createDepositInQBO();
  // } catch (err) {}
};

const generatePcToken = async (refreshToken: string, email: string) => {
  try {
    const response = await axios({
      method: 'post',
      url: 'https://api.planningcenteronline.com/oauth/token',
      headers: {
        'Content-Type': 'application/json',
      },
      data: {
        client_id: PC_CLIENT_ID,
        client_secret: PC_SECRET_APP,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      },
    });

    await User.update(
      { access_token_pc: response.data.access_token, refresh_token_pc: response.data.refresh_token },
      { where: { email: email } },
    );
  } catch (error) {
    console.error(error);
  }
};
