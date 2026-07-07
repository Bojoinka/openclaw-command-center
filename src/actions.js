const { listSessions, getSessionStatus } = require("./gateway-api");
const { getCronJobs } = require("./cron");

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
 * All data comes from Gateway HTTP API or direct SQLite reads.
 * No CLI calls.
 */
async function executeAction(action, deps) {
  const { PORT } = deps;
  const results = { success: false, action, output: "", error: null };

  if (!ALLOWED_ACTIONS.has(action)) {
    results.error = `Unknown action: ${action}`;
    return results;
  }

  try {
    switch (action) {
      case "gateway-status": {
        try {
          const statusText = await getSessionStatus();
          // session_status returns formatted text — extract key lines
          if (typeof statusText === "string") {
            results.output = statusText.split("\n").slice(0, 6).join("\n");
          } else if (statusText.text) {
            results.output = statusText.text.split("\n").slice(0, 6).join("\n");
          } else {
            results.output = JSON.stringify(statusText, null, 2).slice(0, 500);
          }
        } catch (e) {
          results.output = "Gateway API unavailable: " + e.message;
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
          results.output = "API error: " + e.message;
        }
        results.success = true;
        break;
      }

      case "cron-list": {
        try {
          const cron = getCronJobs();
          const lines = cron.jobs.map((j) => {
            const status = j.enabled ? "✅" : "❌";
            const last = j.lastRunStatus || "-";
            return `${status} ${j.agentId}/${j.name} (last: ${last})`;
          });
          results.output =
            cron.total + " jobs (" + cron.enabled + " enabled)\n" + lines.join("\n");
        } catch (e) {
          results.output = "Failed to read cron data: " + e.message;
        }
        results.success = true;
        break;
      }

      case "health-check": {
        const checks = [];
        try {
          const sessions = await listSessions();
          const active = sessions.filter((s) => s.status === "running").length;
          checks.push("Gateway: OK Running");
          checks.push("Sessions: " + sessions.length + " (" + active + " active)");
        } catch (e) {
          checks.push("Gateway: " + (e.message.includes("timeout") ? "SLOW" : "ERROR") + " — " + e.message);
        }
        try {
          const cron = getCronJobs();
          checks.push("Cron: " + cron.total + " jobs (" + cron.enabled + " enabled, " + cron.errored + " errored)");
        } catch (e) {
          checks.push("Cron: unavailable");
        }
        checks.push("Dashboard: OK Running on port " + PORT);
        results.output = checks.join("\n");
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
