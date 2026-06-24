import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Request } from "express";

import {
  buildApprovalErrorHtml,
  buildApprovalZodErrorHtml,
  isBrowserLikeApprovalErrorRequest,
  shouldReturnHtmlForApprovalError,
} from "../../../../../src/presentation/http/helpers/approval_error_html";
import {
  badRequest,
  forbidden,
  passwordRecoveryTokenExpired,
  registrationTokenExpired,
} from "../../../../../src/shared/errors/http_errors";

const mockRequest = (overrides: Partial<Request> & { originalUrl?: string }): Request => {
  const headers = new Map<string, string | undefined>();
  return {
    path: "/api/v1/client-access/approve",
    originalUrl: "/api/v1/client-access/approve",
    get: (name: string) => headers.get(name.toLowerCase()) ?? undefined,
    ...overrides,
  } as Request;
};

describe("approval_error_html", () => {
  it("detects browser-like approval error requests (form, not json)", () => {
    const form = mockRequest({
      get: (n) => (n === "Content-Type" ? "application/x-www-form-urlencoded" : undefined),
    });
    const json = mockRequest({
      get: (n) => (n === "Content-Type" ? "application/json" : undefined),
    });
    const html = mockRequest({ get: (n) => (n === "Accept" ? "text/html" : undefined) });
    expect(isBrowserLikeApprovalErrorRequest(form)).toBe(true);
    expect(isBrowserLikeApprovalErrorRequest(json)).toBe(false);
    expect(isBrowserLikeApprovalErrorRequest(html)).toBe(true);
  });

  it("returns HTML for client-registration app errors in Portuguese when Accept-Language prefers pt", () => {
    const req = mockRequest({
      originalUrl: "/api/v1/client-auth/registration/reject",
      get: (name: string) => {
        const l = name.toLowerCase();
        if (l === "accept-language") {
          return "pt-BR";
        }
        return undefined;
      },
    });
    const err = registrationTokenExpired("This rejection link has expired");
    const built = buildApprovalErrorHtml(req, err, "req-client-reg-1");
    expect(built).not.toBeNull();
    expect(built?.html).toContain("Este link de aprovação expirou");
    expect(built?.html).toContain("lista de clientes");
  });

  it("returns HTML for client-access app errors in Portuguese when Accept-Language prefers pt", () => {
    const req = mockRequest({
      originalUrl: "/api/v1/client-access/reject",
      get: (name: string) => {
        const l = name.toLowerCase();
        if (l === "accept-language") {
          return "pt-BR";
        }
        return undefined;
      },
    });
    const err = registrationTokenExpired("This approval link has expired");
    const built = buildApprovalErrorHtml(req, err, "req-approval-1");
    expect(built).not.toBeNull();
    expect(built?.html).toContain("Este link de aprovação expirou");
  });

  it("embeds request ids in validation HTML", () => {
    const req = mockRequest({ originalUrl: "/api/v1/client-access/approve" });
    const zod = z.object({ token: z.string().min(3) }).safeParse({ token: "" }).error!;
    const built = buildApprovalZodErrorHtml(req, zod, "req-zod-1");
    expect(built).not.toBeNull();
    expect(built?.html).toContain("req-zod-1");
  });

  it("returns null for non-approval routes", () => {
    const req = mockRequest({ originalUrl: "/api/v1/auth/login" });
    const zod = z.object({ a: z.string() }).strict().safeParse({ b: 1 }).error!;
    const out = buildApprovalZodErrorHtml(req, zod);
    expect(out).toBeNull();
  });

  it("returns HTML for password recovery reset errors", () => {
    const req = mockRequest({
      originalUrl: "/api/v1/client-auth/password-recovery/reset",
      get: (name: string) => {
        const l = name.toLowerCase();
        if (l === "accept-language") {
          return "en";
        }
        return undefined;
      },
    });
    const err = passwordRecoveryTokenExpired("This password recovery link has expired");
    const built = buildApprovalErrorHtml(req, err);
    expect(built).not.toBeNull();
    expect(built?.html).toContain("password recovery link has expired");
  });

  it("returns HTML for password recovery forbidden and bad request errors", () => {
    const req = mockRequest({
      originalUrl: "/api/v1/client-auth/password-recovery/reset",
      get: (name: string) => {
        const l = name.toLowerCase();
        if (l === "accept-language") {
          return "en";
        }
        return undefined;
      },
    });
    const forbiddenBuilt = buildApprovalErrorHtml(req, forbidden("Client account is not active"));
    const badRequestBuilt = buildApprovalErrorHtml(
      req,
      badRequest("New password must be different from current password"),
    );
    expect(forbiddenBuilt?.statusCode).toBe(403);
    expect(forbiddenBuilt?.html).toContain("Client account is not active");
    expect(badRequestBuilt?.statusCode).toBe(400);
    expect(badRequestBuilt?.html).toContain("New password must be different from current password");
  });

  it("isHtml: requires approval path and browser-like request", () => {
    const good = mockRequest({
      originalUrl: "/api/v1/client-access/approve",
      get: (n) => (n === "Content-Type" ? "application/x-www-form-urlencoded" : undefined),
    });
    const badPath = mockRequest({
      path: "/api/v1/ping",
      originalUrl: "/api/v1/ping",
      get: (n) => (n === "Content-Type" ? "application/x-www-form-urlencoded" : undefined),
    });
    expect(shouldReturnHtmlForApprovalError(good)).toBe(true);
    expect(shouldReturnHtmlForApprovalError(badPath)).toBe(false);
  });
});
