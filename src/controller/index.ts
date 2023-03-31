/* eslint-disable @typescript-eslint/no-var-requires */
import axios from 'axios';
import { Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import user from '../db/models/user';
import quickBookApi from '../utils/quickBookApi';
import { responseError, responseSuccess } from '../utils/response';
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
