import { Request, Response } from 'express';
import quickBookApi from '../utils/quickBookApi';
import { responseError, responseSuccess } from '../utils/response';
import User from '../db/models/user';
import quickbookAuth from '../utils/quickbookAuth';
import { generateQBOToken } from './automation';
import { isEmpty } from 'lodash';

export interface QBODataProps {
  accessToken: string;
  realmId: string;
  refreshToken: string;
}

// This will get the accounts,class,project and draccount
export const getAllQboData = async (req: Request, res: Response) => {
  const { email } = req.body;

  const userData = await User.findOne({ where: { email: email } });
  if (!userData) {
    return res.status(500).json({ error: 'Empty user data' });
  }

  const userJson = userData.toJSON();

  if (!quickbookAuth.isAccessTokenValid()) {
    await generateQBOToken(userJson.refresh_token_qbo, email);
  }

  const qboTokens = {
    ACCESS_TOKEN: userJson.access_token_qbo,
    REALM_ID: userJson.realm_id,
    REFRESH_TOKEN: userJson.refresh_token_qbo,
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
    res.status(500).json({ error: err.message });
  }

  // return responseSuccess(res, '');
};
