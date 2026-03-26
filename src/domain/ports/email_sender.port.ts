export interface IEmailSender {
  /** Single link to the HTML review page (POST forms; no mutating GET). */
  sendAdminApprovalRequest(params: {
    readonly userEmail: string;
    readonly reviewToken: string;
  }): Promise<void>;

  sendUserPendingRegistration(params: { readonly email: string }): Promise<void>;

  sendUserApproved(params: { readonly email: string }): Promise<void>;

  sendUserRejected(params: { readonly email: string; readonly reason?: string }): Promise<void>;
}
