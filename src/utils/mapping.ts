/* eslint-disable @typescript-eslint/no-explicit-any */
interface MappingPcToQboProps {
  donationAmount: string;
  batchName: string;
  batchCreated: string;
  batchTotalAmount: string;
  AccountRef: string;
  ReceivedFrom: string;
  ClassRef: string;
  CheckNum: string;
  tempPaymentMethod?: string;
  bankRef: {
    value: string;
    label: string;
  };
  TxnDate: string;
}

export interface CustomerProps {
  firstName: string;
  middleName: string;
  lastName: string;
  projectName: string;
  projectDisplayName: string;
  email: string;
  phoneno: string;
  mobileno: string;
  fax: string;
  other: string;
  nameToPrintOnChecks: string;
  parentRef: string;
  billWithParent?: boolean;
  webAdd?: string;
  active?: boolean;
  Id?: number;
  syncToken?: string;
}

interface MappingCustomerProps {
  GivenName: string;
  MiddleName: string;
  FamilyName: string;
  FullyQualifiedName: string;
  DisplayName: string;
  PrimaryEmailAddr: {
    Address: string;
  };
  PrimaryPhone: {
    FreeFormNumber: string;
  };
  AlternatePhone: {
    FreeFormNumber: string;
  };
  Mobile: {
    FreeFormNumber: string;
  };
  PrintOnCheckName: string;
  ParentRef?: {
    value: string;
  };
  BillWithParent?: boolean;
  Job?: boolean;
  CompanyName: string;
  WebAddr?: {
    URI: string;
  };
  Notes?: string;
  Active?: boolean;
  Id?: number;
  SyncToken?: string;
}

interface MappingCustomerProps {}

export interface SettingsJsonProps {
  fundName: string;
  account: { value: string; label: string };
  class: { value: string; label: string };
  customer: { value: string; label: string };
}

const numberWithToFix = (number: number) => {
  if (number) {
    const num = (number / 100).toFixed(2);
    return num as string;
  }
  return '';
};

const mapping = (data: any[]): MappingPcToQboProps[] => {
  const tempData: MappingPcToQboProps[] = [];
  data.map((item: any) => {
    tempData.push({
      tempPaymentMethod:
        item.attributes.payment_method === 'card' ? item.attributes.payment_brand : item.attributes.payment_method,
      donationAmount: numberWithToFix(item.attributes.amount_cents),
      batchName: item.batch.attributes.description || '',
      batchCreated: item.batch.attributes.created_at || '',
      batchTotalAmount: numberWithToFix(item.batch?.attributes?.total_cents || 0),
      AccountRef: item.accountRef,
      ReceivedFrom: item.receivedFrom,
      ClassRef: item.classRef,
      CheckNum: item.attributes.payment_method === 'card' ? '' : item.paymentCheck,
      bankRef: { value: item.bankRef.value || '', label: item.bankRef.label || '' },
      TxnDate: item.TxnDate,
    });
  });

  return tempData;
};

const requestPayload = (data: any[]) => {
  const mappingPayload = mapping(data);
  const finalData = mappingPayload.map((item) => {
    return {
      // TxnDate: item.batchCreated,
      // TotalAmt: item.batchTotalAmount,
      tempPaymentMethod: item.tempPaymentMethod,
      Line: [
        {
          Amount: item.donationAmount,
          DetailType: 'DepositLineDetail',
          DepositLineDetail: {
            AccountRef: {
              value: item.AccountRef,
            },
            Entity: {
              value: item.ReceivedFrom ?? '',
            },
            //   PaymentMethodRef: {
            //     value: '{newPaymentMethodID}',
            //   },
            ClassRef: {
              value: item.ClassRef,
            },
            CheckNum: item.CheckNum,
          },
          Description: item.batchName,
        },
      ],
      DepositToAccountRef: {
        name: item.bankRef.label,
        value: item.bankRef.value,
      },
    };
  });
  return finalData;
};

const newRequestPayload = (data: any[]) => {
  const mappingPayload = mapping(data);
  const lines = mappingPayload.map((item) => ({
    tempPaymentMethod: item.tempPaymentMethod,
    Amount: item.donationAmount,
    DetailType: 'DepositLineDetail',
    DepositLineDetail: {
      ...(item.AccountRef && {
        AccountRef: {
          value: item.AccountRef,
        },
      }),
      Entity: {
        value: item.ReceivedFrom ?? '',
      },
      // PaymentMethodRef: {
      //   value: '{newPaymentMethodID}',
      // },
      ClassRef: {
        value: item.ClassRef,
      },
      CheckNum: item.CheckNum,
    },
    Description: item.batchName,
  }));

  const finalData = {
    Line: lines,
    TxnDate: mappingPayload[0]?.TxnDate,
    DepositToAccountRef: {
      name: mappingPayload[0]?.bankRef.label,
      value: mappingPayload[0]?.bankRef.value,
    },
  };
  return finalData;
};

const projectPayload = (data: CustomerProps): MappingCustomerProps => {
  return {
    AlternatePhone: { FreeFormNumber: data.phoneno || '' },
    DisplayName: data.projectName || '',
    FamilyName: data.lastName || '',
    FullyQualifiedName: data.projectDisplayName || '',
    GivenName: data.firstName || '',
    MiddleName: data.middleName || '',
    Mobile: { FreeFormNumber: data.mobileno || '' },
    PrimaryEmailAddr: { Address: data.email || '' },
    PrimaryPhone: { FreeFormNumber: data.phoneno || '' },
    PrintOnCheckName: data.nameToPrintOnChecks || '',
    BillWithParent: data.billWithParent || false,
    ParentRef: { value: data.parentRef || '' },
    Job: data.parentRef ? true : false,
    CompanyName: data.projectName || '',
    WebAddr: { URI: data.webAdd ? 'https://' + data.webAdd : '' },
    Notes: data.other || '',
    ...('active' in data && { Active: data.active ? true : false }),
    ...((data.Id || data.Id === 0) && { Id: data.Id }),
    SyncToken: data.syncToken,
  };
};

export { requestPayload, newRequestPayload, projectPayload };
