import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Request, Response } from "express";

import { clientPasswordRecoveryReviewPage } from "../../../../../src/presentation/http/controllers/client_password_recovery.controller";

const mockGetPasswordRecoveryStatus = vi.fn();

vi.mock("../../../../../src/shared/di/container", () => ({
  container: {
    clientPasswordRecoveryService: {
      getPasswordRecoveryStatus: (...args: unknown[]) => mockGetPasswordRecoveryStatus(...args),
    },
  },
}));

const makeResponse = (): Response =>
  ({
    locals: {
      validated: {
        query: { token: "recovery-token-0123456789012345678901234567890" },
      },
    },
    status: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: vi.fn(),
  }) as unknown as Response;

describe("client_password_recovery.controller", () => {
  beforeEach(() => {
    mockGetPasswordRecoveryStatus.mockReset();
  });

  it("renders read-only review page when token is expired", async () => {
    mockGetPasswordRecoveryStatus.mockResolvedValue({
      ok: true,
      value: { status: "expired" },
    });

    const response = makeResponse();
    await clientPasswordRecoveryReviewPage(
      { get: () => undefined } as unknown as Request,
      response,
      vi.fn(),
    );

    expect(response.status).toHaveBeenCalledWith(200);
    const html = (response.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(html).toContain("expired");
    expect(html).not.toContain('type="submit"');
  });

  it("renders read-only review page when token is invalid", async () => {
    mockGetPasswordRecoveryStatus.mockResolvedValue({
      ok: true,
      value: { status: "unknown" },
    });

    const response = makeResponse();
    await clientPasswordRecoveryReviewPage(
      { get: () => undefined } as unknown as Request,
      response,
      vi.fn(),
    );

    const html = (response.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(html).toContain("invalid");
    expect(html).not.toContain('name="newPassword"');
  });
});
