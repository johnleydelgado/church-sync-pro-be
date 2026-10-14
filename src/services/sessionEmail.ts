/* eslint-disable @typescript-eslint/no-explicit-any */
import ThirdPartyEmailPassword from 'supertokens-node/recipe/thirdpartyemailpassword';
import EmailPassword from 'supertokens-node/recipe/emailpassword';

// One SuperTokens lookup per person per five minutes rather than per request.
const SESSION_EMAIL_TTL_MS = 5 * 60 * 1000;
const sessionEmails = new Map<string, { email: string; at: number }>();
export const clearSessionEmailCache = () => sessionEmails.clear();
/** For tests: how many session emails are held. */
export const sessionEmailCacheSize = () => sessionEmails.size;

/**
 * The signed-in login's email, as SuperTokens holds it. A session only carries the SuperTokens
 * user id; the login may come from either recipe (email/password, or Google through
 * ThirdPartyEmailPassword).
 */
export const sessionEmail = async (sessionUserId: string | undefined): Promise<string | null> => {
  if (!sessionUserId) return null;
  const now = Date.now();
  const hit = sessionEmails.get(sessionUserId);
  if (hit && now - hit.at <= SESSION_EMAIL_TTL_MS) return hit.email;
  const st: any =
    (await ThirdPartyEmailPassword.getUserById(sessionUserId)) ?? (await EmailPassword.getUserById(sessionUserId));
  if (!st?.email) return null;
  const email = String(st.email);
  // Sweep on insert so people who signed in once and left don't stay in memory forever.
  sessionEmails.forEach((entry, key) => {
    if (now - entry.at > SESSION_EMAIL_TTL_MS) sessionEmails.delete(key);
  });
  sessionEmails.set(sessionUserId, { email, at: now });
  return email;
};
