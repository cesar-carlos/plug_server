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

    expect(html).toContain("Review &quot;&lt;danger&gt;&quot;");
    expect(html).toContain("&lt;b&gt;Approval&lt;/b&gt;");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain('action="/approve?next=&quot;bad&quot;"');
    expect(html).toContain('value="tok&quot;&gt;&lt;script&gt;"');
    expect(html).toContain("Alice &amp; Bob &quot;quoted&quot;");
    expect(html).not.toContain('<script>alert("x")</script>');
  });

  it("escapes tone and body text in the decision page", () => {
    const html = renderApprovalDecisionPage({
      title: "Rejected <item>",
      bodyText: 'Message with <script>alert("x")</script>',
      tone: "danger",
    });

    expect(html).toContain("Rejected &lt;item&gt;");
    expect(html).toContain("Message with &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain('class="status danger"');
  });
});
