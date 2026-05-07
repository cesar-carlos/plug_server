import { describe, expect, it } from "vitest";

import {
  renderApprovalDecisionPage,
  renderApprovalReviewPage,
} from "../../../../../src/presentation/http/helpers/approval_pages";

describe("approval_pages", () => {
  it("escapes dynamic content in the review page", () => {
    const html = renderApprovalReviewPage({
      title: 'Review "<danger>"',
      eyebrow: "<b>Approval</b>",
      description: 'Approve only if expected <script>alert("x")</script>',
      approveAction: '/approve?next="bad"',
      rejectAction: "/reject?<bad>",
      token: 'tok"><script>',
      approveLabel: "Approve <ok>",
      rejectLabel: "Reject <no>",
      reasonLabel: "Reason <optional>",
      summaryItems: [{ label: "Client <name>", value: 'Alice & Bob "quoted"' }],
    });

    expect(html).toContain('lang="en"');
    expect(html).toContain("/assets/approval-focus.js");
    expect(html).toContain("Review &quot;&lt;danger&gt;&quot;");
    expect(html).toContain("&lt;b&gt;Approval&lt;/b&gt;");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain('action="/approve?next=&quot;bad&quot;"');
    expect(html).toContain('value="tok&quot;&gt;&lt;script&gt;"');
    expect(html).toContain("Alice &amp; Bob &quot;quoted&quot;");
    expect(html).not.toContain('<script>alert("x")</script>');
  });

  it("hides decision forms in read-only mode and shows a notice instead", () => {
    const html = renderApprovalReviewPage({
      title: "No action",
      eyebrow: "Test",
      description: "Desc",
      approveAction: "https://x/approve",
      rejectAction: "https://x/reject",
      token: "x".repeat(32),
      approveLabel: "Ok",
      rejectLabel: "No",
      reasonLabel: "R",
      showActionForms: false,
      readOnlyMessage: "Link bad <script>x</script>",
    });
    expect(html).not.toContain('method="post"');
    expect(html).toContain("Link bad &lt;script&gt;x&lt;/script&gt;");
  });

  it("escapes tone and body text in the decision page", () => {
    const html = renderApprovalDecisionPage({
      title: "Rejected <item>",
      bodyText: 'Message with <script>alert("x")</script>',
      tone: "danger",
    });

    expect(html).toContain("Rejected &lt;item&gt;");
    expect(html).toContain("/assets/approval-focus.js");
    expect(html).toContain("Message with &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain('class="status danger"');
  });

  it("includes optional home link on the decision page", () => {
    const html = renderApprovalDecisionPage({
      title: "Ok",
      bodyText: "Done",
      tone: "success",
      homeUrl: "https://ex/a/",
      homeLabel: "Home <a>",
    });
    expect(html).toContain('href="https://ex/a/"');
    expect(html).toContain("Home &lt;a&gt;");
  });
});
