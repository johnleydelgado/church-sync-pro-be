import { Request, Response } from 'express';
import { omit } from 'lodash';
import { responseError, responseSuccess } from '../utils/response';
import User from '../db/models/user';

export const addTokenInUser = async (req: Request, res: Response) => {
  const { email, ...rest } = req.body;

  try {
    // Never the password-reset token from a request body: it would let any signed-in account plant
    // a known token on someone else's row and then reset their password.
    const test = await User.update(omit(rest, 'token'), { where: { email: email } });
    console.log('...rest', test, email, rest);
    return responseSuccess(res, 'success');
  } catch (e) {
    return responseError({ res, code: 204, data: e });
  }
};
