/**
 * A caught axios error passed to responseError must not take its request to the browser: the
 * request config holds `Authorization: Bearer <OAuth token>` and, for a token refresh, the client
 * secret and refresh token in the body.
 */
jest.mock('../../controller/automation', () => ({ generatePcToken: jest.fn() }));
jest.mock('../../services/qboClient', () => ({ getQboTokensForUser: jest.fn() }));
jest.mock('../../utils/quickBookApi', () => ({ __esModule: true, default: jest.fn() }));

import axios, { AxiosError } from 'axios';
import { responseError } from '../response';
import { generatePcToken } from '../../controller/automation';
import { getFunds } from '../../controller/planning-center';

const BEARER = 'PCO-LIVE-ACCESS-TOKEN';
const CLIENT_SECRET = 'PCO-CLIENT-SECRET';

const makeRes = () => { const res: any = {}; res.status = jest.fn().mockReturnValue(res); res.json = jest.fn().mockReturnValue(res); return res; };
// What Express would put on the wire.
const wire = (res: any) => JSON.stringify(res.json.mock.calls[0][0]);

/**
 * An AxiosError carrying the request config axios itself built (merged headers, serialised body),
 * as a 401 from Planning Center would produce. The adapter stands in for the network.
 */
const failedRequest = async (status = 401): Promise<AxiosError> => {
  try {
    await axios.post(
      'https://api.planningcenteronline.com/oauth/token',
      { client_secret: CLIENT_SECRET, refresh_token: 'PCO-REFRESH' },
      {
        headers: { Authorization: `Bearer ${BEARER}` },
        adapter: async (config) => {
          const response = { data: { errors: [] }, status, statusText: 'Unauthorized', headers: {}, config, request: {} };
          throw new AxiosError(`Request failed with status code ${status}`, AxiosError.ERR_BAD_REQUEST, config, {}, response as any);
        },
      },
    );
  } catch (e) {
    return e as AxiosError;
  }
  throw new Error('expected the request to fail');
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('responseError', () => {
  test('an axios error as data keeps what went wrong but not the request', async () => {
    const err = await failedRequest();
    expect(JSON.stringify(err)).toContain(BEARER); // the leak this guards against

    const res = makeRes();
    responseError({ res, code: 500, data: err });
    const body = JSON.parse(wire(res));

    expect(wire(res)).not.toContain(BEARER);
    expect(wire(res)).not.toContain(CLIENT_SECRET);
    expect(body.data).not.toHaveProperty('config');
    expect(body.data).toEqual(
      expect.objectContaining({ message: 'Request failed with status code 401', name: 'AxiosError', status: 401 }),
    );
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('an axios error as message is scrubbed the same way', async () => {
    const res = makeRes();
    responseError({ res, code: 400, message: (await failedRequest()) as any });
    expect(wire(res)).not.toContain(BEARER);
    expect(wire(res)).not.toContain(CLIENT_SECRET);
  });

  test('anything that is not an axios error is sent exactly as before', () => {
    const res = makeRes();
    responseError({ res, code: 400, message: 'not found !', data: { reason: 'x' } });
    expect(res.json).toHaveBeenCalledWith({ code: 400, message: 'not found !', data: { reason: 'x' }, success: false });
  });
});

describe('getFunds when Planning Center refuses the request', () => {
  test('the church\'s Planning Center token is not in the error response', async () => {
    (generatePcToken as jest.Mock).mockResolvedValue({ access_token: BEARER, refresh_token: 'PCO-REFRESH' });
    const err = await failedRequest(401); // 401: not retried, straight to the catch
    jest.spyOn(axios, 'get').mockRejectedValue(err);

    const res = makeRes();
    await getFunds({ query: { email: 'church@b.test' } } as any, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(wire(res)).not.toContain(BEARER);
  });
});
