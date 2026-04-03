export interface IEmailSender {
  /** Single link to the HTML review page (POST forms; no mutating GET). */
  sendAdminApprovalRequest(params: {
    readonly userEmail: string;
    readonly reviewToken: string;
  }): Promise<void>;

  sendUserPendingRegistration(params: { readonly email: string }): Promise<void>;

  sendUserApproved(params: { readonly email: string }): Promise<void>;

  sendUserRejected(params: { readonly email: string; readonly reason?: string }): Promise<void>;

  sendClientAccessRequestToOwner(params: {
    readonly ownerEmail: string;
    readonly clientEmail: string;
    readonly clientName: string;
    readonly clientLastName: string;
    readonly agentId: string;
    readonly approvalToken: string;
  }): Promise<void>;

  sendClientAccessApproved(params: {
    readonly clientEmail: string;
    readonly agentId: string;
  }): Promise<void>;

  sendClientAccessRejected(params: {
    readonly clientEmail: string;
    readonly agentId: string;
    readonly reason?: string;
  }): Promise<void>;

  sendClientRegistrationRequestToOwner(params: {
    readonly ownerEmail: string;
    readonly clientEmail: string;
    readonly clientName: string;
    readonly clientLastName: string;
    readonly approvalToken: string;
  }): Promise<void>;

  sendClientRegistrationApproved(params: {
    readonly clientEmail: string;
  }): Promise<void>;

  sendClientRegistrationRejected(params: {
    readonly clientEmail: string;
    readonly reason?: string;
  }): Promise<void>;

  sendClientPasswordRecovery(params: {
    readonly clientEmail: string;
    readonly recoveryToken: string;
  }): Promise<void>;
}
