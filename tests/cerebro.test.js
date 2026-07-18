const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { updateTopicStatus } = require("../src/cerebro");

describe("cerebro updateTopicStatus", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cerebro-test-"));
    // Create a legitimate topic
    const topicDir = path.join(tmpDir, "topics", "real-topic");
    fs.mkdirSync(topicDir, { recursive: true });
    fs.writeFileSync(
      path.join(topicDir, "topic.md"),
      "---\ntitle: Real Topic\nstatus: active\n---\n\n# Real Topic\n",
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates status of a valid topic", () => {
    const result = updateTopicStatus(tmpDir, "real-topic", "resolved");
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.topic.status, "resolved");
    const content = fs.readFileSync(path.join(tmpDir, "topics", "real-topic", "topic.md"), "utf8");
    assert.ok(content.includes("status: resolved"));
  });

  it("rejects topic id containing forward-slash traversal", () => {
    const result = updateTopicStatus(tmpDir, "../../evil", "resolved");
    assert.strictEqual(result.code, 400);
    assert.match(result.error, /invalid topic id/i);
  });

  it("rejects topic id containing backslash traversal", () => {
    const result = updateTopicStatus(tmpDir, "..\\..\\evil", "resolved");
    assert.strictEqual(result.code, 400);
  });

  it("rejects topic id with embedded slash", () => {
    const result = updateTopicStatus(tmpDir, "sub/dir", "resolved");
    assert.strictEqual(result.code, 400);
  });

  it("rejects dotfile topic ids", () => {
    const result = updateTopicStatus(tmpDir, ".hidden", "resolved");
    assert.strictEqual(result.code, 400);
  });

  it("does not write outside the topics directory on traversal attempt", () => {
    const escapeTarget = path.join(tmpDir, "topic.md");
    updateTopicStatus(tmpDir, "..", "resolved");
    assert.strictEqual(
      fs.existsSync(escapeTarget),
      false,
      "must not create topic.md outside topics/",
    );
  });
});
