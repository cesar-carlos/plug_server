import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAdminUser } from "./helpers/seed_agent";

const app = createApp();

describe("Admin user status API", () => {
  let adminToken = "";
  let userId = "";
  let userToken = "";

  beforeAll(async () => {
    const admin = await seedAdminUser(app, {
      email: `adm-block-${Date.now()}@test.com`,
      password: "Admin1234",
    });
    adminToken = admin.accessToken;

    const email = `blocked-user-${Date.now()}@test.com`;
    const reg = await request(app).post("/api/v1/auth/register").send({ email, password: "User1234" });
    await approveRegistrationByToken(app, reg.body.approvalToken as string);
    userId = reg.body.user.id as string;
    const login = await request(app).post("/api/v1/auth/login").send({ email, password: "User1234" });
    userToken = login.body.accessToken as string;
  });

  it("PATCH /api/v1/admin/users/:id/status blocks user; /me returns 403", async () => {
    const patch = await request(app)
      .patch(`/api/v1/admin/users/${userId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "blocked" });

    expect(patch.status).toBe(200);
    expect(patch.body.user.status).toBe("blocked");

    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${userToken}`);

    expect(me.status).toBe(403);
  });

  it("unblocks user and /me works again", async () => {
    const patch = await request(app)
      .patch(`/api/v1/admin/users/${userId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "active" });

    expect(patch.status).toBe(200);
    expect(patch.body.user.status).toBe("active");

    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${userToken}`);

    expect(me.status).toBe(200);
    expect(me.body.user.status).toBe("active");
  });

  it("returns 403 for non-admin", async () => {
    const res = await request(app)
      .patch(`/api/v1/admin/users/${userId}/status`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ status: "blocked" });

    expect(res.status).toBe(403);
  });
});
