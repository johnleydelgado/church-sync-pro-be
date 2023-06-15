/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */

import { Request, Response, NextFunction } from 'express';
import Users from '../db/models/user';
import { responseError, responseSuccess } from '../utils/response';
import UserSettings from '../db/models/userSettings';
import tokens from '../db/models/tokens';
import tokenEntity from '../db/models/tokenEntity';
import { isEmpty } from 'lodash';
import bookkeeper from '../db/models/bookkeeper';
import User from '../db/models/user';

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
    console.log('createUser', { email, ...rest });
    const isEmailExist = await Users.findOne({ where: { email } });
    if (!isEmailExist) {
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
  const { email, settingsData, isAutomationEnable, settingRegistrationData } = req.body;
  try {
    const userData = await Users.findOne({ where: { email } });
    if (userData !== null) {
      const user = userData.toJSON();

      const userSettingsExist = await UserSettings.findOne({ where: { userId: user.id } });
      const dataToUpdateOrCreate = settingRegistrationData
        ? { settingRegistrationData, isAutomationEnable }
        : { settingsData, isAutomationEnable };

      if (userSettingsExist) {
        await UserSettings.update(dataToUpdateOrCreate, { where: { userId: user.id } });
      } else {
        await UserSettings.create({ ...dataToUpdateOrCreate, userId: user.id });
      }

      return responseSuccess(res, 'success');
    }
    res.status(500).json({ error: 'Email not exist' });
  } catch (e) {
    console.log('ERROR: ', e);
    res.status(500).json({ error: e.message });
  }
};

export const enableAutoSyncSetting = async (req: Request, res: Response) => {
  const { email, isAutomationEnable } = req.body;

  try {
    const userData = await Users.findOne({ where: { email } });
    if (userData !== null) {
      const user = userData.toJSON();
      const userSettingsExist = await UserSettings.findOne({ where: { userId: user.id } });
      if (userSettingsExist) {
        await UserSettings.update({ isAutomationEnable }, { where: { userId: user.id } });
      } else {
        await UserSettings.create({ isAutomationEnable, userId: user.id });
      }

      return responseSuccess(res, 'success');
    }
  } catch (e) {
    console.log('ERROR: ', e);
    res.status(500).json({ error: e.message });
  }
};

