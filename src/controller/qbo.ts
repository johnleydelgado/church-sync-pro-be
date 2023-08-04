import { Request, Response } from 'express';
import quickBookApi from '../utils/quickBookApi';
import { responseError, responseSuccess } from '../utils/response';
import User from '../db/models/user';
import quickbookAuth from '../utils/quickbookAuth';
import { generateQBOToken } from './automation';
import tokenEntity from '../db/models/tokenEntity';
import tokens from '../db/models/tokens';
import { isEmpty } from 'lodash';
import UserSync from '../db/models/UserSync';

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
    console.log('Empty user data', email);
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
    ACCESS_TOKEN: tokenJson?.access_token,
    REALM_ID: tokenJson?.realm_id,
    REFRESH_TOKEN: tokenJson?.refresh_token,
  };

  const fetchAccounts = async () => {
    const accountTypes = ['Income', 'Revenue'];

    let accountList = [];

    for (let type of accountTypes) {
      await new Promise<void>((resolve, reject) => {
        quickBookApi(qboTokens).findAccounts(
          {
            AccountType: type,
            desc: 'MetaData.LastUpdatedTime',
          },
          function (err, accounts) {
            if (err) {
              reject(err);
              return; // important to prevent further execution in case of error
            }
            if (accounts && accounts.QueryResponse && accounts.QueryResponse.Account) {
              accounts.QueryResponse.Account.forEach(function (account) {
                accountList.push({ value: account.Id, name: account.Name });
              });
            }
            resolve();
          },
        );
      }).catch((error) => {
        console.error(`Error fetching accounts for type ${type}:`, error);
      });
    }
    return accountList;
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

export const deleteQboDeposit = async (req: Request, res: Response) => {
  const { email, synchData } = req.body;
  try {
    const data = await tokenEntity.findOne({
      where: { email: email as string, isEnabled: true },
      include: tokens,
    });

    if (!data) {
      console.log('Empty user data', email);
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

    await Promise.all(
      synchData.map((a) => {
        new Promise(async (resolve, reject) => {
          quickBookApi(qboTokens).deleteDeposit(a.donationId, function (err, deleteData) {
            if (err) {
              reject(err);
            }

            const data = isEmpty(deleteData) ? [] : deleteData;
            resolve(data);
          });
        });
      }),
    );

    await Promise.all(synchData.map((a) => UserSync.destroy({ where: { id: a.id } })));
    return responseSuccess(res, 'success');
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};
