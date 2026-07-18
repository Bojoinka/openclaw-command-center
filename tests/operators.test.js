const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadOperators,
  saveOperators,
  getOperatorBySlackId,
  calculateOperatorStats,
  refreshOperatorsAsync,
} = require("../src/operators");

describe("operators", () => {
  describe("load/save round-trip", () => {
    let dataDir;
    before(() => {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-io-"));
    });
    after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    it("returns default shape when file missing", () => {
      const data = loadOperators(dataDir);
      assert.deepStrictEqual(data.operators, []);
      assert.strictEqual(data.version, 1);
    });

    it("saves and reloads operators", () => {
      const ok = saveOperators(dataDir, {
        version: 1,
        operators: [{ id: "U1", name: "Alice" }],
        roles: {},
      });
      assert.strictEqual(ok, true);
      const data = loadOperators(dataDir);
      assert.strictEqual(data.operators[0].name, "Alice");
    });

    it("looks up operator by slack id", () => {
      const op = getOperatorBySlackId(dataDir, "U1");
      assert.strictEqual(op.name, "Alice");
    });
  });

  describe("calculateOperatorStats", () => {
    it("counts active/total sessions per operator", () => {
      const data = { operators: [{ id: "U1", name: "Alice" }], roles: {} };
      const sessions = [
        { originator: { userId: "U1" }, active: true, minutesAgo: 2 },
        { originator: { userId: "U1" }, active: false, minutesAgo: 90 },
        { originator: { userId: "U2" }, active: true, minutesAgo: 1 },
      ];
      const result = calculateOperatorStats(data, sessions);
      assert.strictEqual(result.operators[0].stats.totalSessions, 2);
      assert.strictEqual(result.operators[0].stats.activeSessions, 1);
    });
  });

  describe("refreshOperatorsAsync sessionCount (regression: #6 inflation)", () => {
    let dataDir;
    let openclawDir;
    const getOpenClawDir = () => openclawDir;

    before(() => {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-refresh-data-"));
      openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-refresh-oc-"));
      const sessionsDir = path.join(openclawDir, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });

      const ts = new Date().toISOString();
      const mkSession = (file, userId, username) => {
        const line = JSON.stringify({
          type: "message",
          timestamp: ts,
          message: {
            role: "user",
            content: `[Slack #cc-dev +1m 2026-07-18 10:00 PST] ${username} (${userId}): hello`,
          },
        });
        fs.writeFileSync(path.join(sessionsDir, file), line + "\n");
      };
      // Same user across two sessions -> sessionCount should be 2
      mkSession("00000000-0000-0000-0000-000000000001.jsonl", "UALICE", "alice");
      mkSession("00000000-0000-0000-0000-000000000002.jsonl", "UALICE", "alice");
    });

    after(() => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(openclawDir, { recursive: true, force: true });
    });

    it("does not inflate sessionCount across repeated refreshes", async () => {
      await refreshOperatorsAsync(dataDir, getOpenClawDir);
      const first = loadOperators(dataDir).operators.find((o) => o.id === "UALICE");
      assert.ok(first, "alice should be detected");
      assert.strictEqual(first.sessionCount, 2);

      // Run several more times — the count must stay 2, not grow
      await refreshOperatorsAsync(dataDir, getOpenClawDir);
      await refreshOperatorsAsync(dataDir, getOpenClawDir);
      const later = loadOperators(dataDir).operators.find((o) => o.id === "UALICE");
      assert.strictEqual(
        later.sessionCount,
        2,
        "sessionCount must not accumulate across refreshes",
      );
    });

    it("self-heals a pre-inflated sessionCount", async () => {
      // Simulate corrupted data from the old accumulating logic
      const data = loadOperators(dataDir);
      const alice = data.operators.find((o) => o.id === "UALICE");
      alice.sessionCount = 9999;
      saveOperators(dataDir, data);

      await refreshOperatorsAsync(dataDir, getOpenClawDir);
      const healed = loadOperators(dataDir).operators.find((o) => o.id === "UALICE");
      assert.strictEqual(healed.sessionCount, 2, "should recompute to the true count");
    });
  });
});
