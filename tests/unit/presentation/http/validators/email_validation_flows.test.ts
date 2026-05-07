import { describe, expect, it } from "vitest";

import {
  agentLoginBodySchema,
  loginBodySchema,
  registerBodySchema,
  registrationRetryBodySchema,
} from "../../../../../src/presentation/http/validators/auth.validator";
import {
  clientLoginBodySchema,
  clientPasswordRecoveryRequestBodySchema,
  clientRegisterBodySchema,
  clientRegistrationRetryBodySchema,
} from "../../../../../src/presentation/http/validators/client_auth.validator";
import {
  clientAgentAccessRequestIdParamSchema,
  clientAgentIdsBodySchema,
} from "../../../../../src/presentation/http/validators/client_agents.validator";

describe("auth.validator email-related schemas", () => {
  const validRegister = {
    email: "User@Example.COM",
    password: "Password1",
  };

  it("registerBodySchema lowercases email and accepts valid payload", () => {
    const parsed = registerBodySchema.parse(validRegister);
    expect(parsed.email).toBe("user@example.com");
  });

  it("registerBodySchema rejects invalid email", () => {
    expect(() => registerBodySchema.parse({ ...validRegister, email: "not-an-email" })).toThrow(
      "Must be a valid email address",
    );
  });

  it("registrationRetryBodySchema lowercases email", () => {
    const parsed = registrationRetryBodySchema.parse({
      email: "Retry@Example.COM",
      password: "any-non-empty",
    });
    expect(parsed.email).toBe("retry@example.com");
  });

  it("registrationRetryBodySchema rejects invalid email", () => {
    expect(() => registrationRetryBodySchema.parse({ email: "bad", password: "x" })).toThrow(
      "Must be a valid email address",
    );
  });

  it("loginBodySchema rejects malformed email when email is provided", () => {
    expect(() =>
      loginBodySchema.parse({
        email: "not-an-email",
        password: "Password1",
      }),
    ).toThrow("Must be a valid email address");
  });

  it("loginBodySchema accepts username without email and maps email from username", () => {
    const parsed = loginBodySchema.parse({
      username: "some_user",
      password: "Password1",
    });
    expect(parsed.email).toBe("some_user");
  });

  it("loginBodySchema lowercases email when email is provided", () => {
    const parsed = loginBodySchema.parse({
      email: "Login@Example.COM",
      password: "Password1",
    });
    expect(parsed.email).toBe("login@example.com");
  });

  it("agentLoginBodySchema rejects invalid email when email is used", () => {
    expect(() =>
      agentLoginBodySchema.parse({
        email: "oops",
        password: "Password1",
        agentId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).toThrow("Must be a valid email address");
  });

  it("agentLoginBodySchema lowercases email", () => {
    const parsed = agentLoginBodySchema.parse({
      email: "Agent@Example.COM",
      password: "Password1",
      agentId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(parsed.email).toBe("agent@example.com");
  });
});

describe("client_auth.validator email-related schemas", () => {
  const validClientRegister = {
    ownerEmail: "Owner@Example.COM",
    email: "Client@Example.COM",
    password: "ClientReg1",
    name: "Ada",
    lastName: "Lovelace",
  };

  it("clientRegisterBodySchema lowercases owner and client emails", () => {
    const parsed = clientRegisterBodySchema.parse(validClientRegister);
    expect(parsed.ownerEmail).toBe("owner@example.com");
    expect(parsed.email).toBe("client@example.com");
  });

  it("clientRegisterBodySchema rejects invalid ownerEmail", () => {
    expect(() =>
      clientRegisterBodySchema.parse({
        ...validClientRegister,
        ownerEmail: "not-email",
      }),
    ).toThrow("Must be a valid email address");
  });

  it("clientRegisterBodySchema rejects invalid client email", () => {
    expect(() =>
      clientRegisterBodySchema.parse({
        ...validClientRegister,
        email: "also-bad",
      }),
    ).toThrow("Must be a valid email address");
  });

  it("clientLoginBodySchema lowercases email", () => {
    const parsed = clientLoginBodySchema.parse({
      email: "Client@Example.COM",
      password: "secret",
    });
    expect(parsed.email).toBe("client@example.com");
  });

  it("clientLoginBodySchema rejects invalid email", () => {
    expect(() => clientLoginBodySchema.parse({ email: "nope", password: "secret" })).toThrow(
      "Must be a valid email address",
    );
  });

  it("clientRegistrationRetryBodySchema lowercases both emails", () => {
    const parsed = clientRegistrationRetryBodySchema.parse({
      ownerEmail: "O@Example.COM",
      email: "C@Example.COM",
      password: "retry-pass",
    });
    expect(parsed.ownerEmail).toBe("o@example.com");
    expect(parsed.email).toBe("c@example.com");
  });

  it("clientRegistrationRetryBodySchema rejects invalid ownerEmail", () => {
    expect(() =>
      clientRegistrationRetryBodySchema.parse({
        ownerEmail: "x",
        email: "ok@test.com",
        password: "p",
      }),
    ).toThrow("Must be a valid email address");
  });

  it("clientRegistrationRetryBodySchema rejects invalid client email", () => {
    expect(() =>
      clientRegistrationRetryBodySchema.parse({
        ownerEmail: "ok@test.com",
        email: "y",
        password: "p",
      }),
    ).toThrow("Must be a valid email address");
  });

  it("clientPasswordRecoveryRequestBodySchema lowercases email", () => {
    const parsed = clientPasswordRecoveryRequestBodySchema.parse({
      email: "Recover@Example.COM",
    });
    expect(parsed.email).toBe("recover@example.com");
  });

  it("clientPasswordRecoveryRequestBodySchema rejects invalid email", () => {
    expect(() => clientPasswordRecoveryRequestBodySchema.parse({ email: "bad" })).toThrow(
      "Must be a valid email address",
    );
  });
});

describe("client agent access HTTP schemas (no email on request body)", () => {
  it("clientAgentIdsBodySchema validates agentIds only", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(clientAgentIdsBodySchema.parse({ agentIds: [id] })).toEqual({ agentIds: [id] });
  });

  it("clientAgentAccessRequestIdParamSchema validates UUID for resend/retry path", () => {
    const id = "660e8400-e29b-41d4-a716-446655440001";
    expect(clientAgentAccessRequestIdParamSchema.parse({ requestId: id })).toEqual({
      requestId: id,
    });
    expect(() => clientAgentAccessRequestIdParamSchema.parse({ requestId: "not-uuid" })).toThrow(
      "Must be a valid UUID",
    );
  });
});
