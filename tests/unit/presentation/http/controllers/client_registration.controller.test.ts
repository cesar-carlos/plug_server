import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Request, Response } from "express";

import {
  clientRegistrationReviewPage,
  clientRegistrationStatus,
} from "../../../../../src/presentation/http/controllers/client_registration.controller";

const mockGetRegistrationReviewSummary = vi.fn();
const mockGetRegistrationStatus = vi.fn();

vi.mock("../../../../../src/shared/di/container", () => ({
  container: {
    clientRegistrationService: {
      getRegistrationReviewSummary: (...args: unknown[]) =>
        mockGetRegistrationReviewSummary(...args),
      getRegistrationStatus: (...args: unknown[]) => mockGetRegistrationStatus(...args),
    },
  },
}));

const makeResponse = (): Response =>
  ({
    locals: {
      validated: {
        query: { token: "review-token-0123456789abcdef01234567" },
      },
    },
    status: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    json: vi.fn(),
    send: vi.fn(),
  }) as unknown as Response;

describe("client_registration.controller", () => {
  beforeEach(() => {
    mockGetRegistrationReviewSummary.mockReset();
    mockGetRegistrationStatus.mockReset();
  });

  it("renders read-only review page when token is expired", async () => {
    mockGetRegistrationReviewSummary.mockResolvedValue({
      ownerEmail: "owner@test.com",
      clientEmail: "client@test.com",
      clientName: "Client Expired",
      clientStatus: "pending",
      tokenStatus: "expired",
    });

    const response = makeResponse();
    await clientRegistrationReviewPage({ get: () => undefined } as unknown as Request, response);

    expect(response.status).toHaveBeenCalledWith(200);
    const html = (response.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(html).toContain("expired");
    expect(html).not.toContain('name="token"');
  });

  it("renders read-only review page when registration already resolved", async () => {
    mockGetRegistrationReviewSummary.mockResolvedValue({
      ownerEmail: "owner@test.com",
      clientEmail: "client@test.com",
      clientName: "Client Active",
      clientStatus: "active",
      tokenStatus: "pending",
    });

    const response = makeResponse();
    await clientRegistrationReviewPage({ get: () => undefined } as unknown as Request, response);

    const html = (response.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(html).toContain("already resolved");
    expect(html).not.toContain('type="submit"');
  });

  it("returns HTTP 200 with unknown poll status for invalid token", async () => {
    mockGetRegistrationStatus.mockResolvedValue({ ok: true, value: { status: "unknown" } });

    const response = makeResponse();
    const next = vi.fn();
    await clientRegistrationStatus({ get: () => undefined } as unknown as Request, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ status: "unknown" });
  });
});
