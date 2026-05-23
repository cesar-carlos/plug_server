import { beforeEach, describe, expect, it, vi } from "vitest";

import { NodemailerEmailSender } from "../../../../src/infrastructure/adapters/nodemailer_email_sender";

describe("NodemailerEmailSender", () => {
  const sendMail = vi.fn();

  const buildSender = (): NodemailerEmailSender => {
    const sender = new NodemailerEmailSender({
      appName: "Plug",
      appBaseUrl: "https://app.example.com///",
      adminEmail: "admin@example.com",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpUser: "smtp-user",
      smtpPass: "smtp-pass",
      smtpFrom: "Plug <noreply@example.com>",
    });

    (sender as { transporter: { sendMail: typeof sendMail } }).transporter = { sendMail };
    return sender;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sendMail.mockResolvedValue(undefined);
  });

  it("normalizes the base URL and encodes the approval token in admin emails", async () => {
    const sender = buildSender();

    await sender.sendAdminApprovalRequest({
      userEmail: 'user+"danger"@example.com',
      reviewToken: 'token with spaces/&?<>"',
    });

    const mail = sendMail.mock.calls[0]?.[0];
    expect(mail.to).toBe("admin@example.com");
    expect(mail.html).toContain(
      "https://app.example.com/api/v1/auth/registration/review?token=token%20with%20spaces%2F%26%3F%3C%3E%22",
    );
    expect(mail.html).toContain('<meta charset="utf-8"/>');
    expect(mail.html).toContain("user+&quot;danger&quot;@example.com");
  });

  it("escapes client data in owner review emails", async () => {
    const sender = buildSender();

    await sender.sendClientAccessRequestToOwner({
      ownerEmail: "owner@example.com",
      clientEmail: 'client+"bad"@example.com',
      clientName: "<Client>",
      clientLastName: '"Name"',
      agentId: "agent-123",
      approvalToken: 'tok"&<>',
    });

    const mail = sendMail.mock.calls[0]?.[0];
    expect(mail.to).toBe("owner@example.com");
    expect(mail.html).toContain("&lt;Client&gt; &quot;Name&quot;");
    expect(mail.html).toContain("client+&quot;bad&quot;@example.com");
    expect(mail.html).toContain(
      "https://app.example.com/api/v1/client-access/review?token=tok%22%26%3C%3E",
    );
  });
});
