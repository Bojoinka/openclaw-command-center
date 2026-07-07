const { listSessions, getSessionStatus } = require("./gateway-api");

const ALLOWED_ACTIONS = new Set([
  "gateway-status",
  "gateway-restart",
  "sessions-list",
  "cron-list",
  "health-check",
  "clear-stale-sessions",
]);

/**
 * Execute a Quick Action.
 * Uses Gateway HTTP API for sessions (~0.2s) with CLI fallback.
 * Cron stays on CLI (cron tool blocked by Gateway HTTP API deny list).
 */
async function executeAction(action, deps) {
  const { runOpenClaw, extractJSON, PORT } = deps;
  const results = { success: false, action, output: "", error: null };

  if (!ALLOWED_ACTIONS.has(action)) {
    results.error = `Unknown action: ${action}`;
    return results;
  }

  try {
    switch (action) {
      case "gateway-status": {
        try {
          const statusData = await getSessionStatus();
          const lines = [];
          if (statusData.model) lines.push("Model: " + statusData.model);
          if (statusData.uptime) lines.push("Uptime: " + statusData.uptime);
          if (statusData.version) lines.push("Version: " + statusData.version);
          results.output =
            lines.length > 0
              ? lines.join("\n")
              : JSON.stringify(statusData, null, 2).slice(0, 500);
        } catch (e) {
          // Fallback to CLI
          results.output = runOpenClaw("gateway status 2>&1") || "Unknown";
        }
        results.success = true;
        break;
      }

      case "gateway-restart":
        results.output = "To restart gateway, run: openclaw gateway restart";
        results.success = true;
        results.note = "Dashboard cannot restart gateway for safety";
        break;

      case "sessions-list": {
        try {
          const sessions = await listSessions();
          const active = sessions.filter((s) => s.status === "running").length;
          results.output = sessions.length + " sessions (" + active + " active)";
        } catch (e) {
          results.output = runOpenClaw("sessions 2>&1") || "No sessions";
        }
        results.success = true;
        break;
      }

      case "cron-list":
        // cron tool not exposed via Gateway HTTP API — use CLI
        results.output = runOpenClaw("cron list 2>&1") || "No cron jobs";
        results.success = true;
        break;

      case "health-check": {
        try {
          const sessions = await listSessions();
          const active = sessions.filter((s) => s.status === "running").length;
          results.output = [
            "Gateway: OK Running",
            "Sessions: " + sessions.length + " (" + active + " active)",
            "Dashboard: OK Running on port " + PORT,
          ].join("\n");
        } catch (e) {
          // Fallback
          const gateway = runOpenClaw("gateway status 2>&1");
          results.output = [
            "Gateway: " +
              (gateway?.includes("running") ? "OK Running" : "NOT Running"),
            "Dashboard: OK Running on port " + PORT,
          ].join("\n");
        }
        results.success = true;
        break;
      }

      case "clear-stale-sessions": {
        let staleCount = 0;
        let totalCount = 0;
        try {
          const sessions = await listSessions();
          totalCount = sessions.length;
          const nowMs = Date.now();
          staleCount = sessions.filter((s) => {
            const updated = s.updatedAt || 0;
            return updated > 0 && nowMs - updated > 24 * 60 * 60 * 1000;
          }).length;
        } catch (e) {
          results.error = "Gateway API error: " + e.message;
        }
        results.output =
          "Found " +
          staleCount +
          " stale sessions (>24h old) out of " +
          totalCount +
          " total.\nTo clean: openclaw sessions prune";
        results.success = true;
        break;
      }
    }
  } catch (e) {
    results.error = e.message;
  }

  return results;
}

module.exports = { executeAction, ALLOWED_ACTIONS };
