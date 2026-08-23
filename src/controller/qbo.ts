import { Request, Response } from 'express';
import { responseError, responseSuccess } from '../utils/response';
import { getQboClientForUser } from '../services/qboClient';
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

  let qbo;
  try {
    qbo = await getQboClientForUser(email);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(message, email);
    if (message === 'No qbo token') {
      return responseError({ res, code: 500, data: 'No qbo token' });
    }
    return res.status(500).json({ error: 'Empty user data' });
  }

  const fetchAccounts = async () => {
    const accountTypes = ['Income', 'Revenue', 'Bank', 'Expense', 'Credit Card'];

    let accountList = [];

    await new Promise<void>((resolve, reject) => {
      qbo.findAccounts(
        {
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
      console.error(`Error fetching accounts for type:`, error);
    });
    return accountList;
  };

  const fetchClasses = async () => {
    return new Promise(async (resolve, reject) => {
      await qbo.findClasses((err, classes) => {
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
      await qbo.findCustomers(
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
    const qbo = await getQboClientForUser(email);

    await Promise.all(
      synchData.map((a) => {
        new Promise(async (resolve, reject) => {
          qbo.deleteDeposit(a.donationId, function (err, deleteData) {
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
    const qbo = await getQboClientForUser(email);

    qbo.findAccounts({}, function (err, data) {
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
    const qbo = await getQboClientForUser(email);

    const payload = projectPayload(projectData);

    return new Promise(async (resolve, reject) => {
      await qbo.createCustomer(payload, function (err, createdData) {
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
    const qbo = await getQboClientForUser(email);

    const payload = projectPayload(projectData);

    return new Promise(async (resolve, reject) => {
      await qbo.updateCustomer(payload, function (err, createdData) {
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

    const qbo = await getQboClientForUser(email);

    const customer = await new Promise((resolve, reject) => {
      qbo.getCustomer(Id, (err, customer) => {
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
