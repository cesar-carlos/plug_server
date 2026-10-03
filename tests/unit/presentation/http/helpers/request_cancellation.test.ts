import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { withRequestCancellation } from "../../../../../src/presentation/http/helpers/request_cancellation";

describe("HTTP refresh waiter lifecycle", () => {
  it("aborts on disconnect and removes the response listener after completion", async () => {
    const response = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false });
    const pending = withRequestCancellation(
      { aborted: false } as Request,
      response as unknown as Response,
      (signal) =>
        new Promise<boolean>((resolve) =>
          signal.addEventListener("abort", () => resolve(signal.aborted), { once: true }),
        ),
    );
    response.emit("close");
    expect(await pending).toBe(true);
    expect(response.listenerCount("close")).toBe(0);
  });
  it("does not treat completed responses as disconnects and cleans up rejected work", async () => {
    const response = Object.assign(new EventEmitter(), { writableEnded: true, destroyed: false });
    await withRequestCancellation(
      { aborted: false } as Request,
      response as unknown as Response,
      async (signal) => {
        response.emit("close");
        expect(signal.aborted).toBe(false);
      },
    );
    await expect(
      withRequestCancellation(
        { aborted: false } as Request,
        response as unknown as Response,
        async () => {
          throw new Error("failed");
        },
      ),
    ).rejects.toThrow("failed");
    expect(response.listenerCount("close")).toBe(0);
  });
});
