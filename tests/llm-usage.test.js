const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { transformLiveUsageData, getRoutingStats } = require("../src/llm-usage");

describe("llm-usage module", () => {
  describe("transformLiveUsageData()", () => {
    it("transforms valid usage data with anthropic provider", () => {
      const usage = {
        providers: [
          {
            provider: "anthropic",
            windows: [
              { label: "5h", usedPercent: 25, resetAt: Date.now() + 3600000 },
              { label: "Week", usedPercent: 10, resetAt: Date.now() + 86400000 * 3 },
              { label: "Sonnet", usedPercent: 5, resetAt: Date.now() + 86400000 * 5 },
            ],
          },
        ],
      };

      const result = transformLiveUsageData(usage);
      assert.strictEqual(result.source, "live");
      assert.strictEqual(result.claude.session.usedPct, 25);
      assert.strictEqual(result.claude.session.remainingPct, 75);
      assert.strictEqual(result.claude.weekly.usedPct, 10);
      assert.strictEqual(result.claude.sonnet.usedPct, 5);
    });

    it("handles auth error from provider", () => {
      const usage = {
        providers: [{ provider: "anthropic", error: "403 Forbidden" }],
      };

      const result = transformLiveUsageData(usage);
      assert.strictEqual(result.source, "error");
      assert.strictEqual(result.errorType, "auth");
      assert.ok(result.error.includes("403"));
      assert.strictEqual(result.claude.session.usedPct, null);
    });

    it("handles missing windows gracefully", () => {
      const usage = { providers: [{ provider: "anthropic", windows: [] }] };
      const result = transformLiveUsageData(usage);
      assert.strictEqual(result.source, "live");
      assert.strictEqual(result.claude.session.usedPct, 0);
      assert.strictEqual(result.claude.weekly.usedPct, 0);
    });

    it("handles codex provider data", () => {
      const usage = {
        providers: [
          { provider: "anthropic", windows: [] },
          {
            provider: "openai-codex",
            windows: [
              { label: "5h", usedPercent: 30 },
              { label: "Day", usedPercent: 15 },
            ],
          },
        ],
      };

      const result = transformLiveUsageData(usage);
      assert.strictEqual(result.codex.usage5hPct, 30);
      assert.strictEqual(result.codex.usageDayPct, 15);
    });

    it("handles missing providers gracefully", () => {
      const usage = { providers: [] };
      const result = transformLiveUsageData(usage);
      assert.strictEqual(result.source, "live");
      assert.strictEqual(result.codex.usage5hPct, 0);
    });

    it("formats reset time correctly", () => {
      const usage = {
        providers: [
          {
            provider: "anthropic",
            windows: [{ label: "5h", usedPercent: 50, resetAt: Date.now() + 30 * 60000 }],
          },
        ],
      };
      const result = transformLiveUsageData(usage);
      assert.ok(result.claude.session.resetsIn.includes("m"));
    });
  });

  describe("getRoutingStats() JSONL fallback (regression: #9 NaN filter)", () => {
    let stateDir;
    const skillsDir = path.join(os.tmpdir(), "nonexistent-skills-dir-xyz");

    before(() => {
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-"));
      const now = Date.now();
      const recent = new Date(now - 2 * 3600 * 1000).toISOString(); // 2h ago
      const old = new Date(now - 48 * 3600 * 1000).toISOString(); // 48h ago
      const lines = [
        JSON.stringify({ timestamp: recent, selected_model: "opus", task_type: "code" }),
        JSON.stringify({ timestamp: old, selected_model: "sonnet", task_type: "chat" }),
      ];
      fs.writeFileSync(path.join(stateDir, "routing-log.jsonl"), lines.join("\n") + "\n");
    });

    after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

    it("honors the 24h window (only the recent entry counts)", () => {
      const stats = getRoutingStats(skillsDir, stateDir, 24);
      assert.strictEqual(stats.total_requests, 1);
    });

    it("does not disable the filter on a non-numeric hours value", () => {
      // With the bug, cutoff became NaN and every entry passed -> 2.
      const stats = getRoutingStats(skillsDir, stateDir, "abc");
      assert.strictEqual(
        stats.total_requests,
        1,
        "non-numeric hours must default to 24h, not all-time",
      );
    });
  });
});
