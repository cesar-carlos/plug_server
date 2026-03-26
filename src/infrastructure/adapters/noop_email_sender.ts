import type { IEmailSender } from "../../domain/ports/email_sender.port";

/** Used in tests (and optionally when SMTP is not configured) — does not send mail. */
export class NoopEmailSender implements IEmailSender {
  async sendAdminApprovalRequest(): Promise<void> {}

  async sendUserPendingRegistration(): Promise<void> {}

  async sendUserApproved(): Promise<void> {}

  async sendUserRejected(): Promise<void> {}
}
