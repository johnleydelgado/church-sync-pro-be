import { Router } from 'express';
import {
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
  addUpdateBilling,
  bookkeeperList,
  checkValidInvitation,
  createSettings,
  createUser,
  crudUserEmailPreferences,
  deleteUserToken,
  enableAutoSyncSetting,
  getTokenList,
  getUserRelated,
  isUserHaveTokens,
  setStartDataAutomation,
  toggleUserActiveStatus,
  updateInvitationStatus,
  updateRegisterSettings,
  updateUser,
  updateUserData,
  updateUserToken,
  viewBilling,
} from '../controller/user';
import { addTokenInUser } from '../controller/db';
import {
  addProject,
  deleteQboDeposit,
  findCustomer,
  getAllQboData,
  updateProject,
} from '../controller/qbo';
import {
  createPaymentIntent,
  finalSyncStripe,
  getStripeList,
  getStripePayouts,
  // DEPRECATED: unused by UI
  // syncStripePayout,
  // syncStripePayoutRegistration,
} from '../controller/stripe';
import {
  automationScheduler,
  checkLatestFund,
  checkLatestRegistration,
  dailyJournalSync,
  latestFundAutomation,
  latestRegistrationAutomation,
} from '../controller/automation';
import { requireAutomationKey } from '../utils/automationAuth';
import { getDailyJournalEntries, getClearingStatement } from '../controller/journalEntry';
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
routers.post('/deleteBookeeper', verifySession(), deleteBookeeper);

routers.get(pcRoutes.getFunds, verifySession(), getFunds);
routers.post(pcRoutes.getBatches, verifySession(), getBatches);
routers.post(pcRoutes.handleRegistrationEvents, verifySession(), handleRegistrationEvents);

routers.get(stripeRoutes.getStripePayouts, verifySession(), getStripePayouts);
// DEPRECATED: unused by UI
// routers.post(stripeRoutes.syncStripePayout, verifySession(), syncStripePayout);
// DEPRECATED: unused by UI
// routers.post(stripeRoutes.syncStripePayoutRegistration, verifySession(), syncStripePayoutRegistration);
routers.post(stripeRoutes.finalSyncStripe, verifySession(), finalSyncStripe);
routers.post(stripeRoutes.getStripeList, verifySession(), getStripeList);
routers.post(stripeRoutes.createPaymentIntent, verifySession(), createPaymentIntent);

routers.post(qboRoutes.getAllQboData, verifySession(), getAllQboData);
routers.post(qboRoutes.deleteQboDeposit, verifySession(), deleteQboDeposit);
routers.post(qboRoutes.addProject, verifySession(), addProject);
routers.post(qboRoutes.updateProject, verifySession(), updateProject);
routers.post(qboRoutes.findCustomer, verifySession(), findCustomer);

routers.post(userRoutes.updateUser, verifySession(), updateUser);
routers.post(userRoutes.createUser, verifySession(), createUser);
routers.post(userRoutes.addTokenInUser, verifySession(), addTokenInUser);
routers.post(userRoutes.createSettings, verifySession(), createSettings);
routers.post(userRoutes.updateRegisterSettings, verifySession(), updateRegisterSettings);
routers.post(userRoutes.enableAutoSyncSetting, verifySession(), enableAutoSyncSetting);
routers.get(userRoutes.getUserRelated, verifySession(), getUserRelated);
routers.get(userRoutes.getDailyJournalEntries, verifySession(), getDailyJournalEntries);
routers.get(userRoutes.getClearingStatement, verifySession(), getClearingStatement);
routers.post(userRoutes.manualSync, verifySession(), manualSync);
routers.post(userRoutes.isUserHaveTokens, verifySession(), isUserHaveTokens);
routers.post(userRoutes.getTokenList, verifySession(), getTokenList);
routers.post(userRoutes.updateUserToken, verifySession(), updateUserToken);
routers.post(userRoutes.deleteUserToken, verifySession(), deleteUserToken);
routers.post(userRoutes.sendEmailInvitation, verifySession(), sendEmailInvitation);
routers.post(userRoutes.sendPasswordReset, sendPasswordReset);
routers.post(userRoutes.resetPassword, resetPassword);
routers.post(userRoutes.checkValidInvitation, checkValidInvitation);
routers.post(userRoutes.updateInvitationStatus, updateInvitationStatus);
routers.post(userRoutes.bookkeeperList, verifySession(), bookkeeperList);
routers.post(userRoutes.userUpdate, verifySession(), updateUserData);
routers.post(userRoutes.toggleUserActiveStatus, verifySession(), toggleUserActiveStatus);
routers.post(userRoutes.addUpdateBankSettings, verifySession(), addUpdateBankSettings);
routers.post(userRoutes.addUpdateBilling, verifySession(), addUpdateBilling);
routers.post(userRoutes.viewBilling, verifySession(), viewBilling);
routers.post(userRoutes.addUpdateBankCharges, verifySession(), addUpdateBankCharges);
routers.post(userRoutes.crudUserEmailPreferences, verifySession(), crudUserEmailPreferences);
routers.post(userRoutes.setStartDataAutomation, verifySession(), setStartDataAutomation);

routers.post('/automationScheduler', requireAutomationKey, automationScheduler);
// The nightly journal entry. Sweeps each church's recent days from the donations endpoint;
// `latestFundAutomation` below is the old batch-based path, kept for now but no longer scheduled.
routers.post('/dailyJournalSync', requireAutomationKey, dailyJournalSync);
routers.post('/latestFundAutomation', requireAutomationKey, latestFundAutomation);


routers.post('/checkLatestFund', requireAutomationKey, checkLatestFund);
routers.post('/checkLatestRegistration', requireAutomationKey, checkLatestRegistration);
routers.post('/latestRegistrationAutomation', requireAutomationKey, latestRegistrationAutomation);

export default routers;
