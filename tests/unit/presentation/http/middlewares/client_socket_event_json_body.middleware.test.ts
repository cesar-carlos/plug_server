import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
vi.mock("../../../../../src/shared/config/env", () => ({
  env: { requestBodyLimit: 100, restSocketEventHttpJsonBodyLimit: 1000 },
}));
import { jsonBodyParserForRoute } from "../../../../../src/presentation/http/middlewares/client_socket_event_json_body.middleware";

const create = (): express.Express => {
  const app = express();
  app.use(jsonBodyParserForRoute);
  app.all("/api/v1/client/me/socket-events", (req, res) => res.status(202).json(req.body));
  app.all("/api/v1/client/me/socket-events/other", (_req, res) => res.sendStatus(202));
  return app;
};

it("should apply the same JSON limit to all route variants accepted by Express", async () => {
  for (const url of [
    "/api/v1/client/me/socket-events",
    "/api/v1/client/me/socket-events/",
    "/API/v1/CLIENT/me/SOCKET-EVENTS?x=1",
  ]) {
    const response = await request(create())
      .post(url)
      .send({ payload: "x".repeat(200) });
    expect(response.status).toBe(202);
    expect(response.body.payload).toHaveLength(200);
    expect(
      (
        await request(create())
          .post(url)
          .send({ payload: "x".repeat(1100) })
      ).status,
    ).toBe(413);
  }
});

it("should retain the default JSON limit for other methods and subpaths", async () => {
  expect(
    (
      await request(create())
        .put("/api/v1/client/me/socket-events")
        .send({ payload: "x".repeat(200) })
    ).status,
  ).toBe(413);
  expect(
    (
      await request(create())
        .post("/api/v1/client/me/socket-events/other")
        .send({ payload: "x".repeat(200) })
    ).status,
  ).toBe(413);
});
