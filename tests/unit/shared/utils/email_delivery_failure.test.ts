import { describe, expect, it } from "vitest";

import { describeEmailDeliveryFailure } from "../../../../src/shared/utils/email_delivery_failure";

describe("safe email failure diagnostics", () => {
  it.each([500, 550, 551, 553, 554, 599])(
    "should classify recipient refusal %i as terminal",
    (responseCode) => {
      expect(
        describeEmailDeliveryFailure({ code: "EENVELOPE", command: "RCPT TO", responseCode })
          .permanentRecipientRejection,
      ).toBe(true);
    },
  );

  it.each([
    { code: "EENVELOPE", command: "RCPT TO", responseCode: 450 },
    { code: "EAUTH", command: "AUTH PLAIN", responseCode: 535 },
    { code: "EMESSAGE", command: "DATA", responseCode: 554 },
    { code: "EENVELOPE", command: "MAIL FROM", responseCode: 550 },
    { code: "EENVELOPE", command: "RCPT TO", responseCode: "550" },
    { code: "EENVELOPE", command: "RCPT TO", responseCode: 600 },
    { code: "ETIMEDOUT" },
    null,
    "550 rejected",
    new Error("550 rejected"),
  ])("should not infer permanent recipient refusal from %o", (error) => {
    expect(describeEmailDeliveryFailure(error).permanentRecipientRejection).toBe(false);
  });

  it("should not expose arbitrary metadata or error text", () => {
    const failure = describeEmailDeliveryFailure({
      code: "secret-code",
      command: "AUTH secret-password",
      message: "user@example.com",
      response: "secret-token",
    });
    expect(failure.message).not.toMatch(/secret|user@example/);
    expect(failure.message).toContain("UNKNOWN");
  });

  it("should preserve retry when recipient refusals mix temporary and permanent failures", () => {
    const failure = describeEmailDeliveryFailure({
      code: "EENVELOPE",
      command: "RCPT TO",
      responseCode: 550,
      rejectedErrors: [{ responseCode: 450 }, { responseCode: 550 }],
    });
    expect(failure.permanentRecipientRejection).toBe(false);
  });
});
