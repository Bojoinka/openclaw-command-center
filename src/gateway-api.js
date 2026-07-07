/**
 * Gateway HTTP API client for OpenClaw Command Center
 *
 * Uses the /tools/invoke endpoint (~0.1-0.2s) instead of spawning
 * the openclaw CLI (~12s). The CLI spawns a full Node.js process,
 * connects via WebSocket, serializes the response, then exits.
 * The HTTP API skips all of that.
 *
 * Blocked tools (Gateway default deny list):
 *   - sessions_spawn, sessions_send, gateway, whatsapp_login
 *   - cron (also blocked — use CLI fallback for cron operations)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

let _cachedToken = null;
let _tokenLoadedAt = 0;
const TOKEN_CACHE_TTL = 60000; // Re-read secrets.json at most every 60s

/**
 * Read the gateway auth token from secrets.json.
 * Caches the result to avoid re-reading the file on every call.
 */
function getGatewayToken() {
  const now = Date.now();
  if (_cachedToken && now - _tokenLoadedAt < TOKEN_CACHE_TTL) {
    return _cachedToken;
  }
  try {
    const secretsPath = path.join(
      process.env.HOME || "/home/odin",
      ".openclaw",
      "secrets.json",
    );
    const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
    _cachedToken =
      (secrets.providers &&
        secrets.providers.gatewayAuth &&
        secrets.providers.gatewayAuth.token) ||
      "";
    _tokenLoadedAt = now;
  } catch (e) {
    _cachedToken = "";
  }
  return _cachedToken;
}

/**
 * Invoke a Gateway tool via the HTTP API.
 *
 * @param {string} tool - Tool name (e.g. "sessions_list", "session_status")
 * @param {object} [args={}] - Tool arguments
 * @param {object} [options={}] - Options
 * @param {number} [options.timeoutMs=10000] - Request timeout in ms
 * @param {number} [options.port=18789] - Gateway port
 * @returns {Promise<object>} - Parsed tool result (unwrapped from content[0].text)
 */
function gatewayInvoke(tool, args = {}, options = {}) {
  const timeoutMs = options.timeoutMs || 10000;
  const port = options.port || parseInt(process.env.OPENCLAW_GATEWAY_PORT || "18789", 10);
  const token = getGatewayToken();

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ tool, args });
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/tools/invoke",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
          "Content-Length": Buffer.byteLength(postData),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const d = JSON.parse(body);
            if (d.ok && d.result && d.result.content) {
              // Unwrap: result.content[0].text contains the actual JSON
              try {
                resolve(JSON.parse(d.result.content[0].text));
              } catch (e2) {
                // content[0].text wasn't JSON — return it as-is
                resolve({ text: d.result.content[0].text });
              }
            } else if (d.error) {
              reject(new Error(d.error.message || "Gateway API error"));
            } else {
              resolve(d);
            }
          } catch (e) {
            reject(new Error("Invalid JSON from gateway"));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Gateway API timeout"));
    });
    req.write(postData);
    req.end();
  });
}

/**
 * List all sessions via the Gateway API.
 * @returns {Promise<Array>} - Array of session objects
 */
async function listSessions() {
  const data = await gatewayInvoke("sessions_list", {});
  return data.sessions || [];
}

/**
 * Get session status (model, uptime, etc.) via the Gateway API.
 * @returns {Promise<object>} - Status object
 */
async function getSessionStatus() {
  return await gatewayInvoke("session_status", {});
}

module.exports = {
  gatewayInvoke,
  listSessions,
  getSessionStatus,
  getGatewayToken,
};
