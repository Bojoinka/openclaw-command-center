/**
 * LLM Usage tracking via Gateway HTTP API
 *
 * Aggregates token usage and costs from sessions_list data.
 * Provides all-time totals and today's usage breakdown by model/agent.
 */

const { listSessions } = require("./gateway-api");

// Cache for usage data
let usageCache = { data: null, timestamp: 0, refreshing: false };
const USAGE_CACHE_TTL_MS = 30000; // 30 seconds

// Blended cost per 1M tokens (weighted avg assuming ~3:1 input:output ratio)
// These approximate real costs better than the broken estimatedCostUsd from sessions
const BLENDED_RATES = {
  'claude-opus-4-6':        28.00,  // $15 in + $75 out, blended ~$28/MTok
  'claude-sonnet-5':         9.00,  // $3 in + $15 out, blended ~$9/MTok
  'claude-sonnet-4-6':       9.00,
  'claude-haiku-4-5':        1.75,  // $0.80 in + $4 out, blended ~$1.75/MTok
  'gpt-5.4':                 8.00,  // $4 in + $16 out, blended ~$8/MTok
  'gpt-5.4-nano':            0.30,  // $0.10 in + $0.40 out, blended ~$0.30/MTok
  'gpt-5.2':                 8.00,
  'gpt-4.1':                 4.00,
  'gpt-4o':                  5.00,
  'gpt-4o-mini':             0.30,
  'grok-4.3':                8.00,  // $3 in + $15 out, blended ~$8/MTok
  'default':                 5.00,
};

function blendedCost(modelName, tokens) {
  const key = Object.keys(BLENDED_RATES).find(k => k !== 'default' && modelName.toLowerCase().startsWith(k.toLowerCase()));
  const rate = key ? BLENDED_RATES[key] : BLENDED_RATES.default;
  return (tokens / 1_000_000) * rate;
}

/**
 * Get midnight timestamp for today (local server time).
 */
function getTodayMidnight() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * Aggregate a list of sessions into tokens/cost/model/agent breakdowns.
 */
function buildBreakdown(sessions) {
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
    const cost = blendedCost(model, tokens);

    totalTokens += tokens;
    totalCost += cost;

    if (s.status === "running") activeSessions++;

    if (!byModel[model]) byModel[model] = { tokens: 0, cost: 0, sessions: 0 };
    byModel[model].tokens += tokens;
    byModel[model].cost += cost;
    byModel[model].sessions += 1;

    if (!byAgent[agent]) byAgent[agent] = { tokens: 0, cost: 0, sessions: 0 };
    byAgent[agent].tokens += tokens;
    byAgent[agent].cost += cost;
    byAgent[agent].sessions += 1;
  }

  const modelBreakdown = Object.entries(byModel)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.tokens - a.tokens);

  const agentBreakdown = Object.entries(byAgent)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    totalSessions: sessions.length,
    activeSessions,
    totalTokens,
    totalCost,
    totalCostFormatted: "$" + totalCost.toFixed(4),
    byModel: modelBreakdown,
    byAgent: agentBreakdown,
    topModel: modelBreakdown.length > 0 ? modelBreakdown[0].name : "none",
    topModelTokens: modelBreakdown.length > 0 ? modelBreakdown[0].tokens : 0,
  };
}

/**
 * Aggregate usage data from sessions with all-time + today views.
 */
function aggregateUsage(sessions) {
  const todayMs = getTodayMidnight();

  // Sessions active today = updatedAt >= midnight today
  const todaySessions = sessions.filter((s) => {
    const updated = s.updatedAt || 0;
    return updated >= todayMs;
  });

  const allTime = buildBreakdown(sessions);
  const today = buildBreakdown(todaySessions);

  return {
    timestamp: new Date().toISOString(),
    source: "gateway-api",
    // All-time totals (flat, backward compatible)
    ...allTime,
    // Today's usage
    today,
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
      `[LLM Usage] Cache refreshed: ${sessions.length} sessions, ${result.totalTokens.toLocaleString()} tokens, ${result.totalCostFormatted} (today: ${result.today.totalSessions} sessions, ${result.today.totalCostFormatted})`,
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

  const empty = {
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

  return {
    timestamp: new Date().toISOString(),
    source: "loading",
    ...empty,
    today: { ...empty },
  };
}

/**
 * Get routing stats — stub for compatibility.
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
