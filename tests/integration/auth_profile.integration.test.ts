import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { approveRegistrationByToken } from "./helpers/approve_registration";

const app = createApp();

describe("PATCH /api/v1/auth/me (celular)", () => {
  let token = "";

  beforeAll(async () => {
    const email = `profile-${Date.now()}@test.com`;
    const reg = await request(app).post("/api/v1/auth/register").send({
      email,
      password: "User1234",
    });
    expect(reg.status).toBe(201);
    await approveRegistrationByToken(app, reg.body.approvalToken as string);
    const login = await request(app).post("/api/v1/auth/login").send({ email, password: "User1234" });
    expect(login.status).toBe(200);
    token = login.body.accessToken as string;
  });

  it("sets celular", async () => {
    const res = await request(app)
      .patch("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ celular: "+5511987654321" });

    expect(res.status).toBe(200);
    expect(res.body.user.celular).toBe("+5511987654321");
  });

  it("updates celular", async () => {
    const res = await request(app)
      .patch("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ celular: "+5521987654321" });

    expect(res.status).toBe(200);
    expect(res.body.user.celular).toBe("+5521987654321");
  });

  it("clears celular with null", async () => {
    const res = await request(app)
      .patch("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ celular: null });

    expect(res.status).toBe(200);
    expect(res.body.user.celular).toBeUndefined();
  });
});
