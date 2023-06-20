/* eslint-disable @typescript-eslint/no-explicit-any */
import axios from 'axios';
import { Request, Response } from 'express';
import { responseError, responseSuccess } from '../utils/response';
import { isEmpty } from 'lodash';
import User from '../db/models/user';
import { generatePcToken } from './automation';
import UserSync from '../db/models/UserSync';

const BASE_URL = 'https://api.planningcenteronline.com/giving/v2';

export const getBatchInDonationPCO = async ({ accessToken, dateRange }: { accessToken: string; dateRange?: any }) => {
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

  try {
    const tokenEntity = await generatePcToken(email as string);

    const { access_token } = tokenEntity;
    if (!isEmpty(tokenEntity)) {
      const config = {
        method: 'get',
        url: 'https://api.planningcenteronline.com/calendar/v2/events',
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
