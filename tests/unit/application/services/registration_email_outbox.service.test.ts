import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IEmailSender } from "../../../../src/domain/ports/email_sender.port";

describe("registration email delivery failures", () => {
  const queryRaw = vi.fn();
  const executeRaw = vi.fn();
  const warn = vi.fn();
  const send = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    queryRaw.mockReset();
    executeRaw.mockReset().mockResolvedValue(1);
    warn.mockReset();
    send.mockReset();
    vi.doMock("../../../../src/shared/config/env", () => ({
      env: {
        registrationEmailOutboxMaxAttempts: 10,
        registrationEmailOutboxLockTimeoutMs: 60_000,
        registrationEmailOutboxBatchSize: 10,
        registrationEmailOutboxRetryBaseDelayMs: 1000,
        registrationEmailOutboxWorkerConcurrency: 1,
      },
    }));
    vi.doMock("../../../../src/infrastructure/database/prisma/client", () => ({
      prismaClient: { $queryRaw: queryRaw, $executeRaw: executeRaw },
    }));
    vi.doMock("../../../../src/shared/utils/logger", () => ({ logger: { warn, info: vi.fn() } }));
    queryRaw
      .mockResolvedValueOnce([{ exists: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "outbox-1",
          kind: "user_pending_registration",
          payload_json: { email: "person@example.invalid" },
          attempts: 0,
        },
      ]);
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  const flush = async (): Promise<void> => {
    const sender = new Proxy({} as IEmailSender, { get: () => send });
    const { flushRegistrationEmailOutbox } =
      await import("../../../../src/application/services/registration_email_outbox.service");
    await flushRegistrationEmailOutbox(sender);
  };

  it("should stop retrying permanent SMTP recipient rejection without logging provider text", async () => {
    send.mockRejectedValue(
      Object.assign(new Error("550 secret-person@example.invalid rejected"), {
        code: "EENVELOPE",
        command: "RCPT TO",
        responseCode: 550,
      }),
    );
    await flush();
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [sql, attempts, message] = executeRaw.mock.calls[0]!;
    expect((sql as string[]).join("")).not.toContain("available_at = NOW()");
    expect(attempts).toBe(10);
    expect(message).toContain("permanent_recipient_rejection");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-person");
    expect(JSON.stringify(executeRaw.mock.calls)).not.toContain("secret-person");
  });

  it("should preserve retry backoff for temporary SMTP rejection", async () => {
    send.mockRejectedValue(
      Object.assign(new Error("temporary provider text"), {
        code: "EENVELOPE",
        command: "RCPT TO",
        responseCode: 450,
      }),
    );
    await flush();
    const [sql, attempts, message, delay] = executeRaw.mock.calls[0]!;
    expect((sql as string[]).join("")).toContain("available_at = NOW()");
    expect(attempts).toBe(1);
    expect(delay).toBe(1000);
    expect(message).toContain("450");
  });

  it("should persist bounded metadata instead of an oversized untrusted error", async () => {
    send.mockRejectedValue(new Error("secret-token=" + "x".repeat(3000)));
    await flush();
    expect(executeRaw.mock.calls[0]![2]).not.toContain("secret-token");
    expect(String(executeRaw.mock.calls[0]![2]).length).toBeLessThan(1000);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-token");
  });
});
