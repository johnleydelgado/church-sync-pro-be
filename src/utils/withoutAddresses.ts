/**
 * Error text can echo an email address (SendGrid names the recipient; a database error can quote
 * the value it was given). Logs never carry addresses, so run any error text through this first.
 *
 * Kept free of imports so a test that fakes the services still runs the real one.
 */
export const withoutAddresses = (text: string) => text.replace(/[^\s@<>"',;:]+@[^\s@<>"',;:]+/g, '<address>');
