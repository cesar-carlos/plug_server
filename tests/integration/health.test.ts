import request from "supertest";
import { describe, it, expect } from "vitest";

import { createApp } from "../../src/app";
import { User } from "../../src/domain/entities/user.entity";
import { getTestRepositoryAccess } from "../../src/shared/di/container";
import { approveRegistrationByToken } from "./helpers/approve_registration";

const app = createApp();
const repositories = getTestRepositoryAccess();

describe("GET /api/v1/health", () => {
  it("should return 200 for liveness endpoint", async () => {
    const response = await request(app).get("/api/v1/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      mode: "live",
    });
  });

  it("should return 200 for readiness endpoint", async () => {
    const response = await request(app).get("/api/v1/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      mode: "ready",
      checks: {
        envLoaded: true,
        database: true,
        swaggerEnabled: expect.any(Boolean),
      },
    });
  });

  it("should return 200 with health status", async () => {
    const response = await request(app).get("/api/v1/health");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      service: expect.any(String),
      environment: expect.any(String),
      timestamp: expect.any(String),
      uptimeInSeconds: expect.any(Number),
      checks: {
        envLoaded: true,
        database: true,
        swaggerEnabled: expect.any(Boolean),
      },
    });
  });

  it("should include x-request-id header in response", async () => {
    const response = await request(app).get("/api/v1/health");

    expect(response.headers["x-request-id"]).toBeDefined();
    expect(typeof response.headers["x-request-id"]).toBe("string");
  });

  it("should echo the x-request-id header when provided", async () => {
    const customId = "test-request-id-123";

    const response = await request(app).get("/api/v1/health").set("x-request-id", customId);

    expect(response.headers["x-request-id"]).toBe(customId);
    expect(response.body.requestId).toBe(customId);
  });

  it("should return 404 for unknown routes", async () => {
    const response = await request(app).get("/api/v1/unknown-route");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      message: "Route not found",
      code: "ROUTE_NOT_FOUND",
    });
  });

  it("should require auth to access metrics", async () => {
    const response = await request(app).get("/metrics");
    expect(response.status).toBe(401);
  });

  it("should reject /metrics for non-admin authenticated user", async () => {
    const userEmail = `metrics-user-${Date.now()}@test.com`;
    const registerResponse = await request(app).post("/api/v1/auth/register").send({
      email: userEmail,
      password: "MetricsUser1",
    });
    expect(registerResponse.status).toBe(201);
    await approveRegistrationByToken(app, registerResponse.body.approvalToken as string);
    const loginResponse = await request(app).post("/api/v1/auth/login").send({
      email: userEmail,
      password: "MetricsUser1",
    });
    expect(loginResponse.status).toBe(200);
    const userToken = loginResponse.body.accessToken as string;

    const response = await request(app).get("/metrics").set("Authorization", `Bearer ${userToken}`);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN");
  });

  it("should expose metrics in prometheus text format", async () => {
    const metricsEmail = `metrics-${Date.now()}@test.com`;
    const registerResponse = await request(app).post("/api/v1/auth/register").send({
      email: metricsEmail,
      password: "MetricsTest1",
    });
    expect(registerResponse.status).toBe(201);
    await approveRegistrationByToken(app, registerResponse.body.approvalToken as string);

    // Promote to admin so the role guard on `/metrics` allows the scrape.
    const userId = registerResponse.body.user.id as string;
    const currentUser = await repositories.user.findById(userId);
    expect(currentUser).not.toBeNull();
    await repositories.user.save(
      User.create({
        id: userId,
        email: metricsEmail,
        passwordHash: currentUser!.passwordHash,
        role: "admin",
        status: "active",
        createdAt: currentUser!.createdAt,
      }),
    );

    const loginResponse = await request(app).post("/api/v1/auth/login").send({
      email: metricsEmail,
      password: "MetricsTest1",
    });
    expect(loginResponse.status).toBe(200);
    const accessToken = loginResponse.body.accessToken as string;

    const response = await request(app)
      .get("/metrics")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.text).toContain("plug_socket_relay_requests_accepted_total");
    expect(response.text).toContain("plug_socket_relay_rest_pending_rejected_total");
    expect(response.text).toContain("plug_socket_relay_rpc_frame_decode_failed_total");
    expect(response.text).toContain(
      "plug_rest_sql_stream_materialize_active_stream_limit_exceeded_total",
    );
    expect(response.text).toContain("plug_socket_relay_rest_pending_requests");
    expect(response.text).toContain("plug_socket_relay_rate_limit_request_rejected_total");
    expect(response.text).toContain("plug_socket_consumers_guard_db_avg_ms");
    expect(response.text).toContain("plug_socket_consumers_profile_push_batches_total");
    expect(response.text).toContain("plug_socket_audit_prune_runs_total");
    expect(response.text).toContain("plug_socket_audit_writes_dropped_overflow_total");
    expect(response.text).toContain("plug_agent_profile_maintenance_prune_runs_total");
    expect(response.text).toContain("plug_client_agent_access_expiry_runs_total");
    expect(response.text).toContain("plug_client_me_agents_list_responses_total");
    expect(response.text).toContain("plug_client_me_agents_detail_responses_total");
    expect(response.text).toContain("plug_client_agent_access_public_decision_started_total");
    expect(response.text).toContain("plug_client_agent_access_public_decision_outcomes_total");
    expect(response.text).toContain("plug_client_agent_access_public_decision_latency_avg_ms");
    expect(response.text).toContain("plug_registration_approved_total");
    expect(response.text).toContain("plug_registration_rejected_total");
    expect(response.text).toContain("plug_registration_token_expired_total");
    expect(response.text).toContain("plug_rest_http_rate_limit_agents_self_profile_rejected_total");
    expect(response.text).toContain("plug_rest_http_rate_limit_client_thumbnail_rejected_total");
    expect(response.text).toContain(
      "plug_rest_http_rate_limit_client_password_recovery_request_rejected_total",
    );
    expect(response.text).toContain("plug_rest_http_rate_limit_redis_connection_events_total");
    expect(response.text).toContain("plug_rest_http_rate_limit_redis_circuit_open");
    expect(response.text).toContain("plug_socket_agents_capability_profiles_total");
    expect(response.text).toContain("plug_socket_agents_health_responses_total");
    expect(response.text).toContain("plug_socket_agents_health_last_sql_queue_avg_wait_time_ms");
    expect(response.text).toContain("plug_socket_agents_health_last_query_count");
    expect(response.text).toContain("plug_socket_agents_health_last_query_success_rate");
    expect(response.text).toContain("plug_socket_agents_health_last_p95_latency_ms");
  });
});
