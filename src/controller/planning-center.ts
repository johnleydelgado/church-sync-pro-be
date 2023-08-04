/* eslint-disable @typescript-eslint/no-explicit-any */
import axios from 'axios';
import { Request, Response } from 'express';
import { responseError, responseSuccess } from '../utils/response';
import { isEmpty } from 'lodash';
import User from '../db/models/user';
import { generatePcToken, generateQBOToken } from './automation';
import UserSync from '../db/models/UserSync';
import quickBookApi from '../utils/quickBookApi';
import tokenEntity from '../db/models/tokenEntity';
import tokens from '../db/models/tokens';
import quickbookAuth from '../utils/quickbookAuth';

const BASE_URL = 'https://api.planningcenteronline.com/giving/v2';

export const getBatchInDonationPCO = async ({ accessToken, dateRange }: { accessToken: string; dateRange?: any }) => {
  const config = {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  };
  try {
    const url = BASE_URL + `/batches`;
    const getBatchesRes = await axios.get(url, config);
    const tempData = getBatchesRes.data.data;
    if (isEmpty(tempData)) {
      //return empty here
      return [];
    }
    if (!dateRange?.startDate && !dateRange?.endDate) {
      return tempData;
    }

    const startDate = new Date(dateRange?.startDate);
    const endDate = new Date(dateRange?.endDate);
    endDate.setHours(23, 59, 59, 999);

    const data = tempData.filter((item) => {
      const created_at = new Date(item.attributes.created_at);
      return created_at >= startDate && created_at <= endDate;
    });

    if (!isEmpty(data)) {
      return data;
    }

    return [];
  } catch (e) {
    return [];
  }
};

const fetchDonationsForBatch = async (batchId: string, headers: any) => {
  const donationsResponse = await axios.get(`${BASE_URL}/batches/${batchId}/donations?include=designations`, {
    headers,
  });
  const donations = donationsResponse.data;
  return donations;
};

const fetchFund = async (fundId: string, headers: any) => {
  const fundResponse = await axios.get(`${BASE_URL}/funds/${fundId}`, { headers });
  const fund = fundResponse.data.data;
  return fund;
};

export const getBatches = async (req: Request, res: Response) => {
  const { email, dateRange } = req.body;
  const jsonRes = { batches: [], synchedBatches: [] };

  try {
    const tokenEntity = await generatePcToken(email as string);
    const user = await User.findOne({
      where: { email: email as string },
    });

    if (isEmpty(tokenEntity)) {
      return responseError({ res, code: 202, data: 'PCO token is null' });
    }

    const { access_token } = tokenEntity;
    const synchedBatchesData = await UserSync.findAll({
      where: { userId: user.id },
      attributes: ['id', 'batchId', 'createdAt', 'donationId'],
    });

    jsonRes.synchedBatches = synchedBatchesData;

    const headers = {
      Authorization: `Bearer ${access_token}`,
    };

    const batchesData = await getBatchInDonationPCO({ accessToken: String(access_token), dateRange: dateRange || '' });

    for (const batch of batchesData) {
      const batchId = batch.id;

      const donations = await fetchDonationsForBatch(batchId, headers);
      const batchDonations = [];
      for (const [index, donation] of donations.data.entries()) {
        const designation = donations.included[index];
        const fundId = designation.relationships.fund.data.id;
        const fund = await fetchFund(fundId, headers);
        let tempDataPerson = null;
        const person = donation.relationships.person.data;
        if (person) {
          const urlPerson = `https://api.planningcenteronline.com/giving/v2/people/${person.id}`;
          const getPersonDetails = await axios.get(urlPerson, { headers });
          tempDataPerson = getPersonDetails.data;
        }

        batchDonations.push({
          donation: donation,
          designation,
          fund,
          person: tempDataPerson,
        });
      }

      jsonRes.batches.push({
        batch,
        donations: batchDonations,
      });
    }

    return responseSuccess(res, jsonRes);
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

export const getFunds = async (req: Request, res: Response) => {
  const { email } = req.query;

  try {
    const tokenEntity = await generatePcToken(email as string);
    const { access_token } = tokenEntity;
    if (access_token) {
      const config = {
        method: 'get',
        url: 'https://api.planningcenteronline.com/giving/v2/funds',
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      };

      const response = await axios(config);
      const data = response.data.data;
      return responseSuccess(res, data);
    }
    return responseError({ res, code: 500, data: 'not found !' });
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

export const getRegistrationEvents = async (req: Request, res: Response) => {
  const { email } = req.query;

  const data = await tokenEntity.findOne({
    where: { email: email as string, isEnabled: true },
    include: tokens,
  });

  if (!data) {
    console.log('Empty user data', email);
    return res.status(500).json({ error: 'Empty user data' });
  }

  const arr = data.tokens.find((item) => item.token_type === 'qbo');

  if (!arr) {
    return responseError({ res, code: 500, data: 'No qbo token' });
  }
  let tokenJson = { access_token: arr.access_token, refresh_token: arr.refresh_token, realm_id: arr.realm_id };

  if (!quickbookAuth.isAccessTokenValid()) {
    const result = await generateQBOToken(arr.refresh_token, email as string);
    tokenJson = result;
  }

  const qboTokens = {
    ACCESS_TOKEN: tokenJson?.access_token,
    REALM_ID: tokenJson?.realm_id,
    REFRESH_TOKEN: tokenJson?.refresh_token,
  };

  const fetchCustomers = async () => {
    return new Promise(async (resolve, reject) => {
      await quickBookApi(qboTokens).findCustomers(
        {
          fetchAll: true,
        },
        (err, customers) => {
          if (err) {
            reject(err);
          }
          const customerList = [];
          customers.QueryResponse.Customer.forEach(function (item) {
            if (item.IsProject) customerList.push({ value: item.Id, name: item.DisplayName });
          });
          resolve(customerList);
        },
      );
    });
  };
  try {
    const results = await fetchCustomers();
    return responseSuccess(res, results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }

  // const { email } = req.query;

  // try {
  //   const tokenEntity = await generatePcToken(email as string);

  //   const { access_token } = tokenEntity;
  //   if (!isEmpty(tokenEntity)) {
  //     const config = {
  //       method: 'get',
  //       url: 'https://api.planningcenteronline.com/calendar/v2/events',
  //       headers: {
  //         Authorization: `Bearer ${access_token}`,
  //       },
  //     };

  //     const response = await axios(config);
  //     const data = response.data.data;
  //     return responseSuccess(res, data);
  //   }
  //   return responseError({ res, code: 500, data: 'not found !' });
  // } catch (e) {
  //   return responseError({ res, code: 500, data: e });
  // }
};
