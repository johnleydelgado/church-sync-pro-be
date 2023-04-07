import axios from 'axios';
import { Request, Response, NextFunction } from 'express';
import { responseError, responseSuccess } from '../utils/response';
import { url } from 'inspector';
import { isEmpty } from 'lodash';
import User from '../db/models/user';

export const getFundInDonation = async ({
  donationId,
  refresh_token,
}: {
  donationId: number;
  refresh_token: string;
}) => {
  const config = {
    headers: {
      Authorization: `Bearer ${refresh_token}`,
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

export const getBatchInDonation = async ({ refresh_token }: { refresh_token: string }) => {
  const config = {
    headers: {
      Authorization: `Bearer ${refresh_token}`,
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

    const startDate = new Date('2023-04-04');
    const endDate = new Date('2023-04-05');

    const data = tempData.filter((item) => {
      const created_at = new Date(item.attributes.created_at);
      return created_at >= startDate && created_at <= endDate;
    });

    return data;
  } catch (e) {
    return [];
  }
};

export const getBatches = async (req: Request, res: Response) => {
  const { refresh_token } = req.query;
  const config = {
    headers: {
      Authorization: `Bearer ${refresh_token}`,
    },
  };

  const jsonRes = { donation: [], funds: [] };

  try {
    const batchesData = await getBatchInDonation({ refresh_token: String(refresh_token) });

    // if (isEmpty(responseDonation.data.data)) {
    //   //return empty here
    // }
    console.log('dataOfBatches', batchesData);

    for (const dataOfBatches of batchesData) {
      const donationUrl = `https://api.planningcenteronline.com/giving/v2/batches/${dataOfBatches.id}/donations`;
      const responseDonation = await axios.get(donationUrl, config);
      // jsonRes.donation = {...jsonRes.donation, responseDonation.data.data}
      for (const donationsData of responseDonation.data.data) {
        const fundsData = await getFundInDonation({
          donationId: Number(donationsData.id),
          refresh_token: String(refresh_token),
        });

        jsonRes.donation = [...jsonRes.donation, { ...donationsData, fund: fundsData[0] || {}, batch: dataOfBatches }];
      }
    }

    // const batchesData = await getBatchInDonation({ refresh_token: String(refresh_token) });

    // for (const donationsData of responseDonation.data.data) {
    //   const fundsData = await getFundInDonation({
    //     donationId: Number(donationsData.id),
    //     refresh_token: String(refresh_token),
    //   });

    //   const batchForThisDonation = batchesData.find(
    //     (item: any) => item.id === donationsData.relationships.batch.data.id,
    //   );

    //   jsonRes.donation = [
    //     ...jsonRes.donation,
    //     { ...donationsData, fund: fundsData[0] || {}, batch: batchForThisDonation },
    //   ];
    // }

    const data = jsonRes.donation;
    return responseSuccess(res, data);
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

// export const getBatches = async (req: Request, res: Response) => {
//   const { refresh_token } = req.query;
//   const config = {
//     method: 'get',
//     url: 'https://api.planningcenteronline.com/giving/v2/batches',
//     headers: {
//       Authorization: `Bearer ${refresh_token}`,
//     },
//   };

//   try {
//     const response = await axios(config);
//     const data = response.data.data;
//     return responseSuccess(res, data);
//   } catch (e) {
//     return responseError({ res, code: 500, data: e });
//   }
// };

export const getDonations = async (req: Request, res: Response) => {
  const { email } = req.query;

  try {
    const isEmailExist = await User.findOne({ where: { email: email as string } });
    if (isEmailExist) {
      const config = {
        method: 'get',
        url: 'https://api.planningcenteronline.com/giving/v2/batch_groups',
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
