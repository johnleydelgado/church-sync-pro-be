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
import { uploadImage } from '../utils/storage';
import userEmailPreferences from '../db/models/userEmailPreferences';
import Billing from '../db/models/billing';

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
  const { email, settingsData, settingRegistrationData } = req.body;
  try {
    const userData = await Users.findOne({ where: { email } });
    if (userData !== null) {
      const user = userData.toJSON();

      const userSettingsExist = await UserSettings.findOne({ where: { userId: user.id } });

      const dataToUpdateOrCreate = settingRegistrationData ? { settingRegistrationData } : { settingsData };
      if (userSettingsExist) {
        await UserSettings.update(dataToUpdateOrCreate, { where: { userId: user.id } });
      } else {
        await UserSettings.create({
          ...dataToUpdateOrCreate,
          userId: user.id,
          isAutomationEnable: false,
          isAutomationRegistration: false,
        });
      }

      return responseSuccess(res, 'success');
    }
    res.status(500).json({ error: 'Email not exist' });
  } catch (e) {
    console.log('ERROR: ', e);
    res.status(500).json({ error: e.message });
  }
};

export const updateRegisterSettings = async (req: Request, res: Response) => {
  const { email, settingRegistrationData } = req.body;
  try {
    const userData = await Users.findOne({ where: { email } });
    if (userData !== null) {
      const user = userData.toJSON();

      await UserSettings.update({ settingRegistrationData }, { where: { userId: user.id } });

      return responseSuccess(res, settingRegistrationData);
    }
    res.status(500).json({ error: 'Email not exist' });
  } catch (e) {
    console.log('ERROR: ', e);
    res.status(500).json({ error: e.message });
  }
};

export const enableAutoSyncSetting = async (req: Request, res: Response) => {
  const { email, isAutomationEnable, isAutomationRegistration } = req.body;
  console.log('tetasdasd', { isAutomationEnable, isAutomationRegistration, email });

  try {
    const userData = await Users.findOne({ where: { email } });
    if (userData !== null) {
      const user = userData.toJSON();
      const userSettingsExist = await UserSettings.findOne({ where: { userId: user.id } });
      if (userSettingsExist) {
        await UserSettings.update({ isAutomationEnable, isAutomationRegistration }, { where: { userId: user.id } });
      } else {
        await UserSettings.create({ isAutomationEnable, isAutomationRegistration, userId: user.id });
      }

      return responseSuccess(res, 'success');
    }
  } catch (e) {
    console.log('ERROR: ', e);
    res.status(500).json({ error: e.message });
  }
};

