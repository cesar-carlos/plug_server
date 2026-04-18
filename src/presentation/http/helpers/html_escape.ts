/**
 * Minimal HTML / attribute value escaping for the few server-rendered HTML
 * pages we expose (registration review/decision pages, password recovery
 * page). Centralized here so both `auth`, `client_auth` and `client_agents`
 * controllers share the exact same escape semantics.
 */

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const escapeHtmlAttr = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
