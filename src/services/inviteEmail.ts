/* eslint-disable @typescript-eslint/no-var-requires */
const sgMail = require('@sendgrid/mail');

/**
 * Send transactional links exactly as written.
 *
 * SendGrid's account-wide click tracking rewrites every URL in an email to
 * `https://url3979.churchsyncpro.com/ls/click?upn=<300 opaque characters>` so it can count
 * clicks. For a newsletter that is harmless; for an invitation or a password reset it is not.
 * The recipient is being asked to trust a link that no longer shows where it goes, which is the
 * exact shape of a phishing email - and spam filters score it that way too. The invite also
 * carries a one-time token, so a rewritten URL is an extra hop that can break it.
 *
 * Disabled per message rather than on the account, so anything else the account sends keeps its
 * tracking.
 */
export const NO_CLICK_TRACKING = { trackingSettings: { clickTracking: { enable: false, enableText: false } } };

/**
 * The link an invitee follows to accept (InviteLink.tsx). The email is encoded: a '+' in the
 * address would otherwise be read back as a space by the page.
 */
export const inviteLinkFor = (email: string, token: string): string =>
  `${process.env.INVITATION_URL}?bookkeeperEmail=${encodeURIComponent(email)}&invitationToken=${token}`;

/** Throws when SendGrid refuses; callers decide whether the invite stands without the email. */
export const sendInviteEmail = async (to: string, inviteLink: string): Promise<void> => {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  await sgMail.send({
    to,
    from: 'support@churchsyncpro.com',
    subject: 'You have been invited to take on the role of a bookkeeper.',
    templateId: 'd-4529481214ab4c4e85018b4dfb3b6f20',
    dynamicTemplateData: {
      inviteLink,
    },
    ...NO_CLICK_TRACKING,
  });
};
