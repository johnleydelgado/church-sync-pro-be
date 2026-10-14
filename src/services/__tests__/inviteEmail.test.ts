/**
 * The invite link and email. The link is what an invitee follows, and what an owner copies when
 * the email never arrives, so it must never go out half-built.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn().mockResolvedValue([{}]) }));
jest.mock('../../utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, createLogger: () => log, default: () => log };
});

import sgMail from '@sendgrid/mail';
import { createLogger } from '../../utils/logger';
import { inviteLinkFor, sendInviteEmail } from '../inviteEmail';

const send = sgMail.send as jest.Mock;
const log = createLogger('test') as any;
const saved = process.env.INVITATION_URL;

beforeEach(() => {
  process.env.INVITATION_URL = 'https://app.example.test/auth/invite';
  send.mockClear();
  log.error.mockClear();
});

afterAll(() => {
  if (saved === undefined) delete process.env.INVITATION_URL;
  else process.env.INVITATION_URL = saved;
});

describe('inviteLinkFor', () => {
  it('encodes the address, so a + is not read back as a space', () => {
    expect(inviteLinkFor('a+b@example.test', 'abc123')).toBe(
      'https://app.example.test/auth/invite?bookkeeperEmail=a%2Bb%40example.test&invitationToken=abc123',
    );
  });

  it('refuses to build a link with no INVITATION_URL, and logs that without the address', () => {
    delete process.env.INVITATION_URL;

    expect(() => inviteLinkFor('someone@example.test', 'abc123')).toThrow(/INVITATION_URL/);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('someone@example.test');
  });
});

describe('sendInviteEmail', () => {
  it('sends the bookkeeper invitation template with click tracking off', async () => {
    await sendInviteEmail('a@example.test', 'https://link');

    expect(send).toHaveBeenCalledWith({
      to: 'a@example.test',
      from: 'support@churchsyncpro.com',
      subject: 'You have been invited to take on the role of a bookkeeper.',
      templateId: 'd-4529481214ab4c4e85018b4dfb3b6f20',
      dynamicTemplateData: { inviteLink: 'https://link' },
      trackingSettings: { clickTracking: { enable: false, enableText: false } },
    });
  });

  it('passes a SendGrid refusal on to the caller', async () => {
    send.mockRejectedValueOnce(new Error('Forbidden'));
    await expect(sendInviteEmail('a@example.test', 'https://link')).rejects.toThrow('Forbidden');
  });
});
