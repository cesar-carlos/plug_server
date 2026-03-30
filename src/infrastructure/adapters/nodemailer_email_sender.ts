import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

import type { IEmailSender } from "../../domain/ports/email_sender.port";
import { logger } from "../../shared/utils/logger";

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

export class NodemailerEmailSender implements IEmailSender {
  private transporter: Transporter | null = null;

  constructor(private readonly config: NodemailerEmailSenderConfig) {}

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
    const base = normalizeBaseUrl(this.config.appBaseUrl);
    return `${base}/api/v1/auth/registration/review?token=${encodeURIComponent(reviewToken)}`;
  }

  async sendAdminApprovalRequest(params: {
    readonly userEmail: string;
    readonly reviewToken: string;
  }): Promise<void> {
    if (!this.isConfigured()) {
      logger.warn("SMTP not configured; skipping admin approval email", {
        userEmail: params.userEmail,
      });
      return;
    }

    const reviewUrl = this.reviewPageUrl(params.reviewToken);
    const safeEmail = escapeHtml(params.userEmail);

    const html = `
<!DOCTYPE html>
<html><body style="font-family: sans-serif;">
  <p>New registration request for <strong>${safeEmail}</strong>.</p>
  <p>Open the review page to <strong>approve</strong> or <strong>reject</strong> (POST forms — safe to preview).</p>
  <p>
    <a href="${reviewUrl}" style="display:inline-block;padding:10px 16px;background:#0d6efd;color:#fff;text-decoration:none;border-radius:6px;">Review registration</a>
  </p>
  <p style="font-size:12px;color:#666;">If the button does not work, copy this link:<br/>${escapeHtml(reviewUrl)}</p>
</body></html>`;

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
      logger.warn("SMTP not configured; skipping user pending registration email", {
        email: params.email,
      });
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
      logger.warn("SMTP not configured; skipping user approved email", { email: params.email });
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
      logger.warn("SMTP not configured; skipping user rejected email", { email: params.email });
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
}
