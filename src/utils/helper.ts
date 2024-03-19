import axios from 'axios';
import { generatePcToken } from '../controller/automation';
import _ from 'lodash';

interface PcTokenProps {
  refreshToken: string;
  accessToken: string;
  email: string;
}

const getDayBoundary = (hours, minutes, seconds, ms) => {
  const boundary = new Date();
  boundary.setHours(hours, minutes, seconds, ms);
  return boundary;
};

const pcTokenValidation = async ({ refreshToken, accessToken, email }: PcTokenProps) => {
  // try {
  //   const response = await axios.get('https://api.planningcenteronline.com/giving/v2/people/1/payment_methods', {
  //     headers: {
  //       Authorization: `Bearer ${accessToken}`,
  //       'Content-Type': 'application/json',
  //     },
  //   });
  //   if (response.status === 200) {
  //     return true;
  //   } else {
  //     console.log('Access token is invalid');
  //     return await generatePcToken(refreshToken, email);
  //   }
  // } catch (error) {
  //   if (error.response && error.response.status === 401) {
  //     console.log('Access token is invalid');
  //     return;
  //   } else {
  //     console.log('An error occurred:', error.message);
  //     return;
  //   }
  // }
};

const checkEmpty = (value): boolean => {
  // Check for null or undefined directly
  if (value == null) {
    return true;
  }

  if (_.isArray(value)) {
    // Check if it's an array and if every item is an empty object
    return _.isEmpty(value) || _.every(value, (item) => _.isPlainObject(item) && _.isEmpty(item));
  } else {
    // Use Lodash's isEmpty for other types
    return _.isEmpty(value);
  }
};

export { getDayBoundary, pcTokenValidation, checkEmpty };
