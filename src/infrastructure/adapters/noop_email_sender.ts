import type { IEmailSender } from "../../domain/ports/email_sender.port";

/** Used in tests (and optionally when SMTP is not configured) — does not send mail. */
export class NoopEmailSender implements IEmailSender {
  readonly clientAccessRequestsToOwner: Array<{
    ownerEmail: string;
    clientEmail: string;
    clientName: string;
    clientLastName: string;
    agentId: string;
    approvalToken: string;
  }> = [];

  readonly clientAccessApproved: Array<{
    clientEmail: string;
    agentId: string;
  }> = [];

  readonly clientAccessRejected: Array<{
    clientEmail: string;
    agentId: string;
    reason?: string;
  }> = [];

  async sendAdminApprovalRequest(): Promise<void> {}

  async sendUserPendingRegistration(): Promise<void> {}

  async sendUserApproved(): Promise<void> {}

  async sendUserRejected(): Promise<void> {}

  async sendClientAccessRequestToOwner(params: {
    readonly ownerEmail: string;
    readonly clientEmail: string;
    readonly clientName: string;
    readonly clientLastName: string;
    readonly agentId: string;
    readonly approvalToken: string;
  }): Promise<void> {
    this.clientAccessRequestsToOwner.push({
      ownerEmail: params.ownerEmail,
      clientEmail: params.clientEmail,
      clientName: params.clientName,
      clientLastName: params.clientLastName,
      agentId: params.agentId,
      approvalToken: params.approvalToken,
    });
  }

  async sendClientAccessApproved(params: {
    readonly clientEmail: string;
    readonly agentId: string;
  }): Promise<void> {
    this.clientAccessApproved.push({
      clientEmail: params.clientEmail,
      agentId: params.agentId,
    });
  }

  async sendClientAccessRejected(params: {
    readonly clientEmail: string;
    readonly agentId: string;
    readonly reason?: string;
  }): Promise<void> {
    this.clientAccessRejected.push(params);
  }

  async sendClientRegistrationRequestToOwner(): Promise<void> {}

  async sendClientRegistrationApproved(): Promise<void> {}

  async sendClientRegistrationRejected(): Promise<void> {}
}
