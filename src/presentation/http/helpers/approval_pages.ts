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
}

export interface ApprovalDecisionPageInput {
  readonly title: string;
  readonly bodyText: string;
  readonly tone: "success" | "danger" | "neutral";
}

const pageShell = (title: string, body: string): string => {
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
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
    main {
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
  </style>
</head>
<body>
  <main>
${body}
  </main>
</body>
</html>`;
};

export const renderApprovalReviewPage = (input: ApprovalReviewPageInput): string => {
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

  return pageShell(
    input.title,
    `    <p class="eyebrow">${escapeHtml(input.eyebrow)}</p>
    <h1>${escapeHtml(input.title)}</h1>
    <p class="muted">${escapeHtml(input.description)}</p>
${summary}
    <div class="actions" aria-label="Approval actions">
      <form method="post" action="${escapeHtmlAttr(input.approveAction)}">
        <input type="hidden" name="token" value="${escapeHtmlAttr(input.token)}"/>
        <button type="submit" class="approve">${escapeHtml(input.approveLabel)}</button>
      </form>
      <form method="post" action="${escapeHtmlAttr(input.rejectAction)}">
        <input type="hidden" name="token" value="${escapeHtmlAttr(input.token)}"/>
        <label for="reason">${escapeHtml(input.reasonLabel)}</label>
        <textarea id="reason" name="reason" maxlength="500" placeholder="Optional note"></textarea>
        <button type="submit" class="reject">${escapeHtml(input.rejectLabel)}</button>
      </form>
    </div>`,
  );
};

export const renderApprovalDecisionPage = (input: ApprovalDecisionPageInput): string =>
  pageShell(
    input.title,
    `    <section class="status ${escapeHtmlAttr(input.tone)}">
      <p class="eyebrow">Decision recorded</p>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.bodyText)}</p>
    </section>`,
  );
