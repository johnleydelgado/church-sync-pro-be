import { Request, Response } from 'express';
import { responseSuccess } from '../utils/response';

/**
 * Kept as a route only so the sign-in page's call still succeeds; it writes nothing.
 *
 * It used to run `User.update(<the whole body>, { where: { email } })`, which let a caller write any
 * Users column - email, role, isActive - onto the account row. The one caller (the QuickBooks /
 * Planning Center / Stripe sign-in page, secondaryLogin) sends access_token_* / refresh_token_* /
 * realm_id, and the Users table has none of those columns, so the allow-list of fields this may
 * write is empty. Connections are stored by updateUserToken.
 */
export const addTokenInUser = async (_req: Request, res: Response) => responseSuccess(res, 'success');
