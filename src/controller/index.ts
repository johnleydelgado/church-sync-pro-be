/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */
import axios from 'axios';
import { Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import user from '../db/models/user';
import quickBookApi from '../utils/quickBookApi';
import { responseError, responseSuccess } from '../utils/response';
import { isEmpty } from 'lodash';
import UserSync from '../db/models/UserSync';
import UserSettings from '../db/models/userSettings';
import User from '../db/models/user';
import crypto from 'crypto';
import bookkeeper from '../db/models/bookkeeper';
import { SessionRequest } from 'supertokens-node/lib/build/framework/express';
import ThirdParty from 'supertokens-node/recipe/thirdparty';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import { syncBatchToJournalEntries } from '../services/syncEngine';
import { recordPendingChurchInvite } from '../services/pendingInvite';
import { removeLegacyBookkeeper } from '../services/legacyBookkeeper';
import { ensureOwnChurch } from '../services/churches';
import { NO_CLICK_TRACKING, inviteLinkFor, sendInviteEmail } from '../services/inviteEmail';
import sequelize from '../db';
import { Op } from 'sequelize';
import { createLogger } from '../utils/logger';

const logger = createLogger('invite');

const sgMail = require('@sendgrid/mail');
const { SENDGRID_API_KEY, RESET_PASSWORD_URL } = process.env;

export const sendEmailInvitation = async (req: Request, res: Response) => {
  // Always a pending invite with a mail. `createdByBk` / `bookkeeperId` in the body are ignored: they
  // wrote an already-accepted row for whatever user id was sent, and no screen sends them any more
  // (createClientChurch writes its own row).
  const { emailTo } = req.body;
  if (typeof emailTo !== 'string' || !emailTo.trim()) {
    return responseError({ res, code: 400, message: 'emailTo is required' });
  }
  const email = emailTo.trim();
  // Behind requireAccountAccess(fromBodyClientId, 'owner'): the church inviting is the account it checked.
  const account = res.locals?.churchAccess?.account;
  if (!account) {
    // Only reachable if the route is wired without its guard; refuse rather than guess a church.
    logger.error('sendEmailInvitation reached without a church access check', { path: req.path });
    return responseError({ res, code: 403, message: "You don't have access to this church." });
  }
  const rand = crypto.randomBytes(16).toString('hex');

  try {
    // Built before anything is written: with no INVITATION_URL this refuses rather than mail a broken link.
    const inviteLink = inviteLinkFor(email, rand);

    // A client who signed up after the churches migration has no church until /church/mine runs,
    // and an invite to no church can never be accepted. Does nothing for a church that has one.
    await ensureOwnChurch(account);

    const outcome = await sequelize.transaction(async (transaction) => {
      // Accepting reads ChurchMembers only, so the pending row there carries the same token.
      const recorded = await recordPendingChurchInvite({ clientId: account.id, email, token: rand, transaction });
      // Neither wrote anything: the person is on the church already, or there is no church (an
      // account that isn't a client's, which ensureOwnChurch leaves alone).
      if (recorded === 'already-member' || recorded === 'no-church') return recorded;
      // An invite sent again: the legacy row(s) still pending for this address take the new token,
      // rather than the Bookkeepers tab listing the person once per mail.
      const [refreshed] = await bookkeeper.update(
        { invitationToken: rand, inviteSent: true },
        {
          where: {
            [Op.and]: [
              { clientId: account.id, userId: null, inviteAccepted: { [Op.not]: true } },
              sequelize.where(sequelize.fn('lower', sequelize.col('email')), email.toLowerCase()),
            ],
          } as any,
          transaction,
        },
      );
      if (!refreshed) {
        await bookkeeper.create(
          {
            email,
            inviteSent: true,
            invitationToken: rand,
            inviteAccepted: false,
            clientId: account.id,
            bookkeeperIntegrationAccessEnabled: false,
          } as any,
          { transaction },
        );
      }
      return recorded;
    });
    if (outcome === 'already-member') {
      return responseError({ res, code: 409, message: `${email} is already on this church.` });
    }
    if (outcome === 'no-church') {
      return responseError({ res, code: 400, message: 'This account has no church to invite people to.' });
    }

    await sendInviteEmail(email, inviteLink);

    return responseSuccess(res, 'Email sent');
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

export const sendPasswordReset = async (req: Request, res: Response) => {
  const { email } = req.body;

  // One address, as a string. An array became `IN (...)`: the victim's row got the token and
  // SendGrid mailed the same link to every address in the array - the attacker's included.
  if (typeof email !== 'string' || email.trim() === '') {
    return responseError({ res, code: 400, data: 'Enter your email address' });
  }

  const rand = crypto.randomBytes(16).toString('hex');

  sgMail.setApiKey(SENDGRID_API_KEY);
  // const htmlFile = await fs.promises.readFile('src/template/msg.html', 'utf-8');

  try {
    const userDetails = await User.findOne({ where: { email } });
    if (userDetails === null) {
      return responseError({ res, code: 200, data: 'User not found !' });
    }

    await User.update({ token: rand }, { where: { id: userDetails.id } });

    // The stored address, not the request's, in both the link and the recipient.
    const gotoUrl = RESET_PASSWORD_URL + `?email=${encodeURIComponent(userDetails.email)}&token=${rand}`;
    const msg = {
      to: userDetails.email,
      from: 'support@churchsyncpro.com', // Change to your verified sender
      subject: 'We have acknowledged your request to change your password.',
      // text: 'and easy to do anywhere, even with Node.js',
      templateId: 'd-62ebb25d19fd42b8aebdf940d93a2fc7',
      dynamicTemplateData: {
        name: userDetails.firstName,
        gotoUrl,
      },
      ...NO_CLICK_TRACKING,
    };
    await sgMail.send(msg);
    return responseSuccess(res, 'email sent password reset');
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

/** What sendPasswordReset issues: crypto.randomBytes(16).toString('hex'). */
const RESET_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export const resetPassword = async (req: Request, res: Response) => {
  const { email, token, password } = req.body;

  // This route is public, so the token is the only credential. Check its shape before it goes
  // anywhere near a query: Sequelize turns `token: null` into `"token" IS NULL` - which matches
  // every user who never asked for a reset - and an array into `IN (...)`. Either let anyone set
  // any email/password user's password.
  if (
    typeof email !== 'string' ||
    email.trim() === '' ||
    typeof token !== 'string' ||
    !RESET_TOKEN_PATTERN.test(token) ||
    typeof password !== 'string' ||
    password === ''
  ) {
    return responseError({ res, code: 400, data: 'Invalid or expired reset link' });
  }

  try {
    const userDetails = await User.findOne({ where: { email, token } });
    if (userDetails === null) {
      return responseError({ res, code: 500, data: 'User not found ! or invalid token' });
    }

    // Single use, claimed before it is used: clear the token where it still holds this value, and
    // go on only if this request is the one that cleared it - two requests racing with the same
    // link cannot both change the password. A null token can never be matched again, because the
    // shape check above refuses anything that is not 32 hex characters. If the change below then
    // fails, the link stays spent and the user asks for a new one.
    const [claimed] = await User.update({ token: null }, { where: { id: userDetails.id, token } });
    if (claimed !== 1) {
      return responseError({ res, code: 500, data: 'User not found ! or invalid token' });
    }

    const userInfo = await EmailPassword.getUserByEmail(email);

    if (userInfo === undefined) {
      throw new Error('Should never come here');
    }

    // supertokens-node 13: OK | UNKNOWN_USER_ID_ERROR | EMAIL_ALREADY_EXISTS_ERROR.
    const changed = await EmailPassword.updateEmailOrPassword({
      userId: userInfo.id,
      password: password,
    });
    if (changed.status !== 'OK') {
      return responseError({ res, code: 500, data: 'Could not change the password' });
    }

    return responseSuccess(res, 'sucess');
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

export const deleteBookeeper = async (req: Request, res: Response) => {
  // One plain row id (the guard, fromBookkeeperRowId, reads it the same way). An array would
  // become `IN (...)` and delete rows the guard never checked.
  const raw = req.body?.id;
  const id = typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw)) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    return responseError({ res, code: 400, message: 'Bookkeeper id is required' });
  }
  try {
    // The person's ChurchMembers row goes too: access reads ChurchMembers only.
    const removed = await removeLegacyBookkeeper(id);
    if (!removed) {
      return responseError({ res, code: 404, message: 'Bookkeeper not found' });
    }
    if (removed === 'owner') {
      // Nothing was deleted. The People tab removes owners, and keeps a church from losing its last.
      return responseError({ res, code: 409, message: 'Remove owners from the People tab.' });
    }
    return responseSuccess(res, 'deleted');
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

export const getBatches = async (req: Request, res: Response, next: NextFunction) => {
  const { refresh_token } = req.body;
  const config = {
    method: 'get',
    url: 'https://api.planningcenteronline.com/giving/v2/batches',
    headers: {
      Authorization: `Bearer ${refresh_token}`,
    },
  };

  try {
    const response = await axios(config);
    const data = response.data.data;
    return responseSuccess(res, data);
  } catch (e) {
    return responseError({ res, code: 500, data: e });
  }
};

export const tesst = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // await user.create({
    //   email: 'test@gmail.com',
    //   firstName: 'test',
    //   lastName: 'ts',
    //   password: '123123213',
    //   isSubscribe: false,
    // });

    return responseSuccess(res, 'working');
  } catch (e) {
    console.log('er', e);
  }
};

export const manualSync = async (req: Request, res: Response) => {
  const { email, batchId = '0', realBatchId, bankData, donations } = req.body; // refresh token if for pc

  try {
    const user = await User.findOne({
      where: { email: email as string },
    });

    // Guard empty user BEFORE any `user.id` dereference below - a nonexistent email otherwise throws
    // a TypeError (caught as a 404) instead of the intended "Empty User" 500.
    if (isEmpty(user)) {
      return responseError({ res, code: 500, data: 'Empty User' });
    }

    if (batchId === '0') {
      return responseError({ res, code: 204, data: 'Dont have batch id' });
    }

    const synchedBatchesData = await UserSync.findAll({
      where: { userId: user.id, batchId: realBatchId as string },
      attributes: ['id', 'batchId', 'status', 'createdAt'],
    });

    const settingsJson = await UserSettings.findOne({ where: { userId: user.id } });

    // Already-synced guard: if any day for this (userId + realBatchId) is already posted, treat as
    // synced. The engine's own claim-then-post + fast-path is the authoritative dedupe; this keeps
    // the previous fast-fail UX for an already-completed batch.
    if (synchedBatchesData.some((a) => a.status === 'posted')) {
      return responseError({ res, code: 500, data: 'Batch ID is already synched' });
    }

    if (isEmpty(settingsJson)) {
      return responseError({ res, code: 500, data: 'Settings not set !' });
    }

    if (!donations || donations.length === 0) {
      throw new Error(`Empty donations`);
    }

    // Unified path: manual sync now produces the SAME per-day Journal Entries as automated sync
    // (claim-then-post + fast-path + Stripe-electronic filter), replacing the old single Deposit.
    // The engine records `UserSync.batchId = realBatchId`, so the batch-list checkmark keeps working.
    const result = await syncBatchToJournalEntries({
      user,
      batchId: String(batchId),
      realBatchId,
      bankData,
    });

    return responseSuccess(res, result);
  } catch (e) {
    return responseError({ res, code: 404, message: e.message || 'Error' });
  }
};

export const healthCheck = async (req: SessionRequest, res: Response) => {
  if (req.session!.getUserId()) {
    return res.status(200).json(true);
    // session exists
  } else {
    return res.status(500).json(false);
    // session doesn't exist
  }
};