export const getUserRelated = async (req: Request, res: Response) => {
  const { email } = req.query;
  try {
    const userData = await Users.findOne({
      where: { email: email as string },
      include: [{ model: bookkeeper, as: 'UserBookkeepers' }, { model: UserSettings }],
    });
    console.log('userData', userData);
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

export const isUserHaveTokens = async (req: Request, res: Response) => {
  const { email } = req.body;
  try {
    if (email) {
      const tokenData = await tokenEntity.findAll({
        where: { email: email as string },
        include: tokens,
      });

      if (tokenData.length === 0) {
        return responseError({ res, code: 204, data: 'Token not found' });
      }

      const result = tokenData.find((a) => a.dataValues.isEnabled);

      if (result.tokens.length > 2) {
        return responseSuccess(res, 'All three tokens are exist');
      }
      return responseError({ res, code: 204, data: false });
    }
    return responseError({ res, code: 204, data: 'Email not found' });
  } catch (e) {
    console.log('ERROR: ', e);
    return responseError({ res, code: 204, data: e });
  }
};

export const deleteUserToken = async (req: Request, res: Response) => {
  const { id } = req.body;
  try {
    if (id) {
      await tokens.update({ refresh_token: '', access_token: '' }, { where: { id } });
      return responseSuccess(res, 'Delete token success');
    }
    return responseError({ res, code: 204, data: false });
  } catch (e) {
    console.log('ERROR: ', e);
    return responseError({ res, code: 204, data: e });
  }
};

export const getTokenList = async (req: Request, res: Response) => {
  const { email } = req.body;
  try {
    if (email) {
      const data = await tokenEntity.findAll({
        where: { email: email as string },
        include: tokens,
      });

      if (!isEmpty(data)) {
        const user = data;
        if (user) {
          return responseSuccess(res, user);
        }
        return responseError({ res, code: 500, data: false });
      }
    }
    return responseError({ res, code: 204, data: 'Email not found' });
  } catch (e) {
    console.log('ERROR: ', e);
    return responseError({ res, code: 204, data: e });
  }
};

export const updateUserTokens = async (req: Request, res: Response) => {
  const data = req.body;
  const { email, enableEntity, tokenEntityId } = req.body;
  try {
    let tokenId = 0;
    if (Array.isArray(data.tokens) && data.tokens.length > 0) {
      tokenId = data.tokens[0].id;
    }

    const isTokenExist = await tokens.findOne({ where: { id: tokenId } });

    // enable tokenEntity
    if (enableEntity) {
      // req body should be email, enableEntity, id
      await tokenEntity.update({ isEnabled: false }, { where: { email } });
      await tokenEntity.update({ isEnabled: true }, { where: { id: tokenEntityId } });
      return responseSuccess(res, 'success');
    }

    if (isTokenExist) {
      // rename orgization name
      if (data.organization_name) {
        await Promise.all(
          data.tokens.map(
            async (a) => await tokens.update({ organization_name: data.organization_name }, { where: { id: a.id } }),
          ),
        );
      } else {
        // update tokens
        await Promise.all(data.tokens.map(async (a) => await tokens.update({ ...a }, { where: { id: a.id } })));
      }
    } else {
      // delete
      if (data.isDeleted) {
        await tokenEntity.destroy({ where: { id: tokenEntityId } });
        return responseSuccess(res, 'success');
      }
      // create
      const userCreated = await tokenEntity.create({ email: data.email });
      await Promise.all(
        ['pco', 'qbo', 'stripe'].map(
          async (a) => await tokens.create({ ...data, tokenEntityId: userCreated.id, token_type: a }),
        ),
      );
    }

    return responseSuccess(res, 'success');
  } catch (e) {
    console.log('ERROR: ', e);
    return responseError({ res, code: 400, message: e });
  }
};

export const updateUserToken = async (req: Request, res: Response) => {
  const data = req.body;
  const { email, token_type } = req.body;

  try {
    const tokenEntityData = await tokenEntity.findOne({ where: { email } });

    if (!isEmpty(tokenEntityData)) {
      // update tokens
      const token = await tokens.findAll({ where: { tokenEntityId: tokenEntityData.id } });
      const isExist = token.find((a) => a.token_type === token_type);
      if (!isExist) {
        await tokens.create({ ...data, tokenEntityId: tokenEntityData.id, token_type });
      }
    } else {
      // create
      const userCreated = await tokenEntity.create({ email: data.email, isEnabled: true });
      await tokens.create({ ...data, tokenEntityId: userCreated.id, token_type });
    }

    return responseSuccess(res, 'success');
  } catch (e) {
    console.log('ERROR: ', e);
    return responseError({ res, code: 400, message: e });
  }
};

export const checkValidInvitation = async (req: Request, res: Response) => {
  const { email, invitationToken } = req.body;
  try {
    const invitation = await bookkeeper.findOne({ where: { email, invitationToken } });

    if (invitation) {
      return responseSuccess(res, 'exist');
    }
    return responseError({ res, code: 400, message: 'not found !' });
  } catch (e) {
    return responseError({ res, code: 400, message: e });
  }
};

export const bookkeeperList = async (req: Request, res: Response) => {
  const { clientId, bookkeeperId } = req.body;
  try {
    let condition;
    if (clientId) {
      condition = { clientId };
    } else {
      condition = { userId: bookkeeperId };
    }

    console.log('clientId', clientId);
    const bookkeeperData = await bookkeeper.findAll({ where: condition, include: [{ model: User, as: 'Client' }] });

    if (bookkeeperData) {
      return responseSuccess(res, bookkeeperData);
    }
    return responseError({ res, code: 400, message: 'not found !' });
  } catch (e) {
    return responseError({ res, code: 400, message: e });
  }
};

export const updateInvitationStatus = async (req: Request, res: Response) => {
  const { email, bookkeeperId } = req.body;

  try {
    const updateData = { inviteAccepted: true };
    if (bookkeeperId) {
      updateData['userId'] = bookkeeperId;
    }

    const bookkeeperData = await bookkeeper.update(updateData, { where: { email } });

    if (bookkeeperData) {
      return responseSuccess(res, bookkeeperData);
    }
    return responseError({ res, code: 400, message: 'Error in invitation' });
  } catch (e) {
    return responseError({ res, code: 400, message: e });
  }
};
