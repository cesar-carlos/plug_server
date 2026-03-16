import type { NextFunction, Request, Response } from "express";

type RequestHandler = (
  request: Request,
  response: Response,
  next: NextFunction,
) => void | Promise<void>;

export const asyncHandler = (fn: RequestHandler) => {
  return (request: Request, response: Response, next: NextFunction): void => {
    void Promise.resolve(fn(request, response, next)).catch(next);
  };
};
