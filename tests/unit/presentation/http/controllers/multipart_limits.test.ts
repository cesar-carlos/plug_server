import express from "express";
import request from "supertest";
import { expect, it } from "vitest";
import { env } from "../../../../../src/shared/config/env";
import {
  clientSocketEventUpload,
  wrapClientSocketEventMulterErrors,
} from "../../../../../src/presentation/http/controllers/client_socket_events.controller";
import {
  clientThumbnailUpload,
  wrapMulterErrors,
} from "../../../../../src/presentation/http/controllers/client_profile.controller";
import { errorMiddleware } from "../../../../../src/presentation/http/middlewares/error.middleware";

const create = (): express.Express => {
  const app = express();
  app.post(
    "/event",
    wrapClientSocketEventMulterErrors(clientSocketEventUpload.array("files")),
    (_req, res) => res.sendStatus(202),
  );
  app.post("/thumbnail", wrapMulterErrors(clientThumbnailUpload.single("thumbnail")), (_req, res) =>
    res.sendStatus(200),
  );
  app.use(errorMiddleware);
  return app;
};

it("should reject extra and repeated multipart fields before accepting an event", async () => {
  for (const extra of ["unused", "event"]) {
    const response = await request(create()).post("/event").field("event", "{}").field(extra, "x");
    expect(response.status).toBe(413);
    expect(response.body.code).toBe("PAYLOAD_TOO_LARGE");
  }
});

it("should reject text fields on thumbnail uploads", async () => {
  const response = await request(create())
    .post("/thumbnail")
    .field("unused", "x")
    .attach("thumbnail", Buffer.from("image"), "image.png");
  expect(response.status).toBe(400);
});

it("should accept the documented maximum number of event parts and a thumbnail without text fields", async () => {
  for (const fileFirst of [false, true]) {
    let upload = request(create()).post("/event");
    if (!fileFirst) upload = upload.field("event", "{}");
    for (let i = 0; i < env.restSocketEventMaxFiles; i += 1)
      upload = upload.attach("files", Buffer.from("file"), `${i}.txt`);
    if (fileFirst) upload = upload.field("event", "{}");
    expect((await upload).status).toBe(202);
  }
  expect(
    (
      await request(create())
        .post("/thumbnail")
        .attach("thumbnail", Buffer.from("image"), "image.png")
    ).status,
  ).toBe(200);
});
