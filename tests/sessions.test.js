const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadChannelMap, parseSessionLabel, DEFAULT_CHANNEL_MAP } = require("../src/sessions");

describe("sessions channel map", () => {
  describe("loadChannelMap", () => {
    let dataDir;
    before(() => {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chan-"));
    });
    after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    it("returns defaults when no channels.json", () => {
      const map = loadChannelMap(dataDir);
      assert.strictEqual(map.c0aan38tzv5, "#cc-dev");
    });

    it("returns defaults when dataDir is falsy", () => {
      const map = loadChannelMap(null);
      assert.deepStrictEqual(map, DEFAULT_CHANNEL_MAP);
    });

    it("merges a flat channels.json over defaults (case-insensitive keys)", () => {
      fs.writeFileSync(
        path.join(dataDir, "channels.json"),
        JSON.stringify({ CABC123: "#my-team", c0aan38tzv5: "#dev-renamed" }),
      );
      const map = loadChannelMap(dataDir);
      assert.strictEqual(map.cabc123, "#my-team", "new key lowercased");
      assert.strictEqual(map.c0aan38tzv5, "#dev-renamed", "override wins over default");
      assert.strictEqual(map.c0aax7y80np, "#cc-meta", "untouched default preserved");
    });

    it("supports the { channels: {...} } wrapper form", () => {
      fs.writeFileSync(
        path.join(dataDir, "channels.json"),
        JSON.stringify({ channels: { cxyz: "#wrapped" } }),
      );
      const map = loadChannelMap(dataDir);
      assert.strictEqual(map.cxyz, "#wrapped");
    });

    it("falls back to defaults on malformed JSON", () => {
      fs.writeFileSync(path.join(dataDir, "channels.json"), "{ not valid json");
      const map = loadChannelMap(dataDir);
      assert.strictEqual(map.c0aan38tzv5, "#cc-dev");
    });
  });

  describe("parseSessionLabel", () => {
    it("uses a supplied channel map", () => {
      const key = "agent:main:slack:channel:CABC123";
      const label = parseSessionLabel(key, { cabc123: "#custom" });
      assert.strictEqual(label, "#custom");
    });

    it("falls back to #<id> for unmapped channels", () => {
      const key = "agent:main:slack:channel:CUNKNOWN";
      const label = parseSessionLabel(key, {});
      assert.strictEqual(label, "#cunknown");
    });

    it("labels the main session", () => {
      assert.strictEqual(parseSessionLabel("agent:main:main"), "🏠 Main Session");
    });

    it("labels telegram sessions", () => {
      assert.strictEqual(parseSessionLabel("agent:main:telegram:123"), "📱 Telegram");
    });
  });
});
