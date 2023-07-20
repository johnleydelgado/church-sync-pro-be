/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */
import axios from 'axios';
import { Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import user from '../db/models/user';
import quickBookApi from '../utils/quickBookApi';
import { responseError, responseSuccess } from '../utils/response';
import { automationDeposit, generatePcToken, getFundInDonation } from './automation';
import { isEmpty } from 'lodash';
import UserSync from '../db/models/UserSync';
import { SettingsJsonProps, requestPayload } from '../utils/mapping';
import UserSettings from '../db/models/userSettings';
import User from '../db/models/user';
import crypto from 'crypto';
import bookkeeper from '../db/models/bookkeeper';
import { SessionRequest } from 'supertokens-node/lib/build/framework/express';

const sgMail = require('@sendgrid/mail');
const { SENDGRID_API_KEY, INVITATION_URL } = process.env;

export const sendEmailInvitation = async (req: Request, res: Response) => {
  const { name, emailTo, clientId } = req.body;
  const rand = crypto.randomBytes(16).toString('hex');

  sgMail.setApiKey(SENDGRID_API_KEY);
  const inviteLink = INVITATION_URL + `?bookkeeperEmail=${emailTo}&invitationToken=${rand}`;
  // const htmlFile = await fs.promises.readFile('src/template/msg.html', 'utf-8');

  try {
    await bookkeeper.create({ email: emailTo, inviteSent: true, invitationToken: rand, clientId });
    const msg = {
      to: emailTo, // Change to your recipient
      from: 'support@churchsyncpro.com', // Change to your verified sender
      subject: 'Invitation in Church Sync Pro',
      // text: 'and easy to do anywhere, even with Node.js',
      templateId: 'd-4529481214ab4c4e85018b4dfb3b6f20',
      dynamicTemplateData: {
        name,
        inviteLink,
      },
    };
    await sgMail.send(msg);
    return responseSuccess(res, 'email sent');
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

export const createPayment = async (req: Request, res: Response) => {
  const { amount, ACCESS_TOKEN, REALM_ID, REFRESH_TOKEN } = req.body;
  // if (!ACCESS_TOKEN) {
  //   getData(req, res);
  // }
  quickBookApi({ ACCESS_TOKEN, REALM_ID, REFRESH_TOKEN }).createPayment({
    TotalAmt: amount,
    CustomerRef: {
      value: '20',
    },
  });

  return responseSuccess(res, '');
};

export const manualSync = async (req: Request, res: Response) => {
  const { email, dataBatch, batchId = '0' } = req.body; // refresh token if for pc
  const jsonRes = { donation: [] as any }; //this is an array object
  try {
    const tokenEntity = await generatePcToken(String(email));
    const user = await User.findOne({
      where: { email: email as string },
    });

    const { access_token } = tokenEntity;

    const config = {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    };

    if (batchId === '0') {
      return responseError({ res, code: 204, data: 'Dont have batch id' });
    }

    const synchedBatchesData = await UserSync.findAll({
      where: { userId: user.id, batchId: batchId as string },
      attributes: ['id', 'batchId', 'createdAt'],
    });

    const settingsJson = await UserSettings.findOne({ where: { userId: user.id } });
    const settingsData = settingsJson.settingsData as any;

    if (!isEmpty(synchedBatchesData)) {
      return responseError({ res, code: 500, data: 'Batch ID is already synched' });
    }

    if (isEmpty(user)) {
      return responseError({ res, code: 500, data: 'Empty User' });
    }

    if (isEmpty(settingsJson)) {
      return responseError({ res, code: 500, data: 'Settings not set !' });
    }

    const donationUrl = `https://api.planningcenteronline.com/giving/v2/batches/${batchId}/donations`;
    const responseDonation = await axios.get(donationUrl, config);
    // jsonRes.donation = {...jsonRes.donation, responseDonation.data.data}
    for (const donationsData of responseDonation.data.data) {
      const fundsData = await getFundInDonation({
        donationId: Number(donationsData.id),
        access_token: String(access_token),
      });
      const fundName = fundsData[0].attributes.name;
      const settingsItem = settingsData.find((item: SettingsJsonProps) => item.fundName === fundName);
      const accountRef = settingsItem?.account?.value ?? '';
      const receivedFrom = settingsItem?.customer?.value ?? '';
      const classRef = settingsItem?.class?.value ?? '';
      const paymentCheck = donationsData.attributes.payment_check_number || '';

      jsonRes.donation = [
        ...jsonRes.donation,
        {
          ...donationsData,
          fund: fundsData[0] || {},
          batch: dataBatch,
          accountRef,
          receivedFrom,
          classRef,
          paymentCheck,
        },
      ];
    }
    if (!isEmpty(jsonRes.donation)) {
      const data = requestPayload(jsonRes.donation);
      let count = 0;
      for (const payloadJson of data) {
        const bqoCreatedDataId = await automationDeposit(email as string, payloadJson);
        console.log('bqoCreatedDataId', bqoCreatedDataId);
        const batchId = jsonRes.donation[count].batch.id;
        const batchExist = synchedBatchesData.find((a) => a.batchId === batchId && a.userId === user.id);

        if (isEmpty(batchExist)) {
          await UserSync.create({
            syncedData: jsonRes.donation,
            userId: user.id,
            batchId: batchId,
            donationId: bqoCreatedDataId['Id'] || '',
          });
        }
        count += 1;
      }
    }

    return responseSuccess(res, 'success');
  } catch (e) {
    console.log('error', e);
    return responseError({ res, code: 500, data: e });
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
