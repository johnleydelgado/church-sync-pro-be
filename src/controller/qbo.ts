import { Request, Response } from 'express';
import quickBookApi from '../utils/quickBookApi';
import { responseError, responseSuccess } from '../utils/response';
import User from '../db/models/user';
import quickbookAuth from '../utils/quickbookAuth';
import { generateQBOToken } from './automation';
import tokenEntity from '../db/models/tokenEntity';
import tokens from '../db/models/tokens';
import { isEmpty } from 'lodash';

export interface QBODataProps {
  accessToken: string;
  realmId: string;
  refreshToken: string;
}

// This will get the accounts,class,project and draccount
export const getAllQboData = async (req: Request, res: Response) => {
  const { email } = req.body;

  const data = await tokenEntity.findOne({
    where: { email: email as string, isEnabled: true },
    include: tokens,
  });

  if (!data) {
    return res.status(500).json({ error: 'Empty user data' });
  }

  const arr = data.tokens.find((item) => item.token_type === 'qbo');

  if (!arr) {
    return responseError({ res, code: 500, data: 'No qbo token' });
  }

  let tokenJson = { access_token: arr.access_token, refresh_token: arr.refresh_token, realm_id: arr.realm_id };

  if (!quickbookAuth.isAccessTokenValid()) {
    const result = await generateQBOToken(arr.refresh_token, email);
    tokenJson = result;
  }

  const qboTokens = {
    ACCESS_TOKEN: tokenJson.access_token,
    REALM_ID: tokenJson.realm_id,
    REFRESH_TOKEN: tokenJson.refresh_token,
  };

  const fetchAccounts = async () => {
    return new Promise(async (resolve, reject) => {
      await quickBookApi(qboTokens).findAccounts(
        {
          AccountType: 'Income',
          desc: 'MetaData.LastUpdatedTime',
        },
        function (err, accounts) {
          if (err) {
            reject(err);
          }
          const accountList = [];
          accounts.QueryResponse.Account.forEach(function (account) {
            accountList.push({ value: account.Id, name: account.Name });
          });
          resolve(accountList);
        },
      );
    });
  };

  const fetchClasses = async () => {
    return new Promise(async (resolve, reject) => {
      await quickBookApi(qboTokens).findClasses((err, classes) => {
        if (err) {
          reject(err);
        }
        const classList = [];
        classes.QueryResponse.Class.forEach(function (item) {
          classList.push({ value: item.Id, name: item.Name });
        });
        resolve(classList);
      });
    });
  };

  const fetchCustomers = async () => {
    return new Promise(async (resolve, reject) => {
      await quickBookApi(qboTokens).findCustomers(
        {
          fetchAll: true,
        },
        (err, customers) => {
          if (err) {
            reject(err);
          }
          const customerList = [];
          customers.QueryResponse.Customer.forEach(function (item) {
            customerList.push({ value: item.Id, name: item.DisplayName });
          });
          resolve(customerList);
        },
      );
    });
  };

  try {
    const jsonObject = {
      accounts: await fetchAccounts(),
      classes: await fetchClasses(),
      customers: await fetchCustomers(),
    };
    return responseSuccess(res, jsonObject);
  } catch (err) {
    console.log('fasdasdasd', err);
    res.status(500).json({ error: err.message });
  }

  // return responseSuccess(res, '');
};
