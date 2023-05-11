/* eslint-disable @typescript-eslint/no-explicit-any */
interface MappingPcToQboProps {
  donationAmount: string;
  batchName: string;
  batchCreated: string;
  batchTotalAmount: string;
  AccountRef: string;
  ReceivedFrom: string;
  ClassRef: string;
  tempPaymentMethod?: string;
}

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
      batchTotalAmount: numberWithToFix(item.batch.attributes.total_cents),
      AccountRef: item.accountRef,
      ReceivedFrom: item.receivedFrom,
      ClassRef: item.classRef,
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
              value: item.ReceivedFrom,
            },
            //   PaymentMethodRef: {
            //     value: '{newPaymentMethodID}',
            //   },
            ClassRef: {
              value: item.ClassRef,
            },
          },
          Description: item.batchName,
        },
      ],
      DepositToAccountRef: {
        name: 'Checking',
        value: '35',
      },
    };
  });
  return finalData;
};

export { requestPayload };