export const setStartDataAutomation = async (req: Request, res: Response) => {
  const { email, type, date } = req.body;
  try {
    const userData = await Users.findOne({ where: { email } });
    if (!userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userData.toJSON();
    const userSettings = await UserSettings.findOne({ where: { userId: user.id } });

    if (userSettings) {
      // User settings exist, update based on the type
      if (type === 'donation') {
        const [numberOfAffectedRows] = await UserSettings.update(
          { startDateAutomationFund: String(date) },
          { where: { userId: user.id } },
        );
      } else if (type === 'registration') {
        await UserSettings.update(
          { startDateAutomationRegistration: String(date) /* your new start date value for registration automation */ },
          { where: { userId: user.id } },
        );
      } else {
        return responseError({ res, code: 400, data: 'Invalid type' });
      }
    } else {
      // User settings do not exist, create them with the appropriate start date based on the type
      if (type === 'donation') {
        await UserSettings.create({
          userId: user.id,
          startDateAutomationFund: String(date) /* your new start date value for fund automation */,
          // Include other default or necessary fields for a new UserSettings record
        });
      } else if (type === 'registration') {
        await UserSettings.create({
          userId: user.id,
          startDateAutomationRegistration: String(date) /* your new start date value for registration automation */,
          // Include other default or necessary fields for a new UserSettings record
        });
      } else {
        return responseError({ res, code: 400, data: 'Invalid type' });
      }
    }

    return responseSuccess(res, 'Success');
  } catch (e) {
    return responseError({ res, code: 400, data: e.message });
  }
};

export const addUpdateBankSettings = async (req: Request, res: Response) => {
  const { email, data } = req.body;
  console.log('tetasdasd', { email, data });

  try {
    const userData = await Users.findOne({ where: { email } });
    if (userData !== null) {
      const user = userData.toJSON();
      const userSettingsExist = await UserSettings.findOne({ where: { userId: user.id } });
      if (userSettingsExist) {
        await UserSettings.update({ settingBankData: data }, { where: { userId: user.id } });
      } else {
        await UserSettings.create({ settingBankData: data, userId: user.id });
      }

      return responseSuccess(res, 'success');
    }
  } catch (e) {
    console.log('ERROR: ', e);
    res.status(500).json({ error: e.message });
  }
};

export const addUpdateBilling = async (req: Request, res: Response) => {
  const { email, data } = req.body;

  try {
    if (data?.userId !== null) {
      const billingDataExist = await Billing.findOne({ where: { userId: data.userId } });
      if (billingDataExist) {
        await Billing.update(data, { where: { userId: data.userId } });
      } else {
        await Billing.create({ ...data, userId: data.userId });
      }

      return responseSuccess(res, data);
    }
  } catch (e) {
    console.log('ERROR: ', e);
    res.status(500).json({ error: e.message });
  }
};

export const viewBilling = async (req: Request, res: Response) => {
  const { userId } = req.body;

  try {
    const billingDataExist = await Billing.findOne({ where: { userId } });
    if (billingDataExist) {
      return responseSuccess(res, billingDataExist);
    } else {
      return res.status(200).json({ error: 'No billing data found for this user' });
    }
  } catch (e) {
    console.log('ERROR: ', e);
    return res.status(500).json({ error: e.message });
  }
};

export const addUpdateBankCharges = async (req: Request, res: Response) => {
  const { email, data } = req.body;

  try {
    const userData = await Users.findOne({ where: { email } });
    if (userData !== null) {
      const user = userData.toJSON();
      const userSettingsExist = await UserSettings.findOne({ where: { userId: user.id } });
      if (userSettingsExist) {
        await UserSettings.update({ settingBankCharges: data }, { where: { userId: user.id } });
      } else {
        await UserSettings.create({ settingBankCharges: data, userId: user.id });
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
      await tokens.destroy({ where: { id } });
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
    const bookkeeperData = await bookkeeper.findAll({
      where: condition,
      include: [
        { model: User, as: 'Client' },
        { model: User, as: 'User' },
      ],
    });

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

export const updateUserData = async (req: Request, res: Response) => {
  const { email, firstName, lastName, churchName, userId, file, file_name } = req.body;

  try {
    const userData = await User.update({ email, firstName, lastName, churchName }, { where: { id: userId } });
    let fileName = '';
    let imageUrl = '';

    // Only call uploadImage if file and file_name exist
    if (file && file_name) {
      const imageUploadData = await uploadImage(file, file_name);
      fileName = imageUploadData.fileName;
      imageUrl = imageUploadData.imageUrl;
      await User.update({ img_url: imageUrl }, { where: { id: userId } });
    } else {
      await User.update({ email, firstName, lastName, churchName }, { where: { id: userId } });
    }

    const data = { ...userData, fileName, imageUrl };
    if (userData) {
      return responseSuccess(res, data);
    }
    return responseError({ res, code: 400, message: 'Error in user update' });
  } catch (e) {
    return responseError({ res, code: 400, message: e });
  }
};

// This function handles the CRUD operations for user email preferences.
// It allows creating, updating, and retrieving email preferences for a user.
export const crudUserEmailPreferences = async (req: Request, res: Response) => {
  const { userId, email, type } = req.body;

  try {
    if (userId && type) {
      // Check if there are existing preferences for the given user and type
      const existingPreferences = await userEmailPreferences.findOne({ where: { userId, type } });

      if (existingPreferences) {
        // If preferences exist, update the email for the user and type
        await userEmailPreferences.update({ email }, { where: { userId, type } });
        return responseSuccess(res, 'success');
      }
    }

    if (email && type) {
      // If email and type are provided, create new preferences for the user
      const preferences = await userEmailPreferences.create({ userId, email, type });
      return responseSuccess(res, 'success');
    }

    // If only userId is provided, retrieve all preferences for the user
    const preferences = await userEmailPreferences.findAll({ where: { userId } });
    return responseSuccess(res, preferences);
  } catch (e) {
    console.log('ERROR: ', e);
    return responseError({ res, code: 500, message: e.message });
  }
};
