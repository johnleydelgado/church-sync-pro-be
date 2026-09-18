/**
 * The verification email is the only thing standing between "anyone can sign up as any
 * address" and a real account, so what goes on the wire is pinned here: the recipient,
 * the sender the domain is authenticated for, the link itself, and click tracking OFF
 * (SendGrid's tracking domain for churchsyncpro.com no longer resolves - see CLAUDE.md).
 */
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn().mockResolvedValue([{}]) }));

import sgMail from '@sendgrid/mail';
import { buildVerificationMessage, sendVerificationEmail } from '../verificationEmail';

const mockedSend = (sgMail as any).send as jest.Mock;
const mockedSetKey = (sgMail as any).setApiKey as jest.Mock;

const link = 'http://localhost:3000/auth/verify-email?token=abc&rid=emailverification';

describe('buildVerificationMessage', () => {
  it('addresses the message and carries the link in both html and text bodies', () => {
    const msg = buildVerificationMessage({ to: 'pastor@church.org', link });
    expect(msg.to).toBe('pastor@church.org');
    expect(msg.from).toBe('support@churchsyncpro.com');
    expect(msg.subject).toMatch(/confirm your email/i);
    expect(msg.html).toContain(link);
    expect(msg.text).toContain(link);
  });

  it('disables click tracking so the link is not rewritten to the dead tracking domain', () => {
    const msg = buildVerificationMessage({ to: 'a@b.c', link });
    expect(msg.trackingSettings).toEqual({ clickTracking: { enable: false, enableText: false } });
  });
});

describe('sendVerificationEmail', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sets the API key and sends exactly one message', async () => {
    await sendVerificationEmail({ to: 'a@b.c', link });
    expect(mockedSetKey).toHaveBeenCalledTimes(1);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend.mock.calls[0][0].to).toBe('a@b.c');
  });

  it('propagates a SendGrid failure instead of swallowing it', async () => {
    mockedSend.mockRejectedValueOnce(new Error('sendgrid down'));
    await expect(sendVerificationEmail({ to: 'a@b.c', link })).rejects.toThrow('sendgrid down');
  });
});
