import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

import type { IEmailSender } from "../../domain/ports/email_sender.port";
import { logger } from "../../shared/utils/logger";
import { redactEmail } from "../../shared/utils/pii_redaction";

export interface NodemailerEmailSenderConfig {
  readonly appName: string;
  readonly appBaseUrl: string;
  readonly adminEmail: string;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpUser: string;
  readonly smtpPass: string;
  readonly smtpFrom: string;
}

const normalizeBaseUrl = (url: string): string => url.replace(/\/+$/, "");

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const buildActionEmailHtml = (params: {
  readonly introHtml: string;
  readonly actionLabel: string;
  readonly actionUrl: string;
}): string => `
<!DOCTYPE html>
<html><body style="font-family: sans-serif;">
  ${params.introHtml}
  <p>
    <a href="${escapeHtml(params.actionUrl)}" style="display:inline-block;padding:10px 16px;background:#0d6efd;color:#fff;text-decoration:none;border-radius:6px;">${escapeHtml(params.actionLabel)}</a>
  </p>
  <p style="font-size:12px;color:#666;">If the button does not work, copy this link:<br/>${escapeHtml(params.actionUrl)}</p>
</body></html>`;

export class NodemailerEmailSender implements IEmailSender {
  private transporter: Transporter | null = null;
  private readonly normalizedBaseUrl: string;

  constructor(private readonly config: NodemailerEmailSenderConfig) {
    this.normalizedBaseUrl = normalizeBaseUrl(config.appBaseUrl);
  }

  private isConfigured(): boolean {
    return this.config.smtpUser.trim() !== "" && this.config.smtpPass.trim() !== "";
  }

  private fromAddress(): string {
    const from = this.config.smtpFrom.trim();
    if (from !== "") {
      return from;
    }
    return `${this.config.appName} <${this.config.smtpUser}>`;
  }

