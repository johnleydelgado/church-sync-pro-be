import { Request, Response } from 'express';
import { responseError, responseSuccess } from '../utils/response';
import User from '../db/models/user';

export const addTokenInUser = async (req: Request, res: Response) => {
  const { email, ...rest } = req.body;

  try {
    const test = await User.update(rest, { where: { email: email } });
    console.log('...rest', test, email, rest);
    return responseSuccess(res, 'success');
  } catch (e) {
    return responseError({ res, code: 204, data: e });
  }
};
