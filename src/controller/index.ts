/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */
import axios from 'axios';
import { Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import user from '../db/models/user';
import quickBookApi from '../utils/quickBookApi';
import { responseError, responseSuccess } from '../utils/response';
import { isEmpty } from 'lodash';
import UserSync from '../db/models/UserSync';
import UserSettings from '../db/models/userSettings';
import User from '../db/models/user';
import crypto from 'crypto';
import bookkeeper from '../db/models/bookkeeper';
import { SessionRequest } from 'supertokens-node/lib/build/framework/express';
import ThirdParty from 'supertokens-node/recipe/thirdparty';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import { syncBatchToJournalEntries } from '../services/syncEngine';

const sgMail = require('@sendgrid/mail');
const { SENDGRID_API_KEY, INVITATION_URL, RESET_PASSWORD_URL } = process.env;

export const sendEmailInvitation = async (req: Request, res: Response) => {
  const { name, emailTo, clientId, createdByBk, bookkeeperId } = req.body;
  const rand = crypto.randomBytes(16).toString('hex');

  sgMail.setApiKey(SENDGRID_API_KEY);
  const inviteLink = INVITATION_URL + `?bookkeeperEmail=${emailTo}&invitationToken=${rand}`;

  try {
    // Create bookkeeper in the database
    await bookkeeper.create({
      email: emailTo,
      inviteSent: true,
      invitationToken: rand,
      inviteAccepted: !!createdByBk,
      clientId,
      bookkeeperIntegrationAccessEnabled: false,
      ...(createdByBk ? { userId: bookkeeperId } : {}), // Conditionally add userId
    });

    // Send email only if createdByBk is not true
    if (!createdByBk) {
      const msg = {
        to: emailTo,
        from: 'support@churchsyncpro.com',
        subject: 'You have been invited to take on the role of a bookkeeper.',
        templateId: 'd-4529481214ab4c4e85018b4dfb3b6f20',
        dynamicTemplateData: {
          inviteLink,
        },
      };
      await sgMail.send(msg);
    }

    return responseSuccess(res, createdByBk ? 'Bookkeeper created without email' : 'Email sent');
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

export const sendPasswordReset = async (req: Request, res: Response) => {
  const { email } = req.body;
  const rand = crypto.randomBytes(16).toString('hex');

  sgMail.setApiKey(SENDGRID_API_KEY);
  const gotoUrl = RESET_PASSWORD_URL + `?email=${email}&token=${rand}`;
  // const htmlFile = await fs.promises.readFile('src/template/msg.html', 'utf-8');

  try {
    const userDetails = await User.findOne({ where: { email } });
    if (userDetails === null) {
      return responseError({ res, code: 200, data: 'User not found !' });
    }

    await User.update({ token: rand }, { where: { email } });

    const msg = {
      to: email, // Change to your recipient
      from: 'support@churchsyncpro.com', // Change to your verified sender
      subject: 'We have acknowledged your request to change your password.',
      // text: 'and easy to do anywhere, even with Node.js',
      templateId: 'd-62ebb25d19fd42b8aebdf940d93a2fc7',
      dynamicTemplateData: {
        name: userDetails.firstName,
        gotoUrl,
      },
    };
    await sgMail.send(msg);
    return responseSuccess(res, 'email sent password reset');
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

export const resetPassword = async (req: Request, res: Response) => {
  const { email, token, password } = req.body;
  const rand = crypto.randomBytes(16).toString('hex');

  try {
    const userDetails = await User.findOne({ where: { email, token } });
    console.log('userDetails', userDetails);
    if (userDetails === null) {
      return responseError({ res, code: 500, data: 'User not found ! or invalid token' });
    }

    let userInfo = await EmailPassword.getUserByEmail(email);

    if (userInfo === undefined) {
      throw new Error('Should never come here');
    }

    await EmailPassword.updateEmailOrPassword({
      userId: userInfo.id,
      password: password,
    });

    await User.update({ token: rand }, { where: { email, token } });

    return responseSuccess(res, 'sucess');
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

export const deleteBookeeper = async (req: Request, res: Response) => {
  const { id } = req.body;
  try {
    await bookkeeper.destroy({ where: { id } });

    return responseSuccess(res, 'deleted');
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

export const getBatches = async (req: Request, res: Response, next: NextFunction) => {
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

export const tesst = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // await user.create({
    //   email: 'test@gmail.com',
    //   firstName: 'test',
    //   lastName: 'ts',
    //   password: '123123213',
    //   isSubscribe: false,
    // });

    return responseSuccess(res, 'working');
  } catch (e) {
    console.log('er', e);
  }
};

export const manualSync = async (req: Request, res: Response) => {
  const { email, batchId = '0', realBatchId, bankData, donations } = req.body; // refresh token if for pc

  try {
    const user = await User.findOne({
      where: { email: email as string },
    });

    // Guard empty user BEFORE any `user.id` dereference below - a nonexistent email otherwise throws
    // a TypeError (caught as a 404) instead of the intended "Empty User" 500.
    if (isEmpty(user)) {
      return responseError({ res, code: 500, data: 'Empty User' });
    }

    if (batchId === '0') {
      return responseError({ res, code: 204, data: 'Dont have batch id' });
    }

    const synchedBatchesData = await UserSync.findAll({
      where: { userId: user.id, batchId: realBatchId as string },
      attributes: ['id', 'batchId', 'status', 'createdAt'],
    });

    const settingsJson = await UserSettings.findOne({ where: { userId: user.id } });

    // Already-synced guard: if any day for this (userId + realBatchId) is already posted, treat as
    // synced. The engine's own claim-then-post + fast-path is the authoritative dedupe; this keeps
    // the previous fast-fail UX for an already-completed batch.
    if (synchedBatchesData.some((a) => a.status === 'posted')) {
      return responseError({ res, code: 500, data: 'Batch ID is already synched' });
    }

    if (isEmpty(settingsJson)) {
      return responseError({ res, code: 500, data: 'Settings not set !' });
    }

    if (!donations || donations.length === 0) {
      throw new Error(`Empty donations`);
    }

    // Unified path: manual sync now produces the SAME per-day Journal Entries as automated sync
    // (claim-then-post + fast-path + Stripe-electronic filter), replacing the old single Deposit.
    // The engine records `UserSync.batchId = realBatchId`, so the batch-list checkmark keeps working.
    const result = await syncBatchToJournalEntries({
      user,
      batchId: String(batchId),
      realBatchId,
      bankData,
    });

    return responseSuccess(res, result);
  } catch (e) {
    return responseError({ res, code: 404, message: e.message || 'Error' });
  }
};

export const healthCheck = async (req: SessionRequest, res: Response) => {
  if (req.session!.getUserId()) {
    return res.status(200).json(true);
    // session exists
  } else {
    return res.status(500).json(false);
    // session doesn't exist
  }
};
