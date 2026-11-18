import { describe, expect, it } from "vitest";
import type { PlanOp } from "../../src/core/plan.js";
import {
  EXPIRY_WARN_DAYS,
  PR_COMMENT_MARKER,
  renderApplySummary,
  renderDetail,
  renderDriftReport,
  renderPrComment,
} from "../../src/output/index.js";
import { applyReport, checkReport, cleanReport, driftReport, op } from "./fixtures.js";

const count = (s: string, sub: string) => s.split(sub).length - 1;
const balanced = (s: string) => expect(count(s, "<details>")).toBe(count(s, "</details>"));

describe("renderPrComment", () => {
  it("starts with the marker and the heading, then the verdict and counts per provider", () => {
    const md = renderPrComment(checkReport());
    const lines = md.split("\n");
    expect(lines[0]).toBe(PR_COMMENT_MARKER);
    expect(lines[1]).toBe("## What happens when this is merged");
    expect(md).toContain("✅ **Checks passed.** Merging this applies the 7 change(s) below to the live accounts. 3 report-only item(s)");
    expect(md).toContain("| DigitalOcean | 1 | 0 | 0 | 2 |");
    expect(md).toContain("| Cloudflare | 2 | 2 | 1 | 0 |");
    expect(md).toContain("| OneUptime | 0 | 0 | 0 | 1 |");
    expect(md).toContain("| GitHub | 0 | 1 | 0 | 0 |");
    expect(md).toContain("| **total** | **3** | **3** | **1** | **3** |");
    expect(md).toContain("39 other object(s) already match");
    expect(md).toContain("(infra commit `0123456789ab`)");
    balanced(md);
  });

  it("groups changes by droplet, shared objects last, with a compact before → after", () => {
    const md = renderPrComment(checkReport());
    const iNew = md.indexOf("#### `new.example.com` (2)");
    const iShop = md.indexOf("#### `shop.example.com` (2)");
    const iShared = md.indexOf("#### Shared, not tied to one droplet (3)");
    expect(iNew).toBeGreaterThan(0);
    expect(iShop).toBeGreaterThan(iNew);
    expect(iShared).toBeGreaterThan(iShop);
    expect(md).toContain('- **update** Cloudflare dns-record `A vpc-shop.example.com`: private IP changed<br>`content: "10.0.0.9" → "10.0.0.11"`');
    expect(md).toContain('`→ {"content":(known after create)}`');
    expect(md).toContain('`hosts: 3 → 4; added: (none) → ["new.example.com"]`');
  });

  it("puts report-only ops in their own collapsed sections, never under the changes", () => {
    const md = renderPrComment(checkReport());
    const fw = md.indexOf("<details><summary>Firewall rules: report only, not enforced until Phase 5 (1)</summary>");
    expect(fw).toBeGreaterThan(md.indexOf("### Changes the apply will make (7)"));
    expect(md.indexOf("fw-db inbound tcp/5432")).toBeGreaterThan(fw);
    expect(md).toContain("<details><summary>Frozen droplets: changes shown, never applied (1)</summary>");
    expect(md).toContain("<details><summary>Other report-only items, never applied (1)</summary>");
    const changes = md.slice(md.indexOf("### Changes the apply will make"), fw);
    expect(changes).not.toContain("data.example.com");
    expect(changes).not.toContain("old.example.com");
  });

  it("lists droplets with no file", () => {
    expect(renderPrComment(checkReport())).toContain("- `build-box` (nyc1, id 77)");
  });

  it("shows errors first, with file:line and path, and failed stages", () => {
    const r = checkReport();
    r.diagnostics.push({ level: "error", code: "schema", file: "droplets/bad.example.com.yaml", line: 3, path: "web.origin", message: "must be a URL" });
    r.stages.push({ stage: "observe oneuptime", status: "failed", error: "ApiError: oneuptime GET /monitor: HTTP 503" });
    r.stages.push({ stage: "plan firewall", status: "not-implemented", error: "firewall.diff is not implemented yet" });
    const md = renderPrComment(r);
    expect(md).toContain("❌ **Checks failed.**");
    expect(md).toContain("the apply runs only when the plan has no errors");
    const errs = md.indexOf("### ❌ Errors (3)");
    expect(errs).toBeGreaterThan(0);
    expect(errs).toBeLessThan(md.indexOf("### ⚠️ Warnings"));
    expect(errs).toBeLessThan(md.indexOf("### Changes the apply will make"));
    expect(md).toContain("- `droplets/bad.example.com.yaml:3` `web.origin`: must be a URL");
    expect(md).toContain("- observe oneuptime: **failed**: ApiError: oneuptime GET /monitor: HTTP 503");
    expect(md).toContain("- plan firewall: **not-implemented**");
  });

  it("says when merging changes nothing", () => {
    const md = renderPrComment(cleanReport("check"));
    expect(md).toContain("Merging this changes nothing in the live accounts");
    expect(md).toContain("No changes. 13 object(s) already match the droplet files.");
    expect(md).not.toContain("<details>");
  });

  it("never renders op ids (provider ids, the ssh config text)", () => {
    for (const md of [renderPrComment(checkReport()), renderApplySummary(applyReport()), renderDriftReport(driftReport())]) {
      expect(md).not.toContain("SECRET-CONFIG-TEXT");
      expect(md).not.toContain("README-TEXT");
    }
  });

  it("escapes HTML and @mentions from the files", () => {
    const r = checkReport();
    r.plans[1]!.ops.push(op({ kind: "access-app", key: "x`y.example.com", reason: "</details><img src=x> ping @someone", droplet: "shop.example.com" }));
    const md = renderPrComment(r);
    expect(md).toContain("&lt;/details&gt;&lt;img src=x&gt; ping @​someone");
    expect(md).toContain("`x'y.example.com`");
    balanced(md);
  });

  it("puts a long before → after in a collapsed block", () => {
    const r = checkReport();
    r.plans[1]!.ops.push(op({ kind: "access-app", key: "big.example.com", reason: "big", after: { include: Array.from({ length: 30 }, (_, i) => `user${i}@example.com`) } }));
    const md = renderPrComment(r);
    expect(md).toContain("  <details><summary>before → after</summary>");
    balanced(md);
  });

  it("stays under GitHub's limit, cutting detail but never the counts or errors", () => {
    const r = checkReport();
    const many: PlanOp[] = Array.from({ length: 3000 }, (_, i) =>
      op({ kind: "dns-record", key: `A vpc-host${i}.example.com`, reason: "x".repeat(60), after: { content: `10.0.${Math.floor(i / 250)}.${i % 250}` }, droplet: `host${i}.example.com` }),
    );
    r.plans[1]!.ops.push(...many);
    for (let i = 0; i < 40; i++) r.diagnostics.push({ level: "error", code: "e", file: `droplets/e${i}.example.com.yaml`, message: `error number ${i} ${"y".repeat(200)}` });
    const md = renderPrComment(r);
    expect(md.length).toBeLessThan(65_536);
    expect(md).toContain("| Cloudflare | 3002 | 2 | 1 | 0 |");
    for (let i = 0; i < 40; i++) expect(md).toContain(`error number ${i} `);
    expect(md).toMatch(/> \*\*Detail truncated:\*\* \d+ more item\(s\) not shown/);
    balanced(md);
  });
});

