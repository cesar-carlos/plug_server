import { io as ioClient } from "socket.io-client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestServer } from "../helpers/test_server";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAdminUser } from "./helpers/seed_agent";

describe("Socket.IO blocked account", () => {
  let baseUrl = "";
  let close: () => Promise<void>;

  beforeAll(async () => {
    const server = await createTestServer();
    baseUrl = server.getUrl();
    close = server.close;
  });

  afterAll(async () => {
    await close();
  });

  it("rejects /consumers connection when user is blocked", async () => {
    const admin = await seedAdminUser(baseUrl, {
      email: `adm-sock-${Date.now()}@test.com`,
      password: "Admin1234",
    });
    const email = `sock-block-${Date.now()}@test.com`;
    const reg = await request(baseUrl).post("/api/v1/auth/register").send({ email, password: "User1234" });
    expect(reg.status).toBe(201);
    await approveRegistrationByToken(baseUrl, reg.body.approvalToken as string);
    const userId = reg.body.user.id as string;
    const login = await request(baseUrl).post("/api/v1/auth/login").send({ email, password: "User1234" });
    expect(login.status).toBe(200);
    const accessToken = login.body.accessToken as string;

    const patch = await request(baseUrl)
      .patch(`/api/v1/admin/users/${userId}/status`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ status: "blocked" });
    expect(patch.status).toBe(200);

    await new Promise<void>((resolve, reject) => {
      const socket = ioClient(`${baseUrl}/consumers`, {
        auth: { token: accessToken },
        transports: ["websocket"],
      });
      const timer = setTimeout(() => {
        socket.disconnect();
        reject(new Error("timeout: expected connect_error"));
      }, 10_000);
      socket.on("connect", () => {
        clearTimeout(timer);
        socket.disconnect();
        reject(new Error("expected handshake to fail when blocked"));
      });
      socket.on("connect_error", (err: Error) => {
        clearTimeout(timer);
        socket.disconnect();
        const msg = err.message.toLowerCase();
        expect(msg.includes("forbidden") || msg.includes("blocked") || msg.includes("403")).toBe(true);
        resolve();
      });
    });
  });
});
