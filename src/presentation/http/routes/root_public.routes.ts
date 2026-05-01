import type { Express, NextFunction, Request, Response } from "express";
import path from "node:path";

import { escapeHtml } from "../helpers/html_escape";
import {
  buildRootLandingFallbackHtml,
  buildSiteWebManifest,
  loadRootLandingTemplates,
  pickRootLandingTemplate,
  resolveRootLandingLang,
  ROOT_LANDING_HTML_CACHE_CONTROL,
  SITE_WEBMANIFEST_CACHE_CONTROL,
} from "../helpers/root_landing";
import { env } from "../../../shared/config/env";

/**
 * Public root responses: favicon, landing HTML, Web App Manifest. Kept out of
 * `createApp` so asset/template loading stays in one place.
 */
export const registerRootPublicRoutes = (app: Express, assetsRoot: string): void => {
  const rootLandingTemplates = loadRootLandingTemplates(assetsRoot);

  app.get("/favicon.ico", (_request: Request, response: Response, next: NextFunction) => {
    response.sendFile(path.join(assetsRoot, "icons", "favicon.ico"), (err) => {
      if (err) {
        next();
      }
    });
  });

  app.get("/site.webmanifest", (_request: Request, response: Response) => {
    response.setHeader("Cache-Control", SITE_WEBMANIFEST_CACHE_CONTROL);
    response.type("application/manifest+json");
    response.send(JSON.stringify(buildSiteWebManifest(env.appName)));
  });

  app.get("/", (request: Request, response: Response) => {
    const lang = resolveRootLandingLang(env.rootLandingLang, request.get("accept-language"));
    const template = pickRootLandingTemplate(rootLandingTemplates, lang);
    const name = escapeHtml(env.appName);
    const html = template
      ? template.replaceAll("{{APP_NAME}}", name)
      : buildRootLandingFallbackHtml(lang, name);
    response.setHeader("Cache-Control", ROOT_LANDING_HTML_CACHE_CONTROL);
    response.type("html").send(html);
  });
};
