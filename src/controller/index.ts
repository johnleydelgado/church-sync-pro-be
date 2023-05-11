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
const sgMail = require('@sendgrid/mail');

export const sendEmail = async (req: Request, res: Response) => {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const htmlFile = await fs.promises.readFile('src/template/msg.html', 'utf-8');
  const msg = {
    to: 'johnley00@gmail.com', // Change to your recipient
    from: 'support@churchsyncpro.com', // Change to your verified sender
    subject: 'Sending with SendGrid is Fun',
    text: 'and easy to do anywhere, even with Node.js',
    html: htmlFile,
  };
  sgMail
    .send(msg)
    .then(() => {
      console.log('Email sent');
    })
    .catch((error: any) => {
      console.error(error);
    });
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
  console.log('aaa', email);
  const jsonRes = { donation: [] as any }; //this is an array object

  try {
    const user = await generatePcToken('', String(email));
    const { access_token_pc, id } = user;

    const config = {
      headers: {
        Authorization: `Bearer ${access_token_pc}`,
      },
    };

    const synchedBatchesData = await UserSync.findAll({
      where: { userId: user.id, batchId: batchId as string },
      attributes: ['id', 'batchId', 'createdAt'],
    });

    const settingsJson = await UserSettings.findOne({ where: { userId: id } });
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
        access_token: String(access_token_pc),
      });
      const fundName = fundsData[0].attributes.name;
      const settingsItem = settingsData.find((item: SettingsJsonProps) => item.fundName === fundName);
      const accountRef = settingsItem?.account?.value ?? '';
      const receivedFrom = settingsItem?.customer?.value ?? '';
      const classRef = settingsItem?.class?.value ?? '';

      jsonRes.donation = [
        ...jsonRes.donation,
        { ...donationsData, fund: fundsData[0] || {}, batch: dataBatch, accountRef, receivedFrom, classRef },
      ];
    }
    if (!isEmpty(jsonRes.donation)) {
      const data = requestPayload(jsonRes.donation);
      let count = 0;
      for (const payloadJson of data) {
        await automationDeposit(email as string, payloadJson);
        await UserSync.create({
          syncedData: jsonRes.donation,
          userId: user.id,
          batchId: jsonRes.donation[count].batch.id,
        });
        count += 1;
      }
    }

    return responseSuccess(res, 'success');
  } catch (e) {
    console.log('error', e);
  }
};
