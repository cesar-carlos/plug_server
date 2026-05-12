import type { Request } from "express";

/**
 * Picks `pt-BR` vs `en` for HTML approval pages from `Accept-Language`.
 * Default is English when no preference matches.
 */
export const negotiateApprovalHtmlLang = (request: Request): "pt-BR" | "en" => {
  const header = request.get("Accept-Language");
  if (header === undefined || header.trim() === "") {
    return "en";
  }
  for (const part of header.split(",")) {
    const tag = part.split(";")[0]?.trim().toLowerCase() ?? "";
    if (tag.length === 0) {
      continue;
    }
    if (tag.startsWith("pt")) {
      return "pt-BR";
    }
    if (tag.startsWith("en")) {
      return "en";
    }
  }
  return "en";
};
