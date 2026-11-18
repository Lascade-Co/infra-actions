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
import { freezeOps } from "../../src/engine.js";
import { applyReport, checkReport, cleanReport, driftReport, op, OPS, stoppedReport } from "./fixtures.js";

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
    const fw = md.indexOf("<details><summary>Firewall rules: report only, not enforced until Phase 5 (1 on 1 droplet(s))</summary>");
    expect(fw).toBeGreaterThan(md.indexOf("### Changes the apply will make (7)"));
    expect(md.indexOf("fw-db inbound tcp/5432")).toBeGreaterThan(fw);
    expect(md).toContain("<details><summary>Frozen droplets: changes shown, never applied (1)</summary>");
    expect(md).toContain("<details><summary>Other report-only items, never applied (1)</summary>");
    const changes = md.slice(md.indexOf("### Changes the apply will make"), fw);
    expect(changes).not.toContain("data.example.com");
    expect(changes).not.toContain("old.example.com");
  });

  it("groups the firewall report per droplet, each collapsed with its counts", () => {
    const fwOp = (droplet: string, key: string, before: PlanOp["before"], after: PlanOp["after"]): PlanOp =>
      op({ provider: "digitalocean", module: "firewall", kind: "firewall-rule", key, action: "report", before, after, reason: `rule ${key}`, droplet });
    const ops = [
      fwOp("db.example.com", "db.example.com inbound tcp/5432 10.0.0.11", null, { ports: "5432" }),
      fwOp("db.example.com", "fw-wide inbound tcp/0-65535 0.0.0.0/0 on db.example.com", { ports: "0-65535" }, null),
      fwOp("shop.example.com", "fw-wide inbound tcp/22 0.0.0.0/0 on shop.example.com", { ports: "22" }, [{ ports: "22" }]),
      fwOp("db.example.com", "fw-web inbound tcp/80 0.0.0.0/0 on db.example.com", { ports: "80" }, null),
    ];
    const r = checkReport();
    r.plans = r.plans.map((p) => (p.module === "firewall" ? { ...p, ops } : p));
    const md = renderPrComment(r);
    const outer = md.indexOf("<details><summary>Firewall rules: report only, not enforced until Phase 5 (4 on 2 droplet(s))</summary>");
    const db = md.indexOf("<details><summary>`db.example.com`: 1 to allow, 2 to remove</summary>");
    const shop = md.indexOf("<details><summary>`shop.example.com`: 1 to narrow</summary>");
    expect(outer).toBeGreaterThan(-1);
    expect(db).toBeGreaterThan(outer);
    expect(shop).toBeGreaterThan(db);
    // Each droplet's rules sit inside its own block.
    expect(md.indexOf("fw-web inbound tcp/80")).toBeGreaterThan(db);
    expect(md.indexOf("fw-web inbound tcp/80")).toBeLessThan(shop);
    balanced(md);
  });

  it("shows the Cloudflare warnings people act on under their own headings, never cut", () => {
    const warn = (code: string, message: string, droplet: string) => ({ level: "warning" as const, code, message, droplet });
    const r = checkReport();
    r.plans = r.plans.map((p) =>
      p.module === "cloudflare"
        ? {
            ...p,
            diagnostics: [
              ...p.diagnostics,
              warn("cloudflare-awaiting-cutover", "shop.example.com: awaiting cutover (an A record not managed by the tool still holds the name)", "shop.example.com"),
              warn("cloudflare-skipped", "db.example.com: no private IPv4 yet", "db.example.com"),
              warn("cloudflare-conflict", "tools.example.net: another droplet has the same name", "tools.example.net"),
              warn("cloudflare-route-not-built", "ch.example.com: 5000/udp: UDP goes through the client's private-network route", "db.example.com"),
            ],
          }
        : p,
    );
    // Lots of other detail, so the comment has to be truncated.
    const filler = Array.from({ length: 400 }, (_, i) => op({ kind: "dns-record", key: `A filler-${i}.example.com`, reason: "x".repeat(150), droplet: `filler-${i}.example.com` }));
    r.plans.push({ module: "cloudflare", ops: filler, unchanged: 0, diagnostics: [] });
    const md = renderPrComment(r);
    expect(md).toContain("**Detail truncated:**");
    expect(md).toContain("### ⚠️ Warnings (5)");
    expect(md).toContain("#### Awaiting cutover (1)");
    expect(md).toContain("#### Held: not managed this run (2)");
    expect(md).toContain("#### Tunnel routes not built: add them by hand (1)");
    expect(md).toContain("#### Other warnings (1)");
    expect(md).toContain("shop.example.com: awaiting cutover");
    expect(md).toContain("ch.example.com: 5000/udp");
    expect(md.indexOf("#### Awaiting cutover")).toBeLessThan(md.indexOf("### Changes the apply will make"));
    balanced(md);
  });

  it("shows ops the engine froze under frozen droplets", () => {
    const r = checkReport();
    const tags = op({ provider: "digitalocean", module: "droplets", kind: "droplet-tags", key: "cold.example.com", action: "update", reason: "tags differ", droplet: "cold.example.com" });
    r.plans[0] = freezeOps({ module: "droplets", ops: [OPS.newDroplet, tags], unchanged: 0, diagnostics: [] }, new Set(["cold.example.com"]));
    const md = renderPrComment(r);
    const frozen = md.slice(md.indexOf("<details><summary>Frozen droplets: changes shown, never applied (1)</summary>"));
    expect(frozen.length).toBeLessThan(md.length);
    expect(frozen).toContain("droplet-tags `cold.example.com`: frozen droplet, would update: tags differ");
    expect(md.slice(0, md.indexOf("<details><summary>Frozen"))).not.toContain("cold.example.com");
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
    expect(md).toContain("❌ **Checks failed. Don't merge this yet:** fix the errors below first.");
    expect(md).toContain("the apply after it runs the same checks and writes nothing while any of them fails");
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
    expect(md).toContain("<details><summary>Firewall rules: report only, not enforced until Phase 5 (1 on 1 droplet(s))</summary>");
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

  it("says when apply stopped part-way, listing only what was not applied", () => {
    const md = renderApplySummary(stoppedReport());
    expect(md).toContain("## infra apply: ❌ stopped part-way");
    expect(md).toContain("**Stopped part-way:** re-planning after droplet changes failed; nothing else applied.");
    expect(md).toContain("### Applied (1)");
    const notApplied = md.slice(md.indexOf("### Planned, not applied (6)"));
    expect(notApplied).toContain("`A vpc-shop.example.com`");
    expect(notApplied).not.toContain("DigitalOcean droplet `new.example.com`");
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
