import axios from 'axios';
import { Request, Response, NextFunction } from 'express';
import { responseError, responseSuccess } from '../utils/response';

export const getBatches = async (req: Request, res: Response) => {
  const { refresh_token } = req.body;
  const config = {
    method: 'get',
    url: 'https://api.planningcenteronline.com/giving/v2/batches',
    headers: {
      Authorization: `Bearer ${refresh_token}`,
    },
  };

  try {
    const response = await axios(config);
    const data = response.data.data;
    return responseSuccess(res, data);
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

export const getFunds = async (req: Request, res: Response) => {
  const { refresh_token } = req.query;
  const config = {
    method: 'get',
    url: 'https://api.planningcenteronline.com/giving/v2/funds',
    headers: {
      Authorization: `Bearer ${refresh_token}`,
    },
  };

  try {
    const response = await axios(config);
    const data = response.data.data;
    return responseSuccess(res, data);
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};
