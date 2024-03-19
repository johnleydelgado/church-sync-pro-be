import { isEmpty } from 'lodash';
import { automationDeposit, generatePcToken, getFundInDonation } from '../controller/automation';
import UserSync from '../db/models/UserSync';
import UserSettings from '../db/models/userSettings';
import axios from 'axios';
import { SettingsJsonProps, newRequestPayload } from './mapping';
import { format } from 'date-fns';
import { checkEmpty } from './helper';

interface User {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  churchName: string;
  isSubscribe: string;
  role: 'client' | 'bookkeeper';
  token: string | null;
  img_url: string;
  createdAt: string;
  updatedAt: string;
  UserSetting: UserSetting;
  tokens: Token[];
}

interface UserSetting {
  id: number;
  settingsData: SettingsDataItem[];
  settingRegistrationData: SettingRegistrationDataItem[];
  settingBankData: SettingBankDataItem[];
  settingBankCharges: SettingBankCharges;
  isAutomationEnable: boolean;
  isAutomationRegistration: boolean;
  userId: number;
  createdAt: string;
  updatedAt: string;
}

interface SettingsDataItem {
  fundName?: string;
  account?: Account;
}

interface SettingRegistrationDataItem {
  registration?: string;
  account?: Account;
  isActive?: boolean;
}

interface SettingBankDataItem {
  type: string;
  label: string;
  value: string;
}

interface SettingBankCharges {
  account: Account;
  class: Class;
}

interface Account {
  value: string;
  label: string;
}

interface Class {
  label: string;
  value: string;
}

