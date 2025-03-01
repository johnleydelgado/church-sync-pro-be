import { Router } from 'express';
import {
  createPayment,
  deleteBookeeper,
  healthCheck,
  manualSync,
  resetPassword,
  sendEmailInvitation,
  sendPasswordReset,
  tesst,
} from '../controller';
import {
  authPlanningCenter,
  authQuickBook,
  authStripe,
  callBackPC,
  callBackQBO,
  callBackStripe,
} from '../controller/auth';
// import { authorized } from '../utils/authorization';
import { verifySession } from 'supertokens-node/recipe/session/framework/express';
import { pcRoutes, qboRoutes, stripeRoutes, userRoutes } from '../constant/routes';
import { getBatches, getFunds, handleRegistrationEvents } from '../controller/planning-center';
import {
  addUpdateBankCharges,
  addUpdateBankSettings,
  bookkeeperList,
  checkValidInvitation,
  createSettings,
  createUser,
  deleteUserToken,
  enableAutoSyncSetting,
  getTokenList,
  getUserRelated,
  isUserHaveTokens,
  updateInvitationStatus,
  updateUser,
  updateUserData,
  updateUserToken,
} from '../controller/user';
import { addTokenInUser } from '../controller/db';
import { deleteQboDeposit, getAllQboData, getDepositRef } from '../controller/qbo';
import {
  finalSyncStripe,
  getStripePayouts,
  syncStripePayout,
  syncStripePayoutRegistration,
} from '../controller/stripe';
import { automationScheduler, checkLatestFund, latestFundAutomation } from '../controller/automation';
const routers = Router();
// routers.post("/start", authorized, startTask);
routers.get('/', tesst);
routers.get('/authQB', verifySession(), authQuickBook);
routers.get('/authPC', verifySession(), authPlanningCenter);
routers.get('/authStripe', authStripe);
routers.post('/callBackQBO', verifySession(), callBackQBO);
routers.post('/callBackPC', verifySession(), callBackPC);
routers.post('/callBackStripe', callBackStripe);
routers.get('/healthCheck', verifySession(), healthCheck);

// routers.get('/getBatches', verifySession(), getBatches);
routers.post('/createPayment', verifySession(), createPayment);
routers.post('/deleteBookeeper', verifySession(), deleteBookeeper);

routers.get(pcRoutes.getFunds, getFunds);
routers.post(pcRoutes.getBatches, getBatches);
routers.post(pcRoutes.handleRegistrationEvents, verifySession(), handleRegistrationEvents);

routers.get(stripeRoutes.getStripePayouts, verifySession(), getStripePayouts);
routers.post(stripeRoutes.syncStripePayout, verifySession(), syncStripePayout);
routers.post(stripeRoutes.syncStripePayoutRegistration, verifySession(), syncStripePayoutRegistration);
routers.post(stripeRoutes.finalSyncStripe, verifySession(), finalSyncStripe);

routers.post(qboRoutes.getAllQboData, verifySession(), getAllQboData);
routers.post(qboRoutes.deleteQboDeposit, verifySession(), deleteQboDeposit);

routers.post(userRoutes.updateUser, verifySession(), updateUser);
routers.post(userRoutes.createUser, verifySession(), createUser);
routers.post(userRoutes.addTokenInUser, verifySession(), addTokenInUser);
routers.post(userRoutes.createSettings, verifySession(), createSettings);
routers.post(userRoutes.enableAutoSyncSetting, verifySession(), enableAutoSyncSetting);
routers.get(userRoutes.getUserRelated, getUserRelated);
routers.post(userRoutes.manualSync, verifySession(), manualSync);
routers.post(userRoutes.isUserHaveTokens, verifySession(), isUserHaveTokens);
routers.post(userRoutes.getTokenList, verifySession(), getTokenList);
routers.post(userRoutes.updateUserToken, verifySession(), updateUserToken);
routers.post(userRoutes.deleteUserToken, verifySession(), deleteUserToken);
routers.post(userRoutes.sendEmailInvitation, sendEmailInvitation);
routers.post(userRoutes.sendPasswordReset, sendPasswordReset);
routers.post(userRoutes.resetPassword, resetPassword);
routers.post(userRoutes.checkValidInvitation, checkValidInvitation);
routers.post(userRoutes.updateInvitationStatus, updateInvitationStatus);
routers.post(userRoutes.bookkeeperList, verifySession(), bookkeeperList);
routers.post(userRoutes.userUpdate, verifySession(), updateUserData);
routers.post(userRoutes.addUpdateBankSettings, verifySession(), addUpdateBankSettings);
routers.post(userRoutes.addUpdateBankCharges, verifySession(), addUpdateBankCharges);

routers.post('/automationScheduler', automationScheduler);
routers.post('/latestFundAutomation', latestFundAutomation);

routers.post('/getDepositRef', getDepositRef);

routers.post('/checkLatestFund', checkLatestFund);

export default routers;
