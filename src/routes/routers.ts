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
  createClientChurch,
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
import {
  payoutReportImport,
  payoutReportPreview,
  payoutReportRecheckGiving,
  payoutReportResolve,
  payoutReportReview,
  payoutReportSignups,
  payoutReportStatus,
} from '../controller/payoutReport';
import {
  getDailyJournalEntries,
  getClearingStatement,
  getStripeGivingByDay,
  getStripeGivingDayDetail,
  postStripeGivingDay,
  markTransitionTruedUp,
} from '../controller/journalEntry';
import {
  fromBillingData,
  fromBody,
  fromBodyItems,
  fromBodyUserId,
  fromQuery,
  fromTokenId,
  requireAccountAccess,
} from '../services/churchAccess';

// Every route that names a church checks the signed-in person may work on it (services/churchAccess.ts),
// between verifySession() and the handler. A route with no guard is unguarded on purpose: no church
// (sign-up, OAuth), public, legacy bookkeeper routes, or the scheduler's requireAutomationKey routes.
const q = requireAccountAccess(fromQuery);
const b = requireAccountAccess(fromBody);
const bUser = requireAccountAccess(fromBodyUserId);
// Connecting or removing QuickBooks / Planning Center: an owner, or a member the owner allowed to.
const bIntegrations = requireAccountAccess(fromBody, 'integrations');
const tokenIntegrations = requireAccountAccess(fromTokenId, 'integrations');
const bUserOwner = requireAccountAccess(fromBodyUserId, 'owner');

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

routers.get(pcRoutes.getFunds, verifySession(), q, getFunds);
routers.post(pcRoutes.getBatches, verifySession(), b, getBatches);
routers.post(pcRoutes.handleRegistrationEvents, verifySession(), bUser, handleRegistrationEvents);

routers.get(stripeRoutes.getStripePayouts, verifySession(), q, getStripePayouts);
// DEPRECATED: unused by UI
// routers.post(stripeRoutes.syncStripePayout, verifySession(), syncStripePayout);
// DEPRECATED: unused by UI
// routers.post(stripeRoutes.syncStripePayoutRegistration, verifySession(), syncStripePayoutRegistration);
routers.post(stripeRoutes.finalSyncStripe, verifySession(), requireAccountAccess(fromBodyItems), finalSyncStripe);
routers.post(stripeRoutes.getStripeList, verifySession(), b, getStripeList);
routers.post(stripeRoutes.createPaymentIntent, verifySession(), createPaymentIntent);

routers.post(qboRoutes.getAllQboData, verifySession(), b, getAllQboData);
routers.post(qboRoutes.deleteQboDeposit, verifySession(), b, deleteQboDeposit);
routers.post(qboRoutes.addProject, verifySession(), b, addProject);
routers.post(qboRoutes.updateProject, verifySession(), b, updateProject);
routers.post(qboRoutes.findCustomer, verifySession(), b, findCustomer);

routers.post(userRoutes.updateUser, verifySession(), updateUser);
routers.post(userRoutes.createUser, verifySession(), createUser);
routers.post(userRoutes.createClientChurch, verifySession(), createClientChurch);
routers.post(userRoutes.addTokenInUser, verifySession(), b, addTokenInUser);
routers.post(userRoutes.createSettings, verifySession(), b, createSettings);
routers.post(userRoutes.updateRegisterSettings, verifySession(), b, updateRegisterSettings);
routers.post(userRoutes.enableAutoSyncSetting, verifySession(), b, enableAutoSyncSetting);
routers.get(userRoutes.getUserRelated, verifySession(), q, getUserRelated);
routers.get(userRoutes.getDailyJournalEntries, verifySession(), q, getDailyJournalEntries);
routers.get(userRoutes.getClearingStatement, verifySession(), q, getClearingStatement);
routers.get(userRoutes.getStripeGivingByDay, verifySession(), q, getStripeGivingByDay);
routers.get(userRoutes.getStripeGivingDayDetail, verifySession(), q, getStripeGivingDayDetail);
routers.post(userRoutes.postStripeGivingDay, verifySession(), b, postStripeGivingDay);
routers.post(userRoutes.markTransitionTruedUp, verifySession(), b, markTransitionTruedUp);
// Registrations from Planning Center's payout report (upload on the Clearing page).
routers.post(userRoutes.payoutReportPreview, verifySession(), b, payoutReportPreview);
routers.post(userRoutes.payoutReportImport, verifySession(), b, payoutReportImport);
routers.get(userRoutes.payoutReportStatus, verifySession(), q, payoutReportStatus);
routers.get(userRoutes.payoutReportReview, verifySession(), q, payoutReportReview);
routers.post(userRoutes.payoutReportResolve, verifySession(), b, payoutReportResolve);
routers.post(userRoutes.payoutReportRecheckGiving, verifySession(), b, payoutReportRecheckGiving);
routers.get(userRoutes.payoutReportSignups, verifySession(), q, payoutReportSignups);
routers.post(userRoutes.manualSync, verifySession(), b, manualSync);
routers.post(userRoutes.isUserHaveTokens, verifySession(), b, isUserHaveTokens);
routers.post(userRoutes.getTokenList, verifySession(), b, getTokenList);
routers.post(userRoutes.updateUserToken, verifySession(), bIntegrations, updateUserToken);
routers.post(userRoutes.deleteUserToken, verifySession(), tokenIntegrations, deleteUserToken);
routers.post(userRoutes.sendEmailInvitation, verifySession(), sendEmailInvitation);
routers.post(userRoutes.sendPasswordReset, sendPasswordReset);
routers.post(userRoutes.resetPassword, resetPassword);
routers.post(userRoutes.checkValidInvitation, checkValidInvitation);
routers.post(userRoutes.updateInvitationStatus, updateInvitationStatus);
routers.post(userRoutes.bookkeeperList, verifySession(), bookkeeperList);
routers.post(userRoutes.userUpdate, verifySession(), bUser, updateUserData);
routers.post(userRoutes.toggleUserActiveStatus, verifySession(), bUserOwner, toggleUserActiveStatus);
routers.post(userRoutes.addUpdateBankSettings, verifySession(), b, addUpdateBankSettings);
routers.post(userRoutes.addUpdateBilling, verifySession(), requireAccountAccess(fromBillingData), addUpdateBilling);
routers.post(userRoutes.viewBilling, verifySession(), bUser, viewBilling);
routers.post(userRoutes.addUpdateBankCharges, verifySession(), b, addUpdateBankCharges);
routers.post(userRoutes.crudUserEmailPreferences, verifySession(), bUser, crudUserEmailPreferences);
routers.post(userRoutes.setStartDataAutomation, verifySession(), b, setStartDataAutomation);

routers.post('/automationScheduler', requireAutomationKey, automationScheduler);
// The nightly journal entry. Sweeps each church's recent days from the donations endpoint;
// `latestFundAutomation` below is the old batch-based path, kept for now but no longer scheduled.
routers.post('/dailyJournalSync', requireAutomationKey, dailyJournalSync);
routers.post('/latestFundAutomation', requireAutomationKey, latestFundAutomation);


routers.post('/checkLatestFund', requireAutomationKey, checkLatestFund);
routers.post('/checkLatestRegistration', requireAutomationKey, checkLatestRegistration);
routers.post('/latestRegistrationAutomation', requireAutomationKey, latestRegistrationAutomation);

export default routers;
