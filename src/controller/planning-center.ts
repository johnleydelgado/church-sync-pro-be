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
import { endOfMonth, endOfYear, format, parseISO, startOfMonth, startOfYear, subDays, subMonths } from 'date-fns';

const BASE_URL = 'https://api.planningcenteronline.com/giving/v2';

type dateRangeProps =
  | 'This Month'
  | 'Last Month'
  | 'Last 7 Days'
  | 'Last 30 Days'
  | 'Last 3 Months'
  | 'Last 6 Months'
  | '2024'
  | '2023'
  | '2022'
  | '2021'
  | '2020'
  | '2019'
  | '2018'
  | 'Custom';

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
  filterDate,
  startFilterDate,
  endFilterDate,
  amount,
}: {
  accessToken: string;
  date?: any;
  offset?: number;
  filterDate?: dateRangeProps;
  startFilterDate?: any;
  endFilterDate?: any;
  amount?: number;
}) => {
  const config = {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  };
  try {
    let url = '';

    let startDate;
    let endDate;

    switch (filterDate) {
      case 'This Month':
        startDate = startOfMonth(new Date());
        endDate = endOfMonth(new Date());
        break;
      case 'Last Month':
        const lastMonth = subMonths(new Date(), 1);
        startDate = startOfMonth(lastMonth);
        endDate = endOfMonth(lastMonth);
        break;
      case 'Last 7 Days':
        endDate = new Date();
        startDate = subDays(endDate, 7);
        break;
      case 'Last 30 Days':
        endDate = new Date();
        startDate = subDays(endDate, 30);
        break;
      case 'Last 3 Months':
        endDate = new Date();
        startDate = subMonths(endDate, 3);
        break;
      case 'Last 6 Months':
        endDate = new Date();
        startDate = subMonths(endDate, 6);
        break;
      case '2024':
        startDate = startOfYear(new Date(2024, 0));
        endDate = endOfYear(new Date(2024, 0));
        break;
      case '2023':
        startDate = startOfYear(new Date(2023, 0));
        endDate = endOfYear(new Date(2023, 0));
        break;
      case '2022':
        startDate = startOfYear(new Date(2022, 0));
        endDate = endOfYear(new Date(2022, 0));
        break;
      case '2021':
        startDate = startOfYear(new Date(2021, 0));
        endDate = endOfYear(new Date(2021, 0));
        break;
      case '2020':
        startDate = startOfYear(new Date(2020, 0));
        endDate = endOfYear(new Date(2020, 0));
        break;
      case '2019':
        startDate = startOfYear(new Date(2019, 0));
        endDate = endOfYear(new Date(2019, 0));
        break;
      case '2018':
        startDate = startOfYear(new Date(2018, 0));
        endDate = endOfYear(new Date(2018, 0));
        break;
      case 'Custom':
        startDate = startFilterDate ? new Date(startFilterDate) : new Date();
        endDate = endFilterDate ? new Date(endFilterDate) : new Date();
        break;
      default:
        // Add code for default case
        startDate = new Date(date);
        endDate = new Date();
        endDate.setHours(23, 59, 59, 999);
    }

    // if date is empty
    if (filterDate) {
      if (filterDate === 'Custom') {
        const sDate = format(parseISO(startFilterDate), 'yyyy-MM-dd');
        const eDate = format(parseISO(endFilterDate), 'yyyy-MM-dd');
        url = `https://api.planningcenteronline.com/giving/v2/batches?per_page=10&offset=${offset}&where[updated_at][gte]=${sDate}&where[updated_at][lte]=${eDate}&filter=committed`;
      } else if (amount) {
        const sDate = format(startDate, 'yyyy-MM-dd');
        const eDate = format(endDate, 'yyyy-MM-dd');
        url = `https://api.planningcenteronline.com/giving/v2/batches?per_page=100&where[updated_at][gte]=${sDate}&where[updated_at][lte]=${eDate}&filter=committed`;
      } else {
        const sDate = format(startDate, 'yyyy-MM-dd');
        const eDate = format(endDate, 'yyyy-MM-dd');
        url = `https://api.planningcenteronline.com/giving/v2/batches?per_page=10&offset=${offset}&where[updated_at][gte]=${sDate}&where[updated_at][lte]=${eDate}&filter=committed`;
      }
    } else if (!date) {
      url = `https://api.planningcenteronline.com/giving/v2/batches?per_page=10&offset=${offset}&filter=committed`;
    } else {
      const sDate = format(parseISO(date), 'yyyy-MM-dd');
      const eDate = format(new Date(), 'yyyy-MM-dd');
      url = `https://api.planningcenteronline.com/giving/v2/batches?per_page=10&offset=${offset}&where[updated_at][gte]=${sDate}&where[updated_at][lte]=${eDate}&filter=committed`;
    }

    const getBatchesRes = await axios.get(url, config);
    const tempData = getBatchesRes.data.data;
    console.log('===go here ?:', url);

    const offSetNext = getBatchesRes.data.meta?.next?.offset || 0;
    const offSetPrev = getBatchesRes.data.meta?.prev?.offset || 0;
    let total_count = getBatchesRes.data.meta?.total_count || 0;

    if (amount) {
      const data = tempData.filter((item) => {
        return item.attributes.total_cents === amount * 100;
      });

      let total_count = data.length;

      return { data: data, offSetNext, offSetPrev, total_count };
    }

    if (!isEmpty(tempData)) {
      console.log('emptyData');
      return { data: tempData, offSetNext, offSetPrev, total_count };
    }
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
  const { email, dateRange, offset = 0, filterDate, startFilterDate, endFilterDate, amount } = req.body;
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
      filterDate,
      startFilterDate,
      endFilterDate,
      amount,
    });

    // jsonRes.batches = batchesData;

    jsonRes.batches = [];
    if (!isEmpty(batchesData)) {
      jsonRes.offSetRes = { next: Number(batchesData.offSetNext), prev: Number(batchesData.offSetPrev) };
      jsonRes.total_count = batchesData.total_count;

      if (batchesData?.data && Array.isArray(batchesData.data)) {
        for (const batch of batchesData.data) {
          const batchId = batch.id;
          const donations = await fetchDonationsForBatch(batchId, headers);

          jsonRes.batches.push({
            batch,
            donations,
          });
        }
      }
    }

    const newJsonResBatches = removeDuplicateFundDesignations(jsonRes.batches);
    jsonRes.batches = newJsonResBatches;
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

