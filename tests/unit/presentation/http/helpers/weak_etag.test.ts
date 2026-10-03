import express from "express";
import compression from "compression";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  buildWeakETag,
  sendIfNoneMatch,
  sendJsonWithWeakETag,
} from "../../../../../src/presentation/http/helpers/weak_etag";

const payload = { text: "ação 漢字 <&>".repeat(500), omitted: undefined, nested: { value: 2 } };
const create = (custom?: { readonly key: string; readonly value: unknown }): express.Express => {
  const app = express();
  app.set("etag", false);
  if (custom) app.set(custom.key, custom.value);
  app.use(
    compression({
      filter: (req, res) =>
        req.headers["x-no-compression"] ? false : compression.filter(req, res),
    }),
  );
  app.use((req, res, next) => {
    if (req.headers.authorization !== "test") {
      res.status(403).json({ error: "denied" });
      return;
    }
    next();
  });
  app.get("/old", (req, res) => {
    if (!sendIfNoneMatch(req, res, buildWeakETag(payload))) res.status(200).json(payload);
  });
  app.get("/new", (req, res) => sendJsonWithWeakETag(req, res, payload));
  return app;
};

describe("JSON ETag serialization compatibility", () => {
  for (const custom of [
    undefined,
    { key: "json spaces", value: 2 },
    { key: "json escape", value: true },
    {
      key: "json replacer",
      value: (key: string, value: unknown) => (key === "nested" ? undefined : value),
    },
  ]) {
    it(`preserves bytes and headers for ${custom?.key ?? "default settings"}, gzip, opt-out and HEAD`, async () => {
      const app = create(custom);
      for (const compress of [false, true]) {
        for (const verb of ["get", "head"] as const) {
          const call = (path: string): request.Test =>
            request(app)
              [verb](path)
              .set("Authorization", "test")
              .set("Accept-Encoding", "gzip")
              .set("x-no-compression", compress ? "" : "1");
          const before = await call("/old"),
            after = await call("/new");
          expect(after.status).toBe(before.status);
          expect(after.text).toBe(before.text);
          for (const key of ["etag", "content-type", "content-length", "content-encoding", "vary"])
            expect(after.headers[key], key).toEqual(before.headers[key]);
        }
      }
      for (const header of [
        buildWeakETag(payload),
        'W/"different"',
        `W/"different", ${buildWeakETag(payload)}`,
        "*",
      ]) {
        const before = await request(app)
          .get("/old")
          .set("Authorization", "test")
          .set("If-None-Match", header);
        const after = await request(app)
          .get("/new")
          .set("Authorization", "test")
          .set("If-None-Match", header);
        expect(after.status).toBe(before.status);
        expect(after.text).toBe(before.text);
        expect(after.headers.etag).toEqual(before.headers.etag);
      }
      expect(
        (await request(app).get("/new").set("If-None-Match", buildWeakETag(payload))).status,
      ).toBe(403);
    });
  }
});
