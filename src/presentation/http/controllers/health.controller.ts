import type { Request, Response } from "express";

import { env } from "../../../shared/config/env";
import { nowUtcIso } from "../../../shared/utils/date";

const buildHealthPayload = (response: Response): {
  status: string;
  service: string;
  environment: string;
  timestamp: string;
  uptimeInSeconds: number;
  requestId: string | undefined;
} => ({
  status: "ok",
  service: env.appName,
  environment: env.nodeEnv,
  timestamp: nowUtcIso(),
  uptimeInSeconds: Math.floor(process.uptime()),
  requestId: response.locals.requestId as string | undefined,
});

export const getHealthLive = (_request: Request, response: Response): void => {
  response.status(200).json({
    ...buildHealthPayload(response),
    mode: "live",
  });
};

export const getHealthReady = (_request: Request, response: Response): void => {
  response.status(200).json({
    ...buildHealthPayload(response),
    mode: "ready",
    checks: {
      envLoaded: true,
      memoryStoreReady: true,
    },
  });
};

export const getHealth = (request: Request, response: Response): void => {
  getHealthReady(request, response);
};
