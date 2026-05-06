import { escapeHtml, escapeHtmlAttr } from "./html_escape";

export interface ApprovalReviewPageInput {
  readonly title: string;
  readonly eyebrow: string;
  readonly description: string;
  readonly approveAction: string;
  readonly rejectAction: string;
  readonly token: string;
  readonly approveLabel: string;
  readonly rejectLabel: string;
  readonly reasonLabel: string;
  readonly summaryItems?: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
  }>;
  /** When false, approval/reject forms are hidden (e.g. invalid or expired link). */
  readonly showActionForms?: boolean;
  /** Shown when `showActionForms` is false; explains why the user cannot decide here. */
  readonly readOnlyMessage?: string;
  readonly lang?: string;
  /** Optional link shown at the bottom of the page (e.g. back to the app). */
  readonly homeUrl?: string;
  readonly homeLabel?: string;
  /** Placeholder for the optional rejection reason field. */
  readonly textareaPlaceholder?: string;
  readonly actionsAriaLabel?: string;
}

export interface ApprovalDecisionPageInput {
  readonly title: string;
  readonly bodyText: string;
  readonly tone: "success" | "danger" | "neutral";
  /** Defaults to "Decision recorded" / localized via caller. */
  readonly decisionEyebrow?: string;
  readonly lang?: string;
  readonly homeUrl?: string;
  readonly homeLabel?: string;
}

export interface ApprovalErrorPageInput {
  readonly title: string;
  readonly bodyText: string;
  readonly eyebrow: string;
  readonly detailsText?: string;
  readonly lang?: string;
  readonly homeUrl?: string;
  readonly homeLabel?: string;
}

type PageShellOptions = {
  readonly lang?: string;
  readonly homeUrl?: string;
  readonly homeLabel?: string;
  readonly includeFocusScript?: boolean;
};

const homeFooter = (options?: PageShellOptions): string => {
  if (!options?.homeUrl || !options.homeLabel) {
    return "";
  }
  return `
    <p class="home-footer">
      <a class="back-link" href="${escapeHtmlAttr(options.homeUrl)}">${escapeHtml(
        options.homeLabel,
      )}</a>
    </p>`;
};

const mainAriaLabel = (lang: string | undefined): string => {
  const l = (lang ?? "en").toLowerCase();
  return l.startsWith("pt") ? "Conteúdo principal" : "Main content";
};

const pageShell = (title: string, body: string, options?: PageShellOptions): string => {
  const safeTitle = escapeHtml(title);
  const lang = options?.lang ?? "en";
  const mAria = mainAriaLabel(lang);
  const focusScript =
    options?.includeFocusScript === false
      ? ""
      : `
<script defer src="/assets/approval-focus.js"></script>`;
  return `<!DOCTYPE html>
<html lang="${escapeHtmlAttr(lang)}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${safeTitle}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f8fb;
      --card: #ffffff;
      --text: #172033;
      --muted: #5f6b7a;
      --border: #d9e1ec;
      --primary: #0d6efd;
      --danger: #dc3545;
      --success: #198754;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111827;
        --card: #1f2937;
        --text: #f9fafb;
        --muted: #c7d2df;
        --border: #374151;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    #main-content {
      width: min(100%, 680px);
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: 0 18px 50px rgba(15, 23, 42, 0.12);
      padding: clamp(24px, 5vw, 40px);
    }
    .eyebrow {
      color: var(--muted);
      font-size: 0.82rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      margin: 0 0 8px;
      text-transform: uppercase;
    }
    h1 {
      font-size: clamp(1.7rem, 4vw, 2.35rem);
      line-height: 1.1;
      margin: 0 0 12px;
    }
    p { margin: 0 0 18px; }
    .muted { color: var(--muted); }
    .read-only-notice {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 16px;
      margin: 18px 0 0;
      background: rgba(13, 110, 253, 0.06);
    }
    dl {
      border: 1px solid var(--border);
      border-radius: 12px;
      margin: 22px 0;
      overflow: hidden;
    }
    .summary-row {
      display: grid;
      gap: 4px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
    }
    .summary-row:last-child { border-bottom: 0; }
    dt {
      color: var(--muted);
      font-size: 0.8rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .actions {
      display: grid;
      gap: 14px;
      margin-top: 24px;
    }
    form { margin: 0; }
    label {
      display: block;
      font-weight: 650;
      margin-bottom: 8px;
    }
    textarea {
      width: 100%;
      min-height: 96px;
      resize: vertical;
      border: 1px solid var(--border);
      border-radius: 12px;
      color: var(--text);
      background: transparent;
      font: inherit;
      margin-bottom: 12px;
      padding: 10px 12px;
    }
    button {
      width: 100%;
      border: 0;
      border-radius: 12px;
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-weight: 750;
      padding: 13px 18px;
    }
    .approve { background: var(--primary); }
    .reject { background: var(--danger); }
    .status {
      border-left: 5px solid var(--primary);
      padding-left: 16px;
    }
    .status.success { border-left-color: var(--success); }
    .status.danger { border-left-color: var(--danger); }
    .status.neutral { border-left-color: var(--border); }
    .home-footer {
      margin: 24px 0 0;
      padding-top: 18px;
      border-top: 1px solid var(--border);
    }
    .back-link {
      color: var(--primary);
      font-weight: 650;
      text-decoration: none;
    }
    .back-link:hover, .back-link:focus {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <main id="main-content" tabindex="-1" role="main" aria-label="${escapeHtmlAttr(mAria)}">
${body}
${homeFooter(options)}
  </main>
${focusScript}
</body>
</html>`;
};

