import axios from 'axios';
import { generatePcToken } from '../controller/automation';

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

export { getDayBoundary, pcTokenValidation };
