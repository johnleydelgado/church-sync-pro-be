/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */

import { Request, Response, NextFunction } from 'express';
import Users from '../db/models/user';
import { responseSuccess } from '../utils/response';
import UserSettings from '../db/models/userSettings';

export const updateUser = async (req: Request, res: Response) => {
  const data = req.body;
  try {
    await Users.update({ ...data }, { where: { email: data.email } });

    return responseSuccess(res, 'success');
  } catch (e) {
    console.log('ERROR: ', e);
    res.status(500).json({ error: e.message });
  }
};

export const createUser = async (req: Request, res: Response) => {
  const { email, ...rest } = req.body;
  try {
    const isEmailExist = await Users.findOne({ where: { email } });
    console.log('email', { email, ...rest });
    if (isEmailExist === null) {
      await Users.create({ email, ...rest });
      return responseSuccess(res, 'success');
    }
    res.status(500).json({ error: 'Email exist' });
  } catch (e) {
    console.log('ERROR: ', e);
    res.status(500).json({ error: e.message });
  }
};

export const createSettings = async (req: Request, res: Response) => {
  const { email, settingsData, isAutomationEnable } = req.body;
  try {
    const userData = await Users.findOne({ where: { email } });
    if (userData !== null) {
      const user = userData.toJSON();

      const userSettingsExist = await UserSettings.findOne({ where: { userId: user.id } });

      if (userSettingsExist) {
        await UserSettings.update({ settingsData, isAutomationEnable }, { where: { userId: user.id } });
        return responseSuccess(res, 'success');
      }

      await UserSettings.create({ settingsData, userId: user.id, isAutomationEnable });
      return responseSuccess(res, 'success');
    }
    res.status(500).json({ error: 'Email not exist' });
  } catch (e) {
    console.log('ERROR: ', e);
    res.status(500).json({ error: e.message });
  }
};

export const getUserRelated = async (req: Request, res: Response) => {
  const { email } = req.query;
  try {
    console.log('=========');
    const userData = await Users.findOne({
      where: { email: email as string },
      include: [UserSettings],
    });

    if (userData !== null) {
      const user = userData.toJSON();
      return responseSuccess(res, user);
    }
    res.status(500).json({ error: 'Email not exist' });
  } catch (e) {
    console.log('ERROR: ', e);
    res.status(500).json({ error: e.message });
  }
};