  private getTransport(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.config.smtpHost,
        port: this.config.smtpPort,
        secure: this.config.smtpPort === 465,
        requireTLS: this.config.smtpPort === 587,
        auth: {
          user: this.config.smtpUser,
          pass: this.config.smtpPass,
        },
      });
    }
    return this.transporter;
  }

  private reviewPageUrl(reviewToken: string): string {
    return `${this.normalizedBaseUrl}/api/v1/auth/registration/review?token=${encodeURIComponent(reviewToken)}`;
  }

  private clientAccessReviewPageUrl(reviewToken: string): string {
    return `${this.normalizedBaseUrl}/api/v1/client-access/review?token=${encodeURIComponent(reviewToken)}`;
  }

  private clientRegistrationReviewPageUrl(reviewToken: string): string {
    return `${this.normalizedBaseUrl}/api/v1/client-auth/registration/review?token=${encodeURIComponent(reviewToken)}`;
  }

  private clientPasswordRecoveryReviewPageUrl(recoveryToken: string): string {
    return `${this.normalizedBaseUrl}/api/v1/client-auth/password-recovery/review?token=${encodeURIComponent(recoveryToken)}`;
  }

  private logSkippedEmail(message: string, emailLabel: string, email: string): void {
    logger.warn(message, {
      [emailLabel]: redactEmail(email),
    });
  }

  async sendAdminApprovalRequest(params: {
    readonly userEmail: string;
    readonly reviewToken: string;
  }): Promise<void> {
    if (!this.isConfigured()) {
      this.logSkippedEmail(
        "SMTP not configured; skipping admin approval email",
        "userEmailRedacted",
        params.userEmail,
      );
      return;
    }

    const reviewUrl = this.reviewPageUrl(params.reviewToken);
    const safeEmail = escapeHtml(params.userEmail);
    const html = buildActionEmailHtml({
      introHtml: `<p>New registration request for <strong>${safeEmail}</strong>.</p><p>Open the review page to <strong>approve</strong> or <strong>reject</strong> (POST forms — safe to preview).</p>`,
      actionLabel: "Review registration",
      actionUrl: reviewUrl,
    });

    await this.getTransport().sendMail({
      from: this.fromAddress(),
      to: this.config.adminEmail,
      subject: `[${this.config.appName}] New registration: ${params.userEmail}`,
      text: `Review (approve/reject via POST forms): ${reviewUrl}`,
      html,
    });
  }

  async sendUserPendingRegistration(params: { readonly email: string }): Promise<void> {
    if (!this.isConfigured()) {
      this.logSkippedEmail(
        "SMTP not configured; skipping user pending registration email",
        "emailRedacted",
        params.email,
      );
      return;
    }

    await this.getTransport().sendMail({
      from: this.fromAddress(),
      to: params.email,
      subject: `[${this.config.appName}] Registration received`,
      text: "We received your registration. An administrator will review it; you will get another email when it is approved or not approved.",
      html: `<p>We received your registration. An administrator will review it; you will get another email when it is approved or not approved.</p>`,
    });
  }

  async sendUserApproved(params: { readonly email: string }): Promise<void> {
    if (!this.isConfigured()) {
      this.logSkippedEmail(
        "SMTP not configured; skipping user approved email",
        "emailRedacted",
        params.email,
      );
      return;
    }

    await this.getTransport().sendMail({
      from: this.fromAddress(),
      to: params.email,
      subject: `[${this.config.appName}] Your account was approved`,
      text: "Your account has been approved. You can sign in now.",
      html: `<p>Your account has been approved. You can sign in now.</p>`,
    });
  }

  async sendUserRejected(params: {
    readonly email: string;
    readonly reason?: string;
  }): Promise<void> {
    if (!this.isConfigured()) {
      this.logSkippedEmail(
        "SMTP not configured; skipping user rejected email",
        "emailRedacted",
        params.email,
      );
      return;
    }

    const reasonBlock =
      typeof params.reason === "string" && params.reason.trim() !== ""
        ? `<p><strong>Note from administrator:</strong> ${escapeHtml(params.reason.trim())}</p>`
        : "";

    await this.getTransport().sendMail({
      from: this.fromAddress(),
      to: params.email,
      subject: `[${this.config.appName}] Registration not approved`,
      text:
        typeof params.reason === "string" && params.reason.trim() !== ""
          ? `Your registration was not approved. Note: ${params.reason.trim()}`
          : "Your registration was not approved. If you believe this is a mistake, contact support.",
      html: `<p>Your registration was not approved. If you believe this is a mistake, contact support.</p>${reasonBlock}`,
    });
  }

  async sendClientAccessRequestToOwner(params: {
    readonly ownerEmail: string;
    readonly clientEmail: string;
    readonly clientName: string;
    readonly clientLastName: string;
    readonly agentId: string;
    readonly approvalToken: string;
  }): Promise<void> {
    if (!this.isConfigured()) {
      this.logSkippedEmail(
        "SMTP not configured; skipping client access request email",
        "ownerEmailRedacted",
        params.ownerEmail,
      );
      return;
    }

    const reviewUrl = this.clientAccessReviewPageUrl(params.approvalToken);
    const html = buildActionEmailHtml({
      introHtml: `<p>Client <strong>${escapeHtml(params.clientName)} ${escapeHtml(params.clientLastName)}</strong> (${escapeHtml(params.clientEmail)}) requested access to agent <strong>${escapeHtml(params.agentId)}</strong>.</p>`,
      actionLabel: "Revisar acesso do cliente",
      actionUrl: reviewUrl,
    });
    await this.getTransport().sendMail({
      from: this.fromAddress(),
      to: params.ownerEmail,
      subject: `[${this.config.appName}] Client access request for agent ${params.agentId}`,
      text: `Client ${params.clientName} ${params.clientLastName} (${params.clientEmail}) requested access to agent ${params.agentId}. Review: ${reviewUrl}`,
      html,
    });
  }

  async sendClientAccessApproved(params: {
    readonly clientEmail: string;
    readonly agentId: string;
  }): Promise<void> {
    if (!this.isConfigured()) {
      this.logSkippedEmail(
        "SMTP not configured; skipping client access approved email",
        "emailRedacted",
        params.clientEmail,
      );
      return;
    }

    await this.getTransport().sendMail({
      from: this.fromAddress(),
      to: params.clientEmail,
      subject: `[${this.config.appName}] Access approved to agent ${params.agentId}`,
      text: `Your access request to agent ${params.agentId} was approved.`,
      html: `<p>Your access request to agent <strong>${escapeHtml(params.agentId)}</strong> was approved.</p>`,
    });
  }

  async sendClientAccessRejected(params: {
    readonly clientEmail: string;
    readonly agentId: string;
    readonly reason?: string;
  }): Promise<void> {
    if (!this.isConfigured()) {
      this.logSkippedEmail(
        "SMTP not configured; skipping client access rejected email",
        "emailRedacted",
        params.clientEmail,
      );
      return;
    }

    const reasonBlock =
      typeof params.reason === "string" && params.reason.trim() !== ""
        ? `<p><strong>Reason:</strong> ${escapeHtml(params.reason.trim())}</p>`
        : "";
    await this.getTransport().sendMail({
      from: this.fromAddress(),
      to: params.clientEmail,
      subject: `[${this.config.appName}] Access rejected to agent ${params.agentId}`,
      text:
        typeof params.reason === "string" && params.reason.trim() !== ""
          ? `Your access request to agent ${params.agentId} was rejected. Reason: ${params.reason.trim()}`
          : `Your access request to agent ${params.agentId} was rejected.`,
      html: `<p>Your access request to agent <strong>${escapeHtml(params.agentId)}</strong> was rejected.</p>${reasonBlock}`,
    });
  }

  async sendClientRegistrationRequestToOwner(params: {
    readonly ownerEmail: string;
    readonly clientEmail: string;
    readonly clientName: string;
    readonly clientLastName: string;
    readonly approvalToken: string;
  }): Promise<void> {
    if (!this.isConfigured()) {
      this.logSkippedEmail(
        "SMTP not configured; skipping client registration request email",
        "ownerEmailRedacted",
        params.ownerEmail,
      );
      return;
    }

    const reviewUrl = this.clientRegistrationReviewPageUrl(params.approvalToken);
    const html = buildActionEmailHtml({
      introHtml: `<p>Client <strong>${escapeHtml(params.clientName)} ${escapeHtml(params.clientLastName)}</strong> (${escapeHtml(params.clientEmail)}) requested registration under your account.</p>`,
      actionLabel: "Review client registration",
      actionUrl: reviewUrl,
    });
    await this.getTransport().sendMail({
      from: this.fromAddress(),
      to: params.ownerEmail,
      subject: `[${this.config.appName}] Client registration request`,
      text: `Client ${params.clientName} ${params.clientLastName} (${params.clientEmail}) requested registration under your account. Review: ${reviewUrl}`,
      html,
    });
  }

  async sendClientRegistrationApproved(params: { readonly clientEmail: string }): Promise<void> {
    if (!this.isConfigured()) {
      this.logSkippedEmail(
        "SMTP not configured; skipping client registration approved email",
        "emailRedacted",
        params.clientEmail,
      );
      return;
    }

    await this.getTransport().sendMail({
      from: this.fromAddress(),
      to: params.clientEmail,
      subject: `[${this.config.appName}] Client registration approved`,
      text: "Your client account registration was approved. You can sign in now.",
      html: "<p>Your client account registration was approved. You can sign in now.</p>",
    });
  }

  async sendClientRegistrationRejected(params: {
    readonly clientEmail: string;
    readonly reason?: string;
  }): Promise<void> {
    if (!this.isConfigured()) {
      this.logSkippedEmail(
        "SMTP not configured; skipping client registration rejected email",
        "emailRedacted",
        params.clientEmail,
      );
      return;
    }

    const reasonBlock =
      typeof params.reason === "string" && params.reason.trim() !== ""
        ? `<p><strong>Reason:</strong> ${escapeHtml(params.reason.trim())}</p>`
        : "";
    await this.getTransport().sendMail({
      from: this.fromAddress(),
      to: params.clientEmail,
      subject: `[${this.config.appName}] Client registration not approved`,
      text:
        typeof params.reason === "string" && params.reason.trim() !== ""
          ? `Your client registration was not approved. Reason: ${params.reason.trim()}`
          : "Your client registration was not approved. If you believe this is a mistake, contact support.",
      html: `<p>Your client registration was not approved. If you believe this is a mistake, contact support.</p>${reasonBlock}`,
    });
  }

  async sendClientPasswordRecovery(params: {
    readonly clientEmail: string;
    readonly recoveryToken: string;
  }): Promise<void> {
    if (!this.isConfigured()) {
      this.logSkippedEmail(
        "SMTP not configured; skipping client password recovery email",
        "emailRedacted",
        params.clientEmail,
      );
      return;
    }

    const reviewUrl = this.clientPasswordRecoveryReviewPageUrl(params.recoveryToken);
    const html = buildActionEmailHtml({
      introHtml: "<p>A password reset was requested for your account.</p>",
      actionLabel: "Reset password",
      actionUrl: reviewUrl,
    });
    await this.getTransport().sendMail({
      from: this.fromAddress(),
      to: params.clientEmail,
      subject: `[${this.config.appName}] Client password recovery`,
      text: `A password reset was requested for your account. Open this link to set a new password: ${reviewUrl}`,
      html,
    });
  }
}
