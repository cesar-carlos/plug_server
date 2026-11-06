/** Safe SMTP diagnostics: never include provider text, addresses or message content. */
export interface EmailDeliveryFailure {
  readonly permanentRecipientRejection: boolean;
  readonly message: string;
}

const knownCodes = new Set([
  "EENVELOPE",
  "EAUTH",
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "EMESSAGE",
]);
const knownCommands = new Set([
  "RCPT TO",
  "MAIL FROM",
  "DATA",
  "CONN",
  "EHLO",
  "HELO",
  "STARTTLS",
  "AUTH PLAIN",
  "AUTH LOGIN",
]);

export const describeEmailDeliveryFailure = (error: unknown): EmailDeliveryFailure => {
  const fields =
    error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code =
    typeof fields.code === "string" && knownCodes.has(fields.code) ? fields.code : "UNKNOWN";
  const command =
    typeof fields.command === "string" && knownCommands.has(fields.command)
      ? fields.command
      : "UNKNOWN";
  const response =
    typeof fields.responseCode === "number" &&
    Number.isInteger(fields.responseCode) &&
    fields.responseCode >= 400 &&
    fields.responseCode <= 599
      ? fields.responseCode
      : null;
  // Only a definitive recipient refusal is terminal. Network/authentication/DATA
  // failures are not evidence that the recipient address is permanently invalid.
  const permanentRecipientRejection =
    code === "EENVELOPE" &&
    command === "RCPT TO" &&
    response !== null &&
    response >= 500 &&
    (fields.rejectedErrors === undefined ||
      (Array.isArray(fields.rejectedErrors) &&
        fields.rejectedErrors.every((rejection: unknown) => {
          if (rejection === null || typeof rejection !== "object") return false;
          const status = (rejection as Record<string, unknown>).responseCode;
          return (
            typeof status === "number" && Number.isInteger(status) && status >= 500 && status <= 599
          );
        })));
  const details = `code=${code}; command=${command}; response=${response ?? "unknown"}`;
  return {
    permanentRecipientRejection,
    message: permanentRecipientRejection
      ? `permanent_recipient_rejection: ${details}. Verify recipient/domain and current approval state before a manual resend.`
      : `email_delivery_failed: ${details}. Check SMTP connectivity/authentication and provider diagnostics.`,
  };
};
