import { createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodemailerEmailSender } from "../../../../src/infrastructure/adapters/nodemailer_email_sender";

describe("NodemailerEmailSender SMTP integration", () => {
  let server: Server;
  let port: number;
  const sockets = new Set<Socket>();
  const messages: string[] = [];
  const recipients: string[] = [];
  const authenticatedUsers: string[] = [];

  beforeEach(async () => {
    messages.length = 0;
    recipients.length = 0;
    authenticatedUsers.length = 0;
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let buffered = "";
      let content: string[] | null = null;
      let acceptedRecipient = false;
      socket.write("220 localhost test SMTP\r\n");
      socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        let end: number;
        while ((end = buffered.indexOf("\r\n")) !== -1) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          if (content !== null) {
            if (line === ".") {
              messages.push(content.join("\r\n"));
              content = null;
              socket.write("250 Message accepted\r\n");
            } else {
              content.push(line.replace(/^\.\./, "."));
            }
          } else if (line.startsWith("EHLO")) {
            socket.write("250-localhost\r\n250-PIPELINING\r\n250 AUTH PLAIN\r\n");
          } else if (line.startsWith("AUTH PLAIN ")) {
            const credentials = Buffer.from(line.slice(11), "base64").toString().split("\0");
            authenticatedUsers.push(credentials[1] ?? "");
            socket.write("235 Authenticated\r\n");
          } else if (line.startsWith("MAIL FROM:")) {
            acceptedRecipient = false;
            socket.write("250 Sender accepted\r\n");
          } else if (line.startsWith("RCPT TO:")) {
            recipients.push(line);
            acceptedRecipient = !line.includes("blocked@example.com");
            socket.write(acceptedRecipient ? "250 Recipient accepted\r\n" : "550 Rejected\r\n");
          } else if (line === "DATA") {
            if (acceptedRecipient) {
              content = [];
              socket.write("354 End with dot\r\n");
            } else {
              socket.write("554 No accepted recipients\r\n");
            }
          } else if (line === "QUIT") {
            socket.end("221 Bye\r\n");
          } else if (line === "RSET") {
            acceptedRecipient = false;
            socket.write("250 Reset\r\n");
          } else {
            socket.write("500 Unsupported command\r\n");
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing SMTP port");
    port = address.port;
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  const buildSender = (): NodemailerEmailSender =>
    new NodemailerEmailSender({
      appName: "Plug",
      appBaseUrl: "https://app.example.com",
      adminEmail: "admin@example.com",
      smtpHost: "127.0.0.1",
      smtpPort: port,
      smtpUser: "test-user",
      smtpPass: "synthetic-test-password",
      smtpFrom: "Plug <noreply@example.com>",
    });

  it("should authenticate and deliver recovery emails through the real SMTP transport", async () => {
    const sender = buildSender();

    await sender.sendClientPasswordRecovery({
      clientEmail: "client@example.com",
      recoveryToken: "synthetic-token",
    });

    expect(authenticatedUsers).toEqual(["test-user"]);
    expect(recipients).toEqual(["RCPT TO:<client@example.com>"]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("From: Plug <noreply@example.com>");
    expect(messages[0]).toContain("Subject: [Plug] Client password recovery");
    const decodedMessage = messages[0]
      ?.replace(/=\r\n/g, "")
      .replace(/=([0-9A-F]{2})/g, (_match: string, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    expect(decodedMessage).toContain(
      "https://app.example.com/api/v1/client-auth/password-recovery/review?token=synthetic-token",
    );
  });

  it("should propagate recipient rejection and still deliver a later message", async () => {
    const sender = buildSender();

    await expect(sender.sendUserApproved({ email: "blocked@example.com" })).rejects.toMatchObject({
      code: "EENVELOPE",
      responseCode: 550,
    });
    expect(messages).toHaveLength(0);

    await sender.sendUserApproved({ email: "accepted@example.com" });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("To: accepted@example.com");
    expect(messages[0]).toContain("Subject: [Plug] Your account was approved");
  });
});
