const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

describe("server", () => {
  // Use a random high port to avoid conflicts
  const TEST_PORT = 10000 + Math.floor(Math.random() * 50000);
  let serverProcess;

  before(async () => {
    // Start the server as a child process with a custom PORT
    serverProcess = spawn(process.execPath, [path.join(__dirname, "..", "lib", "server.js")], {
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wait for server to be ready by polling the health endpoint
    const maxWait = 10000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      try {
        await httpGet(`http://localhost:${TEST_PORT}/api/health`);
        return; // Server is ready
      } catch (_e) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    throw new Error(`Server did not start within ${maxWait}ms`);
  });

  after(() => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      serverProcess = null;
    }
  });

  it("responds to /api/health with status ok", async () => {
    const { statusCode, body } = await httpGet(`http://localhost:${TEST_PORT}/api/health`);
    assert.strictEqual(statusCode, 200);
    const data = JSON.parse(body);
    assert.strictEqual(data.status, "ok");
    assert.strictEqual(data.port, TEST_PORT);
    assert.ok(data.timestamp, "should have timestamp");
  });

  it("responds to /api/about with project info", async () => {
    const { statusCode, body } = await httpGet(`http://localhost:${TEST_PORT}/api/about`);
    assert.strictEqual(statusCode, 200);
    const data = JSON.parse(body);
    assert.ok(data.name || data.version, "should have project info");
  });

  it("returns JSON content type for API endpoints", async () => {
    const { headers } = await httpGet(`http://localhost:${TEST_PORT}/api/health`);
    assert.ok(
      headers["content-type"].includes("application/json"),
      `Expected JSON content type, got: ${headers["content-type"]}`,
    );
  });

  it("serves static files for root path", async () => {
    const { statusCode } = await httpGet(`http://localhost:${TEST_PORT}/`);
    // Should return 200 (index.html) or similar
    assert.ok(
      statusCode >= 200 && statusCode < 500,
      `Expected 2xx/3xx/4xx status for root, got: ${statusCode}`,
    );
  });

  it("clamps negative/zero pagination params on /api/sessions", async () => {
    const { statusCode, body } = await httpGet(
      `http://localhost:${TEST_PORT}/api/sessions?page=-3&pageSize=0`,
    );
    assert.strictEqual(statusCode, 200);
    const data = JSON.parse(body);
    assert.strictEqual(data.pagination.page, 1, "page should clamp to >= 1");
    assert.ok(
      data.pagination.pageSize >= 1 && data.pagination.pageSize <= 100,
      `pageSize should clamp into [1,100], got ${data.pagination.pageSize}`,
    );
  });

  it("responds 204 to OPTIONS instead of falling through to 404", async () => {
    const { statusCode } = await httpRequest(`http://localhost:${TEST_PORT}/api/status`, "OPTIONS");
    assert.strictEqual(statusCode, 204);
  });
});

/**
 * Simple HTTP GET helper that returns a promise
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
          }),
        );
      })
      .on("error", reject);
  });
}

/**
 * HTTP request helper supporting an arbitrary method
 */
function httpRequest(url, method) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