interface BatchData {
  batch: any;
  donations: {
    data: DonationData[];
    included: IncludedDesignation[];
  };
}

interface DonationData {
  type: string;
  id: string;
  attributes: any;
  relationships: {
    designations: {
      data: { type: string; id: string }[];
    };
  };
}

interface IncludedDesignation {
  type: string;
  id: string;
  attributes: any;
  relationships: {
    fund: {
      data: { type: string; id: string };
    };
  };
}

function removeDuplicateFundDesignations(data: BatchData[]): BatchData[] {
  return data.map((batch) => {
    // Track funds and their associated designations
    const fundDesignations: { [fundId: string]: string[] } = {};

    // Populate fundDesignations with designation IDs
    batch.donations.included.forEach((designation) => {
      const fundId = designation.relationships.fund.data.id;
      if (!fundDesignations[fundId]) {
        fundDesignations[fundId] = [];
      }
      fundDesignations[fundId].push(designation.id);
    });

    // Determine which funds are duplicated (more than one designation)
    const duplicatedFunds = Object.keys(fundDesignations).filter((fundId) => fundDesignations[fundId].length > 1);

    // For each duplicated fund, keep only the first donation that references a designation linked to that fund

    duplicatedFunds.forEach((fundId) => {
      const designations = fundDesignations[fundId];
      const donationsForDesignations = batch.donations.data.filter((donation) =>
        donation.relationships.designations.data.some((designation) => designations.includes(designation.id)),
      );

      // Sum amounts for duplicated designations
      const totalAmountCents = donationsForDesignations.reduce(
        (sum, donation) => sum + donation.attributes.amount_cents,
        0,
      );

      // Find the first donation for the first designation to keep
      const firstDesignationId = designations[0];
      const firstDonationIndex = batch.donations.data.findIndex((donation) =>
        donation.relationships.designations.data.some((designation) => designation.id === firstDesignationId),
      );

      // Update the amount for the first donation of the first designation
      if (firstDonationIndex !== -1) {
        batch.donations.data[firstDonationIndex].attributes.amount_cents = totalAmountCents;
      }

      // Remove donations except the first one linked to the first designation
      batch.donations.data = batch.donations.data.filter(
        (donation, index) =>
          !donation.relationships.designations.data.some((designation) => designations.includes(designation.id)) ||
          index === firstDonationIndex,
      );
    });

    return batch;
  });
}