export const renderApprovalReviewPage = (input: ApprovalReviewPageInput): string => {
  const showForms = input.showActionForms !== false;
  const lang = input.lang ?? "en";
  const actionsLabel = input.actionsAriaLabel ?? "Approval actions";
  const placeholder = input.textareaPlaceholder ?? "Optional note";
  const summary = input.summaryItems?.length
    ? `<dl>
${input.summaryItems
  .map(
    (item) => `      <div class="summary-row">
        <dt>${escapeHtml(item.label)}</dt>
        <dd>${escapeHtml(item.value)}</dd>
      </div>`,
  )
  .join("\n")}
    </dl>`
    : "";

  const readOnlyBlock =
    !showForms && typeof input.readOnlyMessage === "string" && input.readOnlyMessage.trim() !== ""
      ? `    <div class="read-only-notice" role="status" aria-live="polite">
      <p>${escapeHtml(input.readOnlyMessage)}</p>
    </div>
`
      : !showForms
        ? `    <div class="read-only-notice" role="status" aria-live="polite">
      <p class="muted">${escapeHtml("This request cannot be decided from this page.")}</p>
    </div>
`
        : "";

  const actionBlock = showForms
    ? `    <div class="actions" aria-label="${escapeHtmlAttr(actionsLabel)}">
      <form method="post" action="${escapeHtmlAttr(input.approveAction)}" data-decision="approve">
        <input type="hidden" name="token" value="${escapeHtmlAttr(input.token)}" autocomplete="off"/>
        <button type="submit" class="approve">${escapeHtml(input.approveLabel)}</button>
      </form>
      <form method="post" action="${escapeHtmlAttr(input.rejectAction)}" data-decision="reject">
        <input type="hidden" name="token" value="${escapeHtmlAttr(input.token)}" autocomplete="off"/>
        <label for="reason">${escapeHtml(input.reasonLabel)}</label>
        <textarea id="reason" name="reason" maxlength="500" placeholder="${escapeHtmlAttr(placeholder)}" autocomplete="off"></textarea>
        <button type="submit" class="reject">${escapeHtml(input.rejectLabel)}</button>
      </form>
    </div>`
    : readOnlyBlock;

  return pageShell(
    input.title,
    `    <p class="eyebrow">${escapeHtml(input.eyebrow)}</p>
    <h1>${escapeHtml(input.title)}</h1>
    <p class="muted">${escapeHtml(input.description)}</p>
${summary}
${actionBlock}`,
    {
      lang,
      ...(input.homeUrl !== undefined && input.homeLabel !== undefined
        ? { homeUrl: input.homeUrl, homeLabel: input.homeLabel }
        : {}),
    },
  );
};

export const renderApprovalDecisionPage = (input: ApprovalDecisionPageInput): string => {
  const lang = input.lang ?? "en";
  const eyebrow = input.decisionEyebrow ?? "Decision recorded";
  return pageShell(
    input.title,
    `    <section class="status ${escapeHtmlAttr(
      input.tone,
    )}" role="status" aria-live="polite" aria-atomic="true">
      <p class="eyebrow">${escapeHtml(eyebrow)}</p>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.bodyText)}</p>
    </section>`,
    {
      lang,
      ...(input.homeUrl !== undefined && input.homeLabel !== undefined
        ? { homeUrl: input.homeUrl, homeLabel: input.homeLabel }
        : {}),
    },
  );
};

export const renderApprovalErrorPage = (input: ApprovalErrorPageInput): string => {
  const lang = input.lang ?? "en";
  return pageShell(
    input.title,
    `    <section class="status danger" role="alert" aria-live="assertive" aria-atomic="true">
      <p class="eyebrow">${escapeHtml(input.eyebrow)}</p>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.bodyText)}</p>
      ${input.detailsText ? `<p class="muted">${escapeHtml(input.detailsText)}</p>` : ""}
    </section>`,
    {
      lang,
      ...(input.homeUrl !== undefined && input.homeLabel !== undefined
        ? { homeUrl: input.homeUrl, homeLabel: input.homeLabel }
        : {}),
    },
  );
};
