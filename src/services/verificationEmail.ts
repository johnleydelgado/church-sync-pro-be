/* eslint-disable @typescript-eslint/no-var-requires */
const sgMail = require('@sendgrid/mail');

const { SENDGRID_API_KEY, NODE_ENV } = process.env;

// The domain's SendGrid click-tracking CNAME is gone (see CLAUDE.md), so every link must
// go out untouched. Same setting the invitation and password-reset mails use.
const NO_CLICK_TRACKING = { trackingSettings: { clickTracking: { enable: false, enableText: false } } };

export const buildVerificationMessage = ({ to, link }: { to: string; link: string }) => ({
  to,
  from: 'support@churchsyncpro.com',
  subject: 'Confirm your email for Church Sync Pro',
  text: `Thanks for signing up for Church Sync Pro.\n\nConfirm your email address by opening this link:\n${link}\n\nIf you did not create an account, you can ignore this email.`,
  html: `
    <p>Thanks for signing up for Church Sync Pro.</p>
    <p>Confirm your email address by clicking the button below.</p>
    <p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#1f2937;color:#fff;text-decoration:none;border-radius:6px">Confirm my email</a></p>
    <p>Or copy this link into your browser:<br/><a href="${link}">${link}</a></p>
    <p>If you did not create an account, you can ignore this email.</p>
  `,
  ...NO_CLICK_TRACKING,
});

export const sendVerificationEmail = async ({ to, link }: { to: string; link: string }) => {
  sgMail.setApiKey(SENDGRID_API_KEY);
  if (NODE_ENV === 'development') {
    // Local mail is unsigned (DKIM CNAMEs missing) and often lands in spam; the link in the
    // server log is the reliable way to finish a local sign-up.
    console.log(`[email-verification] ${to} -> ${link}`);
  }
  await sgMail.send(buildVerificationMessage({ to, link }));
};
