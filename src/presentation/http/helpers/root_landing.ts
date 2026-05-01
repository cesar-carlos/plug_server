import { readFileSync } from "node:fs";
import path from "node:path";

import type { RootLandingLangConfig } from "../../../shared/config/env";

export type RootLandingLang = "pt" | "en";

/** Cache for HTML landing; `stale-while-revalidate` helps CDNs while `APP_NAME` is stable. */
export const ROOT_LANDING_HTML_CACHE_CONTROL =
  "public, max-age=600, stale-while-revalidate=86400";

export const SITE_WEBMANIFEST_CACHE_CONTROL =
  "public, max-age=3600, stale-while-revalidate=86400";

const INTERNAL_RELATIVE = path.join(".internal");

export const resolveRootLandingLang = (
  configured: RootLandingLangConfig,
  acceptLanguageHeader: string | undefined,
): RootLandingLang => {
  if (configured === "pt") {
    return "pt";
  }
  if (configured === "en") {
    return "en";
  }
  const raw = acceptLanguageHeader?.trim();
  if (!raw) {
    return "pt";
  }
  const first = raw.split(",")[0]?.trim().toLowerCase() ?? "";
  if (first.startsWith("en")) {
    return "en";
  }
  return "pt";
};

export type RootLandingTemplates = Readonly<{
  pt?: string;
  en?: string;
}>;

export const loadRootLandingTemplates = (assetsRoot: string): RootLandingTemplates => {
  const base = path.join(assetsRoot, INTERNAL_RELATIVE);
  const out: Partial<Record<RootLandingLang, string>> = {};
  for (const lang of ["pt", "en"] as const) {
    const file = lang === "pt" ? "root_landing.pt.html" : "root_landing.en.html";
    try {
      out[lang] = readFileSync(path.join(base, file), "utf8");
    } catch {
      /* missing locale file */
    }
  }
  return out;
};

export const pickRootLandingTemplate = (
  templates: RootLandingTemplates,
  lang: RootLandingLang,
): string | undefined =>
  (lang === "en" ? templates.en ?? templates.pt : templates.pt ?? templates.en) ?? undefined;

export const buildRootLandingFallbackHtml = (
  lang: RootLandingLang,
  appNameEscaped: string,
): string => {
  if (lang === "en") {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${appNameEscaped} · API</title>
<link rel="icon" href="/favicon.ico" type="image/x-icon"/>
<link rel="manifest" href="/site.webmanifest"/>
<link rel="apple-touch-icon" href="/assets/app_icons/plug_connect-blockchain-256px.png" sizes="256x256"/>
</head>
<body>
<main>
<h1>${appNameEscaped} · API</h1>
<p>Service is running. Use the links below.</p>
<ul>
<li><a href="/docs/">API documentation (Swagger)</a></li>
<li><a href="/api/v1/health/live">Health (live)</a></li>
</ul>
</main>
</body>
</html>`;
  }
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${appNameEscaped} · API</title>
<link rel="icon" href="/favicon.ico" type="image/x-icon"/>
<link rel="manifest" href="/site.webmanifest"/>
<link rel="apple-touch-icon" href="/assets/app_icons/plug_connect-blockchain-256px.png" sizes="256x256"/>
</head>
<body>
<main>
<h1>${appNameEscaped} · API</h1>
<p>Serviço em execução. Utilize as ligações abaixo.</p>
<ul>
<li><a href="/docs/">Documentação (Swagger)</a></li>
<li><a href="/api/v1/health/live">Health (live)</a></li>
</ul>
</main>
</body>
</html>`;
};

export const buildSiteWebManifest = (appName: string): Record<string, unknown> => {
  const shortName = appName.length > 12 ? `${appName.slice(0, 11)}…` : appName;
  return {
    name: appName,
    short_name: shortName,
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#1a1a2e",
    icons: [
      {
        src: "/assets/app_icons/plug_connect-blockchain-256px.png",
        sizes: "256x256",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/assets/app_icons/plug_connect-blockchain-512px.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
};
