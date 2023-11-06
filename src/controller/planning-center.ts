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
import registration from '../db/models/registration';
import { format, parseISO } from 'date-fns';

const BASE_URL = 'https://api.planningcenteronline.com/giving/v2';

export const isAccessTokenValidPCO = async ({ accessToken }: { accessToken: string }) => {
  const config = {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  };

  const url = 'https://api.planningcenteronline.com/giving/v2/batches?per_page=1';
  try {
    await axios.get(url, config);
    // If the code reaches here, the token is valid
    return true;
  } catch (error) {
    if (error.response && error.response.status === 401) {
      // If you get a 401 Unauthorized error, the token is invalid
      return false;
    }
    // If the error is something else, it may not be a token issue
    throw error;
  }
};

export const getBatchInDonationPCO = async ({
  accessToken,
  date,
  offset = 0,
}: {
  accessToken: string;
  date?: any;
  offset?: number;
}) => {
  const config = {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  };
  try {
    let url = '';

    // if date is empty
    if (!date) {
      url = `https://api.planningcenteronline.com/giving/v2/batches?per_page=10&offset=${offset}`;
    } else {
      const sDate = format(parseISO(date), 'yyyy-MM-dd');
      const eDate = format(new Date(), 'yyyy-MM-dd');
      url = `https://api.planningcenteronline.com/giving/v2/batches?per_page=10&offset=${offset}&where[updated_at][gte]=${sDate}&where[updated_at][lte]=${eDate}`;
    }

    const getBatchesRes = await axios.get(url, config);
    const tempData = getBatchesRes.data.data;
    console.log('===go here ?:', offset);

    const offSetNext = getBatchesRes.data.meta?.next?.offset || 0;
    const offSetPrev = getBatchesRes.data.meta?.prev?.offset || 0;
    const total_count = getBatchesRes.data.meta?.total_count || 0;

    if (isEmpty(tempData)) {
      //return empty here

      return { data: null };
    }

    // if date is empty
    if (!date) {
      return { data: tempData, offSetNext, offSetPrev, total_count };
    }

    const startDate = new Date(date);
    const endDate = new Date();
    endDate.setHours(23, 59, 59, 999);

    const data = tempData.filter((item) => {
      const created_at = new Date(item.attributes.created_at);
      return created_at >= startDate && created_at <= endDate;
    });

    if (!isEmpty(data)) {
      console.log('emptyData');
      return { data, offSetNext, offSetPrev, total_count };
    }
    console.log('return null');

    return { data: null };
  } catch (e) {
    console.log('return null catch', e);
    return { data: null };
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
  const { email, dateRange, offset = 0 } = req.body;
  const jsonRes = { batches: [], synchedBatches: [], offSetRes: { next: 0, prev: 0 }, total_count: 0 };

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

    console.log('coming here for ???');

    const batchesData = await getBatchInDonationPCO({
      accessToken: String(access_token),
      date: dateRange || '',
      offset: Number(offset || 0),
    });

    // jsonRes.batches = batchesData;

    jsonRes.batches = [];
    if (!isEmpty(batchesData)) {
      jsonRes.offSetRes = { next: Number(batchesData.offSetNext), prev: Number(batchesData.offSetPrev) };
      jsonRes.total_count = batchesData.total_count;

      for (const batch of batchesData.data) {
        const batchId = batch.id;
        const donations = await fetchDonationsForBatch(batchId, headers);

        jsonRes.batches.push({
          batch,
          donations,
        });
      }
    }

    // for (const batch of batchesData) {
    //   const batchId = batch.id;

    //   const donations = await fetchDonationsForBatch(batchId, headers);
    //   const batchDonations = [];
    //   for (const [index, donation] of donations.data.entries()) {
    //     const designation = donations.included[index];
    //     const fundId = designation.relationships.fund.data.id;
    //     const fund = await fetchFund(fundId, headers);
    //     let tempDataPerson = null;
    //     const person = donation.relationships.person.data;
    //     if (person) {
    //       const urlPerson = `https://api.planningcenteronline.com/giving/v2/people/${person.id}`;
    //       const getPersonDetails = await axios.get(urlPerson, { headers });
    //       tempDataPerson = getPersonDetails.data;
    //     }

    //     batchDonations.push({
    //       donation: donation,
    //       designation,
    //       fund,
    //       person: tempDataPerson,
    //     });
    //   }

    //   jsonRes.batches.push({
    //     batch,
    //     donations: batchDonations,
    //   });
    // }

    return responseSuccess(res, jsonRes);
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

// export const getBatches = async (req: Request, res: Response) => {
//   const { email, dateRange } = req.body;
//   const jsonRes = { batches: [], synchedBatches: [] };

//   try {
//     const tokenEntity = await generatePcToken(email as string);
//     const user = await User.findOne({
//       where: { email: email as string },
//     });

//     if (isEmpty(tokenEntity)) {
//       return responseError({ res, code: 202, data: 'PCO token is null' });
//     }

//     const { access_token } = tokenEntity;
//     const synchedBatchesData = await UserSync.findAll({
//       where: { userId: user.id },
//       attributes: ['id', 'batchId', 'createdAt', 'donationId'],
//     });

//     jsonRes.synchedBatches = synchedBatchesData;

//     const headers = {
//       Authorization: `Bearer ${access_token}`,
//     };

//     const batchesData = await getBatchInDonationPCO({ accessToken: String(access_token), dateRange: dateRange || '' });

//     for (const batch of batchesData) {
//       const batchId = batch.id;

//       const donations = await fetchDonationsForBatch(batchId, headers);
//       const batchDonations = [];
//       for (const [index, donation] of donations.data.entries()) {
//         const designation = donations.included[index];
//         const fundId = designation.relationships.fund.data.id;
//         const fund = await fetchFund(fundId, headers);
//         let tempDataPerson = null;
//         const person = donation.relationships.person.data;
//         if (person) {
//           const urlPerson = `https://api.planningcenteronline.com/giving/v2/people/${person.id}`;
//           const getPersonDetails = await axios.get(urlPerson, { headers });
//           tempDataPerson = getPersonDetails.data;
//         }

//         batchDonations.push({
//           donation: donation,
//           designation,
//           fund,
//           person: tempDataPerson,
//         });
//       }

//       jsonRes.batches.push({
//         batch,
//         donations: batchDonations,
//       });
//     }

//     return responseSuccess(res, jsonRes);
//   } catch (e) {
//     return responseError({ res, code: 500, data: e });
//   }
// };

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

export const handleRegistrationEvents = async (req: Request, res: Response) => {
  const { action, name, userId, registrationId } = req.body;

  try {
    let results;
    switch (action) {
      case 'create':
        results = await registration.create({ name: String(name), userId: Number(userId) });
        break;

      case 'read':
        if (userId) {
          results = await registration.findAll({ where: { userId: Number(userId) } });
          if (results.length === 0) {
            return res.status(404).json({ error: 'No registrations found for the given userId' });
          }
        }
        break;

      case 'update':
        results = await registration.findByPk(Number(registrationId));
        if (!results) {
          return res.status(404).json({ error: 'Registration not found' });
        }
        if (name) results.name = String(name);
        if (userId) results.userId = Number(userId);
        await results.save();
        break;

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }

    return responseSuccess(res, results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// export const getRegistrationEvents = async (req: Request, res: Response) => {
//   const { name, userId } = req.query;

//   try {
//     const results = await registration.create({ name: String(name), userId: Number(userId) });
//     return responseSuccess(res, results);
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }

//   // if (!data) {
//   //   console.log('Empty user data', email);
//   //   return res.status(500).json({ error: 'Empty user data' });
//   // }

//   // const arr = data.tokens.find((item) => item.token_type === 'qbo');

//   // if (!arr) {
//   //   return responseError({ res, code: 500, data: 'No qbo token' });
//   // }
//   // let tokenJson = { access_token: arr.access_token, refresh_token: arr.refresh_token, realm_id: arr.realm_id };

//   // if (!quickbookAuth.isAccessTokenValid()) {
//   //   const result = await generateQBOToken(arr.refresh_token, email as string);
//   //   tokenJson = result;
//   // }

//   // const qboTokens = {
//   //   ACCESS_TOKEN: tokenJson?.access_token,
//   //   REALM_ID: tokenJson?.realm_id,
//   //   REFRESH_TOKEN: tokenJson?.refresh_token,
//   // };

//   // const fetchCustomers = async () => {
//   //   return new Promise(async (resolve, reject) => {
//   //     await quickBookApi(qboTokens).findCustomers(
//   //       {
//   //         fetchAll: true,
//   //       },
//   //       (err, customers) => {
//   //         if (err) {
//   //           reject(err);
//   //         }
//   //         const customerList = [];
//   //         customers.QueryResponse.Customer.forEach(function (item) {
//   //           if (item.IsProject) customerList.push({ value: item.Id, name: item.DisplayName });
//   //         });
//   //         resolve(customerList);
//   //       },
//   //     );
//   //   });
//   // };
//   // try {
//   //   const results = await fetchCustomers();
//   //   return responseSuccess(res, results);
//   // } catch (err) {
//   //   res.status(500).json({ error: err.message });
//   // }
// };
