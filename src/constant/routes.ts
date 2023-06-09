const pcRoutes = {
  getBatches: '/pc/getBatches',
  getFunds: '/pc/getFunds',
  getRegistrationEvents: '/pc/getRegistrationEvents',
};

const qboRoutes = {
  getAllQboData: '/qbo/getAllQboData',
};

const stripeRoutes = {
  getStripePayouts: '/stripe/getStripePayouts',
  syncStripePayout: '/stripe/syncStripePayout',
};

const userRoutes = {
  updateUser: '/user/updateUser',
  createUser: '/user/createUser',
  addTokenInUser: '/user/addTokenInUser',
  createSettings: '/user/createSettings',
  getUserRelated: '/user/getUserRelated',
  manualSync: '/user/manualSync',
  isUserHaveTokens: '/user/isUserHaveTokens',
  getTokenList: '/user/getTokenList',
  updateUserToken: '/user/updateUserToken',
  deleteUserToken: '/user/deleteUserToken',
  sendEmailInvitation: '/user/sendEmailInvitation',
  checkValidInvitation: '/user/checkValidInvitation',
  updateInvitationStatus: '/user/updateInvitationStatus',
  bookkeeperList: '/user/bookkeeperList',
};

export { pcRoutes, userRoutes, qboRoutes, stripeRoutes };
