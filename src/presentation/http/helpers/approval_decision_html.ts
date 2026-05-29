import { env } from "../../../shared/config/env";
import { approvalDecisionEyebrow, approvalHomeLabel } from "./approval_registration_i18n";
import type { negotiateApprovalHtmlLang } from "./approval_page_locale";
import { renderApprovalDecisionPage } from "./approval_pages";

type ApprovalLang = ReturnType<typeof negotiateApprovalHtmlLang>;

/**
 * Resolves the "home" link shown on approval decision/review pages from the
 * configured `APP_BASE_URL` (trailing slashes stripped). Shared by the user,
 * client, and client-access approval controllers.
 */
export const approvalHome = (lang: ApprovalLang): { homeUrl: string; homeLabel: string } => {
  const homeUrl = env.appBaseUrl.replace(/\/+$/, "");
  return { homeUrl, homeLabel: approvalHomeLabel(lang) };
};

/**
 * Renders the localized HTML confirmation page shown after an approve/reject
 * decision. Centralizes the page composition that was duplicated across the
 * auth, client-auth, and client-access controllers.
 */
export const renderApprovalDecisionHtml = (
  lang: ApprovalLang,
  title: string,
  bodyText: string,
  tone: "success" | "danger" | "neutral",
): string => {
  const { homeUrl, homeLabel } = approvalHome(lang);
  return renderApprovalDecisionPage({
    title,
    bodyText,
    tone,
    lang,
    decisionEyebrow: approvalDecisionEyebrow(lang),
    homeUrl,
    homeLabel,
  });
};
