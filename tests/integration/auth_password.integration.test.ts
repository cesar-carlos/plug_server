import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { approveRegistrationByToken } from "./helpers/approve_registration";

const app = createApp();

describe("PATCH /api/v1/auth/password", () => {
  const email = `password-${Date.now()}@test.com`;
  const initialPassword = "Password1";
  const updatedPassword = "Password2";
  let accessToken = "";

  beforeAll(async () => {
    const registerResponse = await request(app).post("/api/v1/auth/register").send({
      email,
      password: initialPassword,
    });

    expect(registerResponse.status).toBe(201);
    await approveRegistrationByToken(app, registerResponse.body.approvalToken as string);
    const loginResponse = await request(app).post("/api/v1/auth/login").send({
      email,
      password: initialPassword,
    });
    expect(loginResponse.status).toBe(200);
    accessToken = loginResponse.body.accessToken as string;
  });

  it("should return 401 when access token is missing", async () => {
    const response = await request(app).patch("/api/v1/auth/password").send({
      currentPassword: initialPassword,
      newPassword: updatedPassword,
    });

    expect(response.status).toBe(401);
  });

  it("should return 401 when current password is incorrect", async () => {
    const response = await request(app)
      .patch("/api/v1/auth/password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        currentPassword: "WrongPassword1",
        newPassword: updatedPassword,
      });

    expect(response.status).toBe(401);
  });

  it("should change password and reject old credentials", async () => {
    const changeResponse = await request(app)
      .patch("/api/v1/auth/password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        currentPassword: initialPassword,
        newPassword: updatedPassword,
      });

    expect(changeResponse.status).toBe(204);

    const oldLogin = await request(app).post("/api/v1/auth/login").send({
      email,
      password: initialPassword,
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app).post("/api/v1/auth/login").send({
      email,
      password: updatedPassword,
    });
    expect(newLogin.status).toBe(200);
  });
});
