import type { NextFunction, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

export const requestIdMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  const requestIdHeader = request.header("x-request-id");
  const requestId = requestIdHeader && requestIdHeader.trim() !== "" ? requestIdHeader : uuidv4();

  response.locals.requestId = requestId;
  response.setHeader("x-request-id", requestId);

  next();
};