interface Token {
  id: number;
  userId: number;
  tokenEntityId: number;
  token_type: 'pco' | 'stripe' | 'qbo';
  access_token: string;
  refresh_token: string;
  realm_id: string | null;
  organization_name: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StripeSyncData {
  [key: string]: FundData[] | undefined; // Index signature allowing dynamic keys
}

interface BankData {
  type: string;
  label: string;
  value: string;
}

interface BatchData {
  amount: number;
  created: string;
  fundName: string;
  payoutDate: string;
  totalAmount: number;
  type: 'registration' | 'batch';
  totalFee?: number;
  selectedBankExpense?: string;
  description?: string;
  // Add more fields here if there are any other properties in batchData
}

interface FundData {
  bankData: BankData[];
  batchData: BatchData;
  email: string;
}

const capitalAtFirstLetter = (str: string | undefined) => {
  const name = str || '';
  const fString = name.charAt(0).toUpperCase() + name.slice(1);
  return fString;
};

const extractCategory = (description: string): string => {
  const parts = description.split(' - ').map((part) => part.trim());
  let category = '';

  // Check if the last part contains an amount in parentheses
  if (/\(\$.*\)$/.test(parts[parts.length - 1] ?? '')) {
    // If so, the category is the part immediately before the last
    if (parts.length === 3 && /\(.*\)$/.test(parts[2] ?? '')) {
      category = parts[2]?.replace(/\s*\(.*\)$/, '') ?? '';
    } else {
      category = parts.slice(0, -1).join(' - ');
      category = category.split(' - ').slice(2).join(' - ');
    }
  } else {
    // Otherwise, join all parts after the first two to get the category
    category = parts.slice(2).join(' - ');
  }
  return category;
};

export const dailySyncing = async (user: any, dataBatch: any, batchId = '0', realBatchId: any, bankData: any) => {
  // const { email, dataBatch, batchId = '0', realBatchId, bankData } = req.body; // refresh token if for pc
  const userDetails: User = user;
  const { email, id: userId, token, UserSetting } = userDetails;

  const jsonRes = { donation: [] as any }; //this is an array object
  const bank = bankData as
    | {
        type: 'donation' | 'registration';
        value: string;
        label: string;
      }[]
    | null;

  try {
    const tokenEntity = await generatePcToken(String(email));

    const { access_token } = tokenEntity;

    const config = {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    };

    if (batchId === '0') {
      return 'Dont have batch id';
    }

    const synchedBatchesData = await UserSync.findAll({
      where: { userId, batchId: realBatchId as string },
      attributes: ['id', 'batchId', 'createdAt'],
    });

    const settingsJson = await UserSettings.findOne({ where: { userId } });
    const settingsData = settingsJson.settingsData as any;

    if (!isEmpty(synchedBatchesData)) {
      return 'Batch ID is already synched';
    }

    if (isEmpty(settingsJson)) {
      // return responseError({ res, code: 500, data: 'Settings not set !' });
    }

    const donationUrl = `https://api.planningcenteronline.com/giving/v2/batches/${batchId}/donations?include=designations`;
    const responseDonation = await axios.get(donationUrl, config);
    // return responseDonation.data;
    const included = responseDonation.data.included;
    let fData = responseDonation.data.data;

    // Step 1: Map fund IDs to their related designations
    const fundIdToDesignations = included.reduce((acc, designation) => {
      const fundId = designation.relationships.fund.data.id;
      if (!acc[fundId]) {
        acc[fundId] = [];
      }
      acc[fundId].push(designation);
      return acc;
    }, {});

    // Step 2: Find duplicates and sum their amounts
    Object.keys(fundIdToDesignations).forEach((fundId) => {
      if (fundIdToDesignations[fundId].length > 1) {
        // Found duplicates
        const summedAmount = fundIdToDesignations[fundId].reduce((sum, designation) => {
          const donationId = designation.id;
          const donation = fData.find((donation) =>
            donation.relationships.designations.data.some((d) => d.id === donationId),
          );
          return sum + donation.attributes.amount_cents;
        }, 0);

        // Update the first donation with the summed amount and mark others for removal or update them as needed
        let isFirstUpdated = false;
        fundIdToDesignations[fundId].forEach((designation) => {
          const donationId = designation.id;
          const donationIndex = fData.findIndex((donation) =>
            donation.relationships.designations.data.some((d) => d.id === donationId),
          );
          if (!isFirstUpdated) {
            fData[donationIndex].attributes.amount_cents = summedAmount;
            isFirstUpdated = true;
          } else {
            // Remove the duplicate donation or handle it as needed
            // For example, to remove, you can mark it and then filter out later
            fData[donationIndex]._remove = true; // Mark for removal
          }
        });
      }
    });

    // Optional: Remove marked donations
    const updatedData = fData.filter((donation) => !donation._remove);

    for (const donationsData of updatedData) {
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
      const bankRef = bank.find((a) => a.type === 'donation') || {};

      const donationDate = donationsData?.attributes?.completed_at
        ? new Date(donationsData?.attributes?.completed_at)
        : new Date();

      const TxnDate = format(donationDate, 'yyyy-MM-dd');

      jsonRes.donation = [
        ...jsonRes.donation,
        {
          ...donationsData,
          TxnDate,
          fund: fundsData[0] || {},
          batch: dataBatch,
          accountRef,
          receivedFrom,
          classRef,
          paymentCheck,
          bankRef,
        },
      ];
    }
    if (!isEmpty(jsonRes.donation)) {
      const data = newRequestPayload(jsonRes.donation);
      const bqoCreatedDataId = await automationDeposit(email as string, data);
      const batchExist = synchedBatchesData.find((a) => a.batchId === batchId && a.userId === user.id);

      if (isEmpty(batchExist)) {
        await UserSync.create({
          syncedData: jsonRes.donation,
          userId: user.id,
          batchId: `${batchId} - ${email}`,
          donationId: bqoCreatedDataId['Id'] || '',
        });
      }
    }

    // return responseSuccess(res, 'success');
  } catch (e) {
    console.log('error', e);
    // return responseError({ res, code: 500, data: e });
  }
};

export const dailySyncingRegistration = async (user: any, filterFundName: any, stripeData: any) => {
  await Promise.all(
    stripeData.data.map((item: any) => {
      const description = item.description;
      const regex = /#(\d+)/;
      const match = description?.match(regex);

      if (match) {
        const donationId = match[1];
        const index = filterFundName?.findIndex((word) => description.includes(word));
        const email = user.email;
        const regName = extractCategory(description);
        const fundName = filterFundName[index];
        const registrationFund = user.UserSetting.settingRegistrationData.find(
          (item: any) => item.registration === regName,
        );
        const fundNameRegistration = registrationFund
          ? `${capitalAtFirstLetter(registrationFund?.class?.label || '')} (${capitalAtFirstLetter(regName || '')})`
          : '';
        const fundReg =
          filterFundName?.find((word) => fundNameRegistration.toLowerCase().includes(word.toLowerCase())) ||
          registrationFund?.class?.label ||
          '';
        let arr = {};
        if (index !== -1) {
          arr = {
            ...arr,
            email,
            batchData: {
              amount: item.amount,
              created: stripeData.payoutDate,
              fundName: fundName,
              payoutDate: stripeData.payoutDate,
              totalAmount: item.amount,
              type: 'batch',
            },
            bankData: user.UserSetting.settingBankData,
            fee: item.fee,
          };
        } else {
          arr = {
            ...arr,
            email,
            batchData: {
              amount: item.amount,
              created: stripeData.payoutDate,
              fundName: fundReg,
              payoutDate: stripeData.payoutDate,
              totalAmount: item.amount,
              type: 'registration',
              description: regName || '',
            },
            bankData: user.UserSetting.settingBankData,
            fee: item.fee,
          };
        }
        return Promise.resolve(arr);
      }
    }),
  ).then(async (results: any[]) => {
    // Calculate fund totals and update results in one pass
    const updatedResults = results.map((item) => {
      const fundName = item.batchData?.fundName;
      if (fundName) {
        const fundTotal = results.reduce((acc, curr) => {
          return curr.batchData?.fundName === fundName ? acc + curr.batchData.totalAmount : acc;
        }, 0);
        return {
          ...item,
          batchData: {
            ...item.batchData,
            totalAmount: fundTotal,
          },
        };
      }
      return item;
    });

    // Grouping the updated results by fundName
    const groupedResults = updatedResults.reduce((acc, curr) => {
      const fundName = curr.batchData?.fundName;
      const fee = curr.fee || 0;
      if (fundName) {
        if (!acc[fundName]) {
          acc[fundName] = [];
        }
        acc[fundName].push(curr);
      } else {
        if (!acc['Empty']) {
          acc['Empty'] = [];
        }
        acc['Empty'].push(curr);
      }
      // Initialize Charge object if it doesn't exist
      if (!acc['Charge']) {
        acc['Charge'] = [
          {
            email: curr?.email,
            batchData: {
              amount: 0,
              created: stripeData.payoutDate,
              fundName: '',
              payoutDate: stripeData.payoutDate,
              totalAmount: 0,
              type: 'registration',
              totalFee: 0,
            },
            bankData: user.UserSetting.settingBankData,
          },
        ];
      }
      // Accumulate fees in Charge object
      acc['Charge'][0].batchData.totalFee += fee;
      return acc;
    }, {});

    try {
      await finalSyncStripe(groupedResults, user);
    } catch (e) {
      console.error(e);
    }
  });
};

export const finalSyncStripe = async (data: any, user: any) => {
  const batchData: StripeSyncData = data;
  console.log('data', user.UserSetting);
  try {
    let finalData: any = [];
    const keys = Object.keys(batchData);

    for (const key of keys) {
      const promises = batchData[key].map(async (batchItem) => {
        if (key !== 'Charge') {
          const tokenEntity = await generatePcToken(batchItem.email as string);

          if (isEmpty(tokenEntity)) {
            throw new Error('PCO token is null');
          }

          const settingsJson = user.UserSetting.settingsData as any;
          const settingRegistrationJson = user.UserSetting.settingRegistrationData as any;
          let settingRegistration: any;

          if (batchItem.batchData.type === 'batch') {
            settingRegistration = settingsJson?.find(
              (item: SettingsJsonProps) =>
                item.fundName?.toLowerCase() === String(batchItem.batchData.fundName).toLowerCase(),
            );
          } else {
            settingRegistration = settingRegistrationJson?.find(
              (item: { class: { label: string } }) =>
                item.class?.label?.toLowerCase() === String(batchItem.batchData.fundName).toLowerCase(),
            );
          }

          if (batchItem.batchData.description) {
            const isRegistrationNameExist = settingRegistrationJson?.find(
              (item: { registration: string }) =>
                item?.registration?.toLowerCase() === String(batchItem.batchData.description).toLowerCase(),
            );

            const isRegistrationActive = settingRegistrationJson?.find((item: { isActive: boolean }) => item?.isActive);

            if (!isRegistrationNameExist) {
              // throw new Error(`Settings for registration name "${batchItem.batchData.description}" not found.`);
              console.log(`Settings for registration name "${batchItem.batchData.description}" not found.`);
            }

            if (!isRegistrationActive) {
              // throw new Error(`Settings for registration name "${batchItem.batchData.description}" is Deactivated`);
              console.log(`Settings for registration name "${batchItem.batchData.description}" is Deactivated`);
            }
          }

          if (checkEmpty(settingRegistration)) {
            // throw new Error(`Settings for fund name "${batchItem.batchData.fundName}" not found.`);
            console.log(`Settings for fund name "${batchItem.batchData.fundName}" not found.`);
          }

          const accountRef = settingRegistration?.account?.value ?? '';

          if (checkEmpty(settingRegistration)) {
            throw new Error(`Please set registration`);
          }

          const receivedFrom = settingRegistration?.customer?.value ?? '';
          const classRef = settingRegistration?.class?.value ?? '';

          const bankRef = batchItem.bankData.find((a) => a.type === 'registration') || {};
          const donationDate = batchItem.batchData.payoutDate ? new Date(batchItem.batchData.payoutDate) : new Date();

          const TxnDate = format(donationDate, 'yyyy-MM-dd');
          finalData.push({
            TxnDate,
            payoutDate: batchItem.batchData.payoutDate,
            accountRef,
            receivedFrom,
            classRef,
            batch: {
              id: `Stripe payout - ${batchItem.email} - ${batchItem.batchData.payoutDate}`,
              attributes: {
                description: `Stripe payout ${batchItem.batchData.payoutDate}`,
                created_at: batchItem.batchData.payoutDate,
                total_cents: batchItem.batchData.totalAmount,
              },
            },
            paymentCheck: '',
            bankRef,
            attributes: { payment_method: 'Stripe', amount_cents: batchItem.batchData.amount },
            other: { email: batchItem.email, payoutDate: batchItem.batchData.payoutDate, userId: user.id },
          });
        } else {
          const tokenEntity = await generatePcToken(batchItem.email as string);

          if (isEmpty(tokenEntity)) {
            throw new Error('PCO token is null');
          }

          if (isEmpty(user)) {
            throw new Error('Empty User');
          }

          const settingBankChargesJson = user.UserSetting?.settingBankCharges as any;

          const settingRegistrationJson = user.UserSetting?.settingRegistrationData as any;

          if (checkEmpty(settingRegistrationJson)) {
            throw new Error(
              `Please ensure that your settings are configured correctly, as some registrations appear to be incomplete.`,
            );
          }

          const accountRef = settingBankChargesJson?.account?.value ?? '';
          const receivedFrom = '';
          const classRef = settingBankChargesJson?.class?.value ?? '';

          const bankRef = batchItem.bankData.find((a) => a.type === 'registration') || {};
          const donationDate = batchItem.batchData.payoutDate ? new Date(batchItem.batchData.payoutDate) : new Date();

          const TxnDate = format(donationDate, 'yyyy-MM-dd');
          finalData.push({
            TxnDate,
            payoutDate: batchItem.batchData.payoutDate,
            accountRef,
            receivedFrom,
            classRef,
            batch: {
              id: `Stripe payout - ${batchItem.email} - ${batchItem.batchData.payoutDate}`,
              attributes: {
                description: `Stripe payout ${batchItem.batchData.payoutDate}`,
                created_at: batchItem.batchData.payoutDate,
                total_cents: batchItem.batchData.totalAmount,
              },
            },
            paymentCheck: '',
            bankRef,
            attributes: { payment_method: 'Stripe', amount_cents: -batchItem.batchData.totalFee },
            other: { email: batchItem.email, payoutDate: batchItem.batchData.payoutDate, userId: user.id },
          });
        }
      });

      await Promise.all(promises);
    }

    const responsePayload = newRequestPayload(finalData);
    const synchedBatchesData = await UserSync.findAll({
      where: {
        userId: finalData[0].other.userId,
        batchId: `Stripe payout - ${finalData[0]?.other?.email} - ${finalData[0]?.other?.payoutDate}`,
      },
      attributes: ['id', 'batchId', 'createdAt'],
    });
    if (isEmpty(synchedBatchesData)) {
      console.log('testttt', JSON.stringify(responsePayload));
      const bqoCreatedDataId = await automationDeposit(finalData[0]?.other?.email as string, responsePayload);
      await UserSync.create({
        syncedData: finalData,
        userId: finalData[0]?.other?.userId,
        batchId: `Stripe payout - ${finalData[0]?.other?.email} - ${finalData[0]?.other?.payoutDate}`,
        donationId: bqoCreatedDataId['Id'] || '',
      });
    }
  } catch (e) {
    // // Log the error, rethrow it, or handle it as needed
    // console.error(e.message || 'Error', e);
    // // If you want to propagate the error to the caller, you can rethrow it
    // throw e;
  }
};
