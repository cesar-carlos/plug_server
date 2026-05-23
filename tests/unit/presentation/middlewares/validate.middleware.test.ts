import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { z } from "zod";

import {
  getValidated,
  normalizeZodIssues,
  validateRequest,
} from "../../../../src/presentation/http/middlewares/validate.middleware";

describe("validateRequest", () => {
  const mockResponse = (): Response => {
    const locals: Record<string, unknown> = {};
    return { locals } as Response;
  };

  it("should call next() and store validated body on success", () => {
    const schema = z.object({ email: z.string().email() });
    const middleware = validateRequest({ body: schema });
    const request = { body: { email: "user@example.com" } } as Request;
    const response = mockResponse();
    const next = vi.fn();

    middleware(request, response, next);

    expect(next).toHaveBeenCalledWith();
    expect(getValidated<{ email: string }>(response, "body")).toEqual({
      email: "user@example.com",
    });
    expect(request.body).toEqual({ email: "user@example.com" });
  });

  it("should call next(error) with ZodError instead of throwing on invalid body", () => {
    const schema = z.object({ email: z.string().email() });
    const middleware = validateRequest({ body: schema });
    const request = { body: { email: "not-an-email" } } as Request;
    const response = mockResponse();
    const next = vi.fn();

    middleware(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(z.ZodError);
    expect(response.locals.validated).toBeUndefined();
  });

  it("should call next(error) when params validation fails", () => {
    const schema = z.object({ id: z.string().uuid() });
    const middleware = validateRequest({ params: schema });
    const request = { params: { id: "not-a-uuid" } } as unknown as Request;
    const response = mockResponse();
    const next = vi.fn();

    middleware(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(z.ZodError);
  });
});

describe("normalizeZodIssues", () => {
  it("should normalize a nested field path", () => {
    const schema = z.object({ user: z.object({ email: z.string().email() }) });
    const result = schema.safeParse({ user: { email: "bad" } });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = normalizeZodIssues(result.error);
      expect(issues[0]).toMatchObject({ field: "user.email" });
    }
  });

  it("should use 'root' as field when path is empty", () => {
    const schema = z.string().min(1);
    const result = schema.safeParse("");

    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = normalizeZodIssues(result.error);
      expect(issues[0]?.field).toBe("root");
    }
  });

  it("should include the message from the schema", () => {
    const schema = z.object({ name: z.string().min(3, "Too short") });
    const result = schema.safeParse({ name: "ab" });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = normalizeZodIssues(result.error);
      expect(issues[0]).toMatchObject({ field: "name", message: "Too short" });
    }
  });

  it("should return one entry per issue when multiple fields fail", () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    const result = schema.safeParse({ a: 1, b: "x" });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = normalizeZodIssues(result.error);
      expect(issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});
