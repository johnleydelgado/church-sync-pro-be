const pcRoutes = {
  getBatches: '/pc/getBatches',
  getFunds: '/pc/getFunds',
  handleRegistrationEvents: '/pc/handleRegistrationEvents',
};

const qboRoutes = {
  getAllQboData: '/qbo/getAllQboData',
  deleteQboDeposit: '/qbo/deleteQboDeposit',
};

const stripeRoutes = {
  getStripePayouts: '/stripe/getStripePayouts',
  syncStripePayout: '/stripe/syncStripePayout',
  syncStripePayoutRegistration: '/stripe/syncStripePayoutRegistration',
  finalSyncStripe: '/stripe/finalSyncStripe',
};

const userRoutes = {
  updateUser: '/user/updateUser',
  createUser: '/user/createUser',
  addTokenInUser: '/user/addTokenInUser',
  createSettings: '/user/createSettings',
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
  addUpdateBankSettings: '/user/addUpdateBankSettings',
  addUpdateBankCharges: '/user/addUpdateBankCharges',
};

export { pcRoutes, userRoutes, qboRoutes, stripeRoutes };
