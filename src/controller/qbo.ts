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
import { CustomerProps, projectPayload } from '../utils/mapping';

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
    const accountTypes = ['Income', 'Revenue', 'Bank', 'Expense'];

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
                accountList.push({ value: account.Id, name: account.Name, type: account.AccountType });
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
            customerList.push({ value: item.Id, name: item.DisplayName, companyName: item.CompanyName });
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

export const getDepositRef = async (req: Request, res: Response) => {
  const { email } = req.body;

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

    quickBookApi(qboTokens).findAccounts({ AccountType: 'Bank' }, function (err, data) {
      if (err) {
      }
      console.log('asdasdas', data.QueryResponse);
    });

    return responseSuccess(res, 'success');
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

export const addProject = async (req: Request, res: Response) => {
  const { email, data } = req.body;
  const projectData: CustomerProps = data;
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

    const payload = projectPayload(projectData);

    return new Promise(async (resolve, reject) => {
      await quickBookApi(qboTokens).createCustomer(payload, function (err, createdData) {
        if (err) {
          return responseError({ res, code: 500, data: err });
        }

        const data = isEmpty(createdData) ? [] : createdData;
        resolve(data);
        return responseSuccess(res, 'success');
      });
    });
  } catch (err) {
    console.log('addProject ERROR:', err);
    return responseError({ res, code: 500, data: err });
  }
};

export const updateProject = async (req: Request, res: Response) => {
  const { email, data } = req.body;
  const projectData: CustomerProps = data;
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

    const payload = projectPayload(projectData);

    return new Promise(async (resolve, reject) => {
      await quickBookApi(qboTokens).updateCustomer(payload, function (err, createdData) {
        if (err) {
          return responseError({ res, code: 400, data: err });
        }

        const data = isEmpty(createdData) ? [] : createdData;
        resolve(data);
        return responseSuccess(res, 'success');
      });
    });
  } catch (err) {
    console.log('addProject ERROR:', err);
    return responseError({ res, code: 400, data: err });
  }
};

export const findCustomer = async (req: Request, res: Response) => {
  try {
    const { email, Id } = req.body;
    console.log('findCustomer', email, Id);
    const data = await tokenEntity.findOne({
      where: { email: email as string, isEnabled: true },
      include: tokens,
    });

    if (!data) {
      console.log('Empty user data', email);
      return res.status(500).json({ error: 'Empty user data' });
    }

    const arr = data.tokens.find((item) => item.token_type === 'qbo');
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

    const customer = await new Promise((resolve, reject) => {
      quickBookApi(qboTokens).getCustomer(Id, (err, customer) => {
        if (err) {
          reject(err);
        } else if (!customer.Active) {
          reject(new Error('Customer is not active.'));
        } else {
          resolve(customer);
        }
      });
    });

    return responseSuccess(res, customer);
  } catch (error) {
    console.error('Error in findCustomers:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
