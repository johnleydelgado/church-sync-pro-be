/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */

import { Request, Response, NextFunction } from 'express';
import User from '../db/models/user';
import { responseSuccess } from '../utils/response';

export const updateUser = async (req: Request, res: Response) => {
  const data = req.body;
  try {
    await User.update({ ...data }, { where: { email: data.email } });

    return responseSuccess(res, 'success');
  } catch (e) {
    console.log('ERROR: ', e);
    res.status(500).json({ error: e.message });
  }
};

export const createUser = async (req: Request, res: Response) => {
  const { email, ...rest } = req.body;
  try {
    const isEmailExist = await User.findOne({ where: { email } });
    console.log('email', { email, ...rest });
    if (isEmailExist === null) {
      await User.create({ email, ...rest });
      return responseSuccess(res, 'success');
    }
    res.status(500).json({ error: 'Email exist' });
  } catch (e) {
    console.log('ERROR: ', e);
    res.status(500).json({ error: e.message });
  }
};
