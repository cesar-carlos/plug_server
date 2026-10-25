import type { NextFunction, Request, RequestHandler, Response } from "express";
import express from "express";

import { env } from "../../../shared/config/env";

// Match Express's default case-insensitive, non-strict route semantics.
const SOCKET_EVENTS_JSON_PATH = /^\/api\/v1\/client\/me\/socket-events\/?$/i;

const socketEventsJsonParser: RequestHandler = express.json({
  limit: env.restSocketEventHttpJsonBodyLimit,
});
const defaultJsonParser: RequestHandler = express.json({ limit: env.requestBodyLimit });

const isApplicationJson = (request: Request): boolean =>
  String(request.headers["content-type"] ?? "")
    .toLowerCase()
    .includes("application/json");

/**
 * Applies a larger JSON body limit only for JSON `POST /api/v1/client/me/socket-events`.
 * Other routes keep `env.requestBodyLimit`. Multipart uses multer, not this parser.
 */
export const jsonBodyParserForRoute: RequestHandler = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  if (
    request.method === "POST" &&
    SOCKET_EVENTS_JSON_PATH.test(request.path) &&
    isApplicationJson(request)
  ) {
    socketEventsJsonParser(request, response, next);
    return;
  }
  defaultJsonParser(request, response, next);
};
