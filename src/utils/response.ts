import { Response } from "express";
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
  console.log(success, httpCode, message, data);
  res.status(httpCode).json({ code, message, data, success });
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
    message,
    data,
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
