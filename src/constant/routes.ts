const pcRoutes = {
  getBatches: '/pc/getBatches',
  getFunds: '/pc/getFunds',
  handleRegistrationEvents: '/pc/handleRegistrationEvents',
};

const qboRoutes = {
  getAllQboData: '/qbo/getAllQboData',
  deleteQboDeposit: '/qbo/deleteQboDeposit',
  addProject: '/qbo/addProject',
  updateProject: '/qbo/updateProject',
  findCustomer: '/qbo/findCustomer',
};

const stripeRoutes = {
  getStripePayouts: '/stripe/getStripePayouts',
  syncStripePayout: '/stripe/syncStripePayout',
  syncStripePayoutRegistration: '/stripe/syncStripePayoutRegistration',
  finalSyncStripe: '/stripe/finalSyncStripe',
  getStripeList: '/stripe/getStripeList',
  createPaymentIntent: '/stripe/create-payment-intent',
};

const userRoutes = {
  createUser: '/user/createUser',
  addTokenInUser: '/user/addTokenInUser',
  createSettings: '/user/createSettings',
  updateRegisterSettings: '/user/updateRegisterSettings',
  enableAutoSyncSetting: '/user/enableAutoSyncSetting',
  getUserRelated: '/user/getUserRelated',
  manualSync: '/user/manualSync',
  isUserHaveTokens: '/user/isUserHaveTokens',
  getTokenList: '/user/getTokenList',
  updateUserToken: '/user/updateUserToken',
  deleteUserToken: '/user/deleteUserToken',
  sendEmailInvitation: '/user/sendEmailInvitation',
  sendPasswordReset: '/user/sendPasswordReset',
  resetPassword: '/user/resetPassword',
  checkValidInvitation: '/user/checkValidInvitation',
  updateInvitationStatus: '/user/updateInvitationStatus',
  bookkeeperList: '/user/bookkeeperList',
  userUpdate: '/user/userUpdate',
  toggleUserActiveStatus: '/user/toggleUserActiveStatus',
  addUpdateBankSettings: '/user/addUpdateBankSettings',
  addUpdateBilling: '/user/addUpdateBilling',
  viewBilling: '/user/viewBilling',
  addUpdateBankCharges: '/user/addUpdateBankCharges',
  crudUserEmailPreferences: '/user/crudUserEmailPreferences',
  setStartDataAutomation: '/user/setStartDataAutomation',
  getDailyJournalEntries: '/user/getDailyJournalEntries',
  getClearingStatement: '/user/getClearingStatement',
  getStripeGivingByDay: '/user/getStripeGivingByDay',
  getStripeGivingDayDetail: '/user/getStripeGivingDayDetail',
  postStripeGivingDay: '/user/postStripeGivingDay',
  markTransitionTruedUp: '/user/markTransitionTruedUp',
  payoutReportPreview: '/user/payoutReport/preview',
  payoutReportImport: '/user/payoutReport/import',
  payoutReportStatus: '/user/payoutReport/status',
  payoutReportReview: '/user/payoutReport/review',
  payoutReportResolve: '/user/payoutReport/resolve',
  payoutReportRecheckGiving: '/user/payoutReport/recheckGiving',
  payoutReportSignups: '/user/payoutReport/signups',
};

// The Churches page and the People tab (controller/church.ts).
const churchRoutes = {
  mine: '/church/mine',
  create: '/church/create',
  update: '/church/update',
  people: '/church/people',
  invite: '/church/people/invite',
  access: '/church/people/access',
  remove: '/church/people/remove',
};

export { pcRoutes, userRoutes, qboRoutes, stripeRoutes, churchRoutes };
