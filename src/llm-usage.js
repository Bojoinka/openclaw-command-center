/**
 * LLM Usage tracking via Gateway HTTP API
 *
 * Aggregates token usage and costs from sessions_list data.
 * Replaces the old CLI-based approach (openclaw status --usage --json)
 * which was designed for Claude Code Max fuel gauges.
 */

const { listSessions } = require("./gateway-api");

// Cache for usage data
let usageCache = { data: null, timestamp: 0, refreshing: false };
const USAGE_CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Aggregate usage data from sessions.
 * @param {Array} sessions - Session objects from sessions_list
 * @returns {object} - Aggregated usage data
 */
function aggregateUsage(sessions) {
  const byModel = {};
  const byAgent = {};
  let totalTokens = 0;
  let totalCost = 0;
  let activeSessions = 0;

  for (const s of sessions) {
    const model = (s.model || "unknown")
      .replace("anthropic/", "")
      .replace("openai/", "")
      .replace("xai/", "");
    const agent = s.agentId || "unknown";
    const tokens = s.totalTokens || 0;
    const cost = s.estimatedCostUsd || 0;

    totalTokens += tokens;
    totalCost += cost;

    if (s.status === "running") activeSessions++;

    // By model
    if (!byModel[model]) byModel[model] = { tokens: 0, cost: 0, sessions: 0 };
    byModel[model].tokens += tokens;
    byModel[model].cost += cost;
    byModel[model].sessions += 1;

    // By agent
    if (!byAgent[agent]) byAgent[agent] = { tokens: 0, cost: 0, sessions: 0 };
    byAgent[agent].tokens += tokens;
    byAgent[agent].cost += cost;
    byAgent[agent].sessions += 1;
  }

  // Sort by tokens descending
  const modelBreakdown = Object.entries(byModel)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.tokens - a.tokens);

  const agentBreakdown = Object.entries(byAgent)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    timestamp: new Date().toISOString(),
    source: "gateway-api",
    totalSessions: sessions.length,
    activeSessions,
    totalTokens,
    totalCost,
    totalCostFormatted: "$" + totalCost.toFixed(4),
    byModel: modelBreakdown,
    byAgent: agentBreakdown,
    // Top model for quick display
    topModel: modelBreakdown.length > 0 ? modelBreakdown[0].name : "none",
    topModelTokens: modelBreakdown.length > 0 ? modelBreakdown[0].tokens : 0,
  };
}

/**
 * Background async refresh of usage data via Gateway API.
 */
async function refreshLlmUsageAsync() {
  if (usageCache.refreshing) return;
  usageCache.refreshing = true;

  try {
    const sessions = await listSessions();
    const result = aggregateUsage(sessions);
    usageCache.data = result;
    usageCache.timestamp = Date.now();
    console.log(
      `[LLM Usage] Cache refreshed: ${sessions.length} sessions, ${result.totalTokens.toLocaleString()} tokens, ${result.totalCostFormatted}`,
    );
  } catch (e) {
    console.error("[LLM Usage] Async refresh failed:", e.message);
  }

  usageCache.refreshing = false;
}

/**
 * Get LLM usage stats.
 * Returns cached data immediately, triggers background refresh if stale.
 */
function getLlmUsage() {
  const now = Date.now();

  if (!usageCache.data || now - usageCache.timestamp > USAGE_CACHE_TTL_MS) {
    refreshLlmUsageAsync();
  }

  if (usageCache.data) return usageCache.data;

  // No data yet — return loading state
  return {
    timestamp: new Date().toISOString(),
    source: "loading",
    totalSessions: 0,
    activeSessions: 0,
    totalTokens: 0,
    totalCost: 0,
    totalCostFormatted: "$0.0000",
    byModel: [],
    byAgent: [],
    topModel: "loading...",
    topModelTokens: 0,
  };
}

/**
 * Get routing stats — stub for compatibility.
 * The old routing system (Claude Code Max / Codex) doesn't apply
 * for direct API key users.
 */
function getRoutingStats() {
  return { total_requests: 0, by_model: {}, by_task_type: {} };
}

/**
 * Start background refresh timers.
 */
function startLlmUsageRefresh() {
  setTimeout(() => refreshLlmUsageAsync(), 2000);
  setInterval(() => refreshLlmUsageAsync(), USAGE_CACHE_TTL_MS);
}

module.exports = {
  refreshLlmUsageAsync,
  aggregateUsage,
  getLlmUsage,
  getRoutingStats,
  startLlmUsageRefresh,
};