describe("renderApplySummary", () => {
  it("shows what failed (with the error), what was applied and what was skipped", () => {
    const md = renderApplySummary(applyReport());
    expect(md.split("\n")[0]).toBe("## infra apply: ❌ partly applied, with failures");
    expect(md).toContain("Applied 5 · failed 1 · skipped 1 · report only 3");
    expect(md).toContain("### ❌ Errors (1)");
    expect(md).toContain("- **delete** Cloudflare access-app `gone.example.com`: cloudflare DELETE /accounts/x/access/apps/y: HTTP 500");
    expect(md).toContain("### Applied (5)");
    expect(md).toContain("<details><summary>Skipped: waiting for a droplet that isn't up yet (1)</summary>");
    expect(md).toContain("<details><summary>Firewall rules: report only, not enforced until Phase 5 (1)</summary>");
    expect(md.indexOf("### ❌ Errors")).toBeLessThan(md.indexOf("### Applied"));
    balanced(md);
  });

  it("says plainly when apply was blocked, and what it would have done", () => {
    const r = checkReport({ mode: "apply" });
    r.diagnostics.push({ level: "error", code: "x", message: "something is wrong" });
    r.stages.push({ stage: "apply", status: "skipped", error: "the plan has errors or failed stages; nothing applied" });
    const md = renderApplySummary(r);
    expect(md).toContain("## infra apply: ⛔ blocked: nothing was applied");
    expect(md).toContain("**Nothing was applied:** the plan has errors or failed stages; nothing applied.");
    expect(md).toContain("### Planned, not applied (7)");
  });

  it("says when there was nothing to change", () => {
    expect(renderApplySummary(cleanReport("apply"))).toMatch(/^## infra apply: ℹ️ nothing to change\n/);
  });
});

describe("renderDriftReport", () => {
  it("lists droplets with no file, hand-made changes and the token expiry warning", () => {
    const md = renderDriftReport(driftReport());
    expect(md.split("\n")[0]).toBe("## Daily drift report: ⚠️ drift found");
    expect(md).toContain("2026-11-19 (infra commit `0123456789ab`). This report changes nothing.");
    expect(md).toContain("Hand-made changes: 7 · Droplets with no file: 1 · Report-only differences: 3");
    expect(md).toContain(`- ⚠️ \`INFRA_GH_TOKEN\` expires on 2026-12-01 (in 12 days). Renew it before then (warning starts ${EXPIRY_WARN_DAYS} days ahead).`);
    expect(md).toContain("### Droplets with no file (1)");
    expect(md).toContain("- `build-box` (nyc1, id 77)");
    expect(md).toContain("### Hand-made changes (7)");
    expect(md).toContain("would do to put it back");
  });

  it.each([
    ["2026-12-25T00:00:00.000Z", "⚠️", "expires on 2026-12-25 (in 29 days)"],
    ["2026-12-30T00:00:00.000Z", "✅", "expires on 2026-12-30 (in 34 days)"],
    ["2026-11-01T00:00:00.000Z", "❌", "expired on 2026-11-01"],
  ])("rates a token expiring %s as %s", (expiresAt, icon, text) => {
    const r = cleanReport("drift");
    r.startedAt = "2026-11-25T12:00:00.000Z";
    r.credentials = [{ name: "INFRA_GH_TOKEN", expiresAt }];
    expect(renderDriftReport(r)).toContain(`- ${icon} \`INFRA_GH_TOKEN\` ${text}.`);
  });

  it("says when the expiry is unknown", () => {
    const r = cleanReport("drift");
    r.credentials = [{ name: "INFRA_GH_TOKEN" }];
    expect(renderDriftReport(r)).toContain("- ❔ `INFRA_GH_TOKEN` expiry unknown.");
  });

  it("reports no drift when everything matches", () => {
    const md = renderDriftReport(cleanReport("drift"));
    expect(md.split("\n")[0]).toBe("## Daily drift report: ✅ no drift");
    expect(md).not.toContain("### Hand-made changes");
  });

  it("depends only on the report, not on the clock", () => {
    expect(renderDriftReport(driftReport())).toBe(renderDriftReport(driftReport()));
  });
});

describe("renderDetail", () => {
  it("dispatches by mode", () => {
    expect(renderDetail(checkReport()).startsWith(PR_COMMENT_MARKER)).toBe(true);
    expect(renderDetail(applyReport()).startsWith("## infra apply")).toBe(true);
    expect(renderDetail(driftReport()).startsWith("## Daily drift report")).toBe(true);
    expect(renderDetail(cleanReport("validate")).startsWith("# infra validate")).toBe(true);
  });
});
