/* eslint-disable @typescript-eslint/no-explicit-any */
import axios from 'axios';
import { Request, Response } from 'express';
import { responseError, responseSuccess } from '../utils/response';
import { isEmpty } from 'lodash';
import User from '../db/models/user';
import { generatePcToken } from './automation';
import UserSync from '../db/models/UserSync';

const BASE_URL = 'https://api.planningcenteronline.com/giving/v2';

export const getBatchInDonation = async ({ accessToken }: { accessToken: string }) => {
  const config = {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  };
  try {
    const url = `https://api.planningcenteronline.com/giving/v2/batches`;
    const getBatchesRes = await axios.get(url, config);
    const tempData = getBatchesRes.data.data;

    if (isEmpty(tempData)) {
      //return empty here
      return [];
    }

    // const startDate = new Date('2023-04-04');
    // const endDate = new Date('2023-04-05');

    // const data = tempData.filter((item) => {
    //   const created_at = new Date(item.attributes.created_at);
    //   return created_at >= startDate && created_at <= endDate;
    // });

    return tempData;
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
  const { email, refreshToken } = req.query;

  const jsonRes = { batches: [], synchedBatches: [] };

  try {
    const user = await generatePcToken(refreshToken as string, email as string);

    if (isEmpty(user)) {
      return responseError({ res, code: 500, data: 'Empty User' });
    }

    const { access_token_pc } = user;
    const synchedBatchesData = await UserSync.findAll({
      where: { userId: user.id },
      attributes: ['id', 'batchId', 'createdAt'],
    });

    jsonRes.synchedBatches = synchedBatchesData;

    const headers = {
      Authorization: `Bearer ${access_token_pc}`,
    };

    const batchesData = await getBatchInDonation({ accessToken: String(access_token_pc) });

    for (const batch of batchesData) {
      const batchId = batch.id;

      const donations = await fetchDonationsForBatch(batchId, headers);
      const batchDonations = [];
      for (const [index, donation] of donations.data.entries()) {
        const designation = donations.included[index];
        const fundId = designation.relationships.fund.data.id;
        const fund = await fetchFund(fundId, headers);

        batchDonations.push({
          donation: donation,
          designation,
          fund,
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
    const isEmailExist = await User.findOne({ where: { email: email as string } });
    if (isEmailExist) {
      const config = {
        method: 'get',
        url: 'https://api.planningcenteronline.com/giving/v2/funds',
        headers: {
          Authorization: `Bearer ${isEmailExist.dataValues.access_token_pc}`,
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

  try {
    const isEmailExist = await User.findOne({ where: { email: email as string } });
    if (isEmailExist) {
      const config = {
        method: 'get',
        url: 'https://api.planningcenteronline.com/calendar/v2/events',
        headers: {
          Authorization: `Bearer ${isEmailExist.dataValues.access_token_pc}`,
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
