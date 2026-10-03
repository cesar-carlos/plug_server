import type { Request, Response } from "express";

export const withRequestCancellation = async <T>(
  request: Request,
  response: Response,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const disconnected = (): void => {
    if (!response.writableEnded) controller.abort();
  };
  response.once("close", disconnected);
  if (request.aborted || response.destroyed) controller.abort();
  try {
    return await run(controller.signal);
  } finally {
    response.removeListener("close", disconnected);
  }
};
