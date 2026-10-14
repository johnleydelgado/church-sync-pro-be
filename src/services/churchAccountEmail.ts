/**
 * A church added from the Churches page files its data under a Users row whose address is in this
 * domain. `.invalid` is reserved (RFC 2606), so no mail is ever delivered there. Nobody may sign up
 * with such an address (supertokensConfig.ts) or act as such a row (churchAccess.ts).
 *
 * Kept free of imports so the SuperTokens config can use it without loading the models.
 */
export const ACCOUNT_EMAIL_DOMAIN = 'accounts.churchsyncpro.invalid';

export const isChurchAccountEmail = (email: unknown): boolean =>
  typeof email === 'string' && email.trim().toLowerCase().endsWith(`@${ACCOUNT_EMAIL_DOMAIN}`);
