import { Response } from "express";
import axios from "axios";
import httpStatus from "http-status";
import messages from "../constant/messages";

interface resObject {
  code: number; // replace "any" with the expected type of "res"
  message: string;
  data: any | null; // replace "any" with the expected type of "data"
  success: boolean;
}

interface ApiResponseError {
  res: Response;
  code?: number;
  message?: string;
  data?: any | null;
}

function returnObject(obj: resObject) {
  const { code, message = "", data = null, success = true } = obj;
  return { code, message, data, success };
}

function responseData(res: Response, httpCode: number, apiResponse: resObject) {
  const { code, message, data, success } = returnObject(apiResponse);
  // Do not log `data` - responses include OAuth tokens and church financial records.
  res.status(httpCode).json({ code, message, data, success });
}

/**
 * A caught axios error serialises with its request config: the headers (`Authorization: Bearer
 * <a church's Planning Center token>`) and the body (a refresh token, a client secret). Handlers
 * pass caught errors straight in as `data` or `message`, so a Planning Center hiccup on the
 * Mapping page sent the church's live token to the browser. Keep what the error says; drop the
 * request it was about, and the stack (server paths).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- `message` is typed string, but callers pass caught errors
function withoutRequest(value: any): any {
  if (!axios.isAxiosError(value)) return value;
  const json = value.toJSON() as Record<string, unknown>;
  delete json.config;
  delete json.stack;
  return json;
}

export function responseError(apiResponseInput: ApiResponseError): void {
  const {
    res,
    code = httpStatus.INTERNAL_SERVER_ERROR,
    message = messages.generalMessage.Error,
    data = null,
  } = apiResponseInput;

  return responseData(res, code, {
    code,
    message: withoutRequest(message),
    data: withoutRequest(data),
    success: false,
  });
}

export function responseSuccess(res: Response, data: any) {
  return responseData(res, httpStatus.OK, {
    code: httpStatus.OK,
    message: messages.generalMessage.success,
    data,
    success: true,
  });
}
