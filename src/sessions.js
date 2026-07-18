const fs = require("fs");
const path = require("path");
const { detectTopics } = require("./topics");

// Default channel ID -> name mapping. These are from the upstream author's
// workspace and only serve as a fallback; every deployment should override via
// a channels.json in the profile data dir (see loadChannelMap). Unmapped
// channels fall back to their raw id.
const DEFAULT_CHANNEL_MAP = {
  c0aax7y80np: "#cc-meta",
  c0ab9f8sdfe: "#cc-research",
  c0aan4rq7v5: "#cc-finance",
  c0abxulk1qq: "#cc-properties",
  c0ab5nz8mkl: "#cc-ai",
  c0aan38tzv5: "#cc-dev",
  c0ab7wwhqvc: "#cc-home",
  c0ab1pjhxef: "#cc-health",
  c0ab7txvcqd: "#cc-legal",
  c0aay2g3n3r: "#cc-social",
  c0aaxrw2wqp: "#cc-business",
  c0ab19f3lae: "#cc-random",
  c0ab0r74y33: "#cc-food",
  c0ab0qrq3r9: "#cc-travel",
  c0ab0sbqqlg: "#cc-family",
  c0ab0slqdba: "#cc-games",
  c0ab1ps7ef2: "#cc-music",
  c0absbnrsbe: "#cc-dashboard",
};

// Backwards-compatible alias for existing importers.
const CHANNEL_MAP = DEFAULT_CHANNEL_MAP;

/**
 * Load a channel-id -> name map for this deployment.
 * Reads channels.json from the profile data dir if present (lowercasing keys),
 * merged over the built-in defaults. Returns the defaults on any error.
 * channels.json may be either a flat { "cID": "#name" } object or
 * { "channels": { ... } }.
 */
function loadChannelMap(dataDir) {
  const map = { ...DEFAULT_CHANNEL_MAP };
  if (!dataDir) return map;
  try {
    const file = path.join(dataDir, "channels.json");
    if (!fs.existsSync(file)) return map;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const entries = parsed && parsed.channels ? parsed.channels : parsed;
    if (entries && typeof entries === "object") {
      for (const [id, name] of Object.entries(entries)) {
        if (typeof name === "string") map[id.toLowerCase()] = name;
      }
    }
  } catch (e) {
    console.error("[Channels] Failed to load channels.json:", e.message);
  }
  return map;
}

// Parse session key into readable label
function parseSessionLabel(key, channelMap = DEFAULT_CHANNEL_MAP) {
  // Pattern: agent:main:slack:channel:CHANNEL_ID:thread:TIMESTAMP
  // or: agent:main:slack:channel:CHANNEL_ID
  // or: agent:main:main (telegram main)

  const parts = key.split(":");

  if (parts.includes("slack")) {
    const channelIdx = parts.indexOf("channel");
    if (channelIdx >= 0 && parts[channelIdx + 1]) {
      const channelId = parts[channelIdx + 1].toLowerCase();
      const channelName = channelMap[channelId] || `#${channelId}`;

      // Check if it's a thread
      if (parts.includes("thread")) {
        const threadTs = parts[parts.indexOf("thread") + 1];
        // Convert timestamp to rough time
        const ts = parseFloat(threadTs);
        const date = new Date(ts * 1000);
        const timeStr = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        return `${channelName} thread @ ${timeStr}`;
      }
      return channelName;
    }
  }

  if (key.includes("telegram")) {
    return "📱 Telegram";
  }

  if (key === "agent:main:main") {
    return "🏠 Main Session";
  }

  // Fallback: truncate key
  return key.length > 40 ? key.slice(0, 37) + "..." : key;
}

/**
 * Create a sessions module with bound dependencies.
 * @param {Object} deps
 * @param {Function} deps.getOpenClawDir - Returns the OpenClaw directory path
 * @param {Function} deps.getOperatorBySlackId - Look up operator by Slack ID
 * @param {Function} deps.runOpenClaw - Run OpenClaw command synchronously
 * @param {Function} deps.runOpenClawAsync - Run OpenClaw command asynchronously
 * @param {Function} deps.extractJSON - Extract JSON from command output
 * @returns {Object} Session management functions
 */
function createSessionsModule(deps) {
  const { getOpenClawDir, getOperatorBySlackId, runOpenClaw, runOpenClawAsync, extractJSON } = deps;
  // Effective channel map for this deployment (defaults + channels.json override)
  const channelMap = deps.channelMap || DEFAULT_CHANNEL_MAP;

  // SESSION CACHE - Async refresh to avoid blocking.
  // `raw` retains the unmapped session objects from the CLI so consumers that
  // need raw fields (capacity, session detail, subagents) can read from cache
  // instead of making their own blocking sync CLI calls.
  let sessionsCache = { sessions: [], raw: [], timestamp: 0, refreshing: false };
  const SESSIONS_CACHE_TTL = 10000; // 10 seconds

  // Per-transcript caches for originator and topic. A session's originator and
  // topic are effectively immutable once set, so we key by file path and only
  // recompute when the file's mtime changes. This avoids re-reading and
  // re-parsing every transcript on every 10s sessions refresh.
  const HEAD_BYTES = 50000; // enough for the first several messages
  const originatorCache = new Map(); // path -> { mtimeMs, value }
  const topicCache = new Map(); // path -> { mtimeMs, value }

  // Read the first `bytes` of a file without loading the whole thing.
  function readFileHead(filePath, bytes) {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      const read = fs.readSync(fd, buffer, 0, bytes, 0);
      return read > 0 ? buffer.toString("utf8", 0, read) : "";
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Find transcript file for a session ID.
   * Handles both plain (sessionId.jsonl) and topic-suffixed (sessionId-topic-XXX.jsonl) files.
   * @param {string} sessionId - Session UUID
   * @returns {string|null} - Full path to transcript file or null if not found
   */
  function findTranscriptPath(sessionId) {
    if (!sessionId) return null;

    const openclawDir = getOpenClawDir();
    const sessionsDir = path.join(openclawDir, "agents", "main", "sessions");

    // Try exact match first (most common case)
    const exactPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    if (fs.existsSync(exactPath)) return exactPath;

    // Search for topic-suffixed files (e.g., sessionId-topic-TIMESTAMP.jsonl)
    try {
      const files = fs.readdirSync(sessionsDir);
      const prefix = `${sessionId}-`;
      const match = files.find(
        (f) => f.startsWith(prefix) && f.endsWith(".jsonl") && !f.includes(".deleted."),
      );
      if (match) return path.join(sessionsDir, match);
    } catch (e) {
      // Directory read failed
    }

    return null;
  }

  // Extract session originator from transcript
  function getSessionOriginator(sessionId) {
    try {
      if (!sessionId) return null;

      const transcriptPath = findTranscriptPath(sessionId);
      if (!transcriptPath) return null;

      // Serve from cache when the transcript hasn't changed since last parse.
      const mtimeMs = fs.statSync(transcriptPath).mtimeMs;
      const cached = originatorCache.get(transcriptPath);
      if (cached && cached.mtimeMs === mtimeMs) {
        return cached.value;
      }

      // Read only the head of the file — the originator is in the first few
      // messages, so there's no need to load a potentially multi-MB transcript.
      const content = readFileHead(transcriptPath, HEAD_BYTES);
      const lines = content.split("\n").filter((l) => l.trim());
      const value = extractOriginatorFromLines(lines);
      originatorCache.set(transcriptPath, { mtimeMs, value });
      return value;
    } catch (e) {
      return null;
    }
  }

  // Parse originator info from the first few transcript lines.
  function extractOriginatorFromLines(lines) {
    try {
      // Find the first user message to extract originator
      for (let i = 0; i < Math.min(lines.length, 10); i++) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type !== "message" || !entry.message) continue;

          const msg = entry.message;
          if (msg.role !== "user") continue;

          let text = "";
          if (typeof msg.content === "string") {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            const textPart = msg.content.find((c) => c.type === "text");
            if (textPart) text = textPart.text || "";
          }

          if (!text) continue;

          // Extract Slack user from message patterns:
          // Format 1 (old): "[Slack #channel +6m 2026-01-27 15:31 PST] username (USERID): message"
          // Format 2 (new): Conversation info JSON with "sender_id": "USERID" and "sender": "username"
          const slackUserMatch = text.match(/\]\s*([\w.-]+)\s*\(([A-Z0-9]+)\):/);

          if (slackUserMatch) {
            const username = slackUserMatch[1];
            const userId = slackUserMatch[2];

            const operator = getOperatorBySlackId(userId);

            return {
              userId,
              username,
              displayName: operator?.name || username,
              role: operator?.role || "user",
              avatar: operator?.avatar || null,
            };
          }

          // Try new format: Conversation info JSON block
          // Look for "sender_id": "USERID" and "sender": "username"
          const senderIdMatch = text.match(/"sender_id":\s*"([A-Z0-9]+)"/);
          const senderMatch = text.match(/"sender":\s*"([^"]+)"/);

          if (senderIdMatch) {
            const userId = senderIdMatch[1];
            const username = senderMatch ? senderMatch[1] : userId;

            const operator = getOperatorBySlackId(userId);

            return {
              userId,
              username,
              displayName: operator?.name || username,
              role: operator?.role || "user",
              avatar: operator?.avatar || null,
            };
          }
        } catch (e) {
          /* skip malformed line */
        }
      }

      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get quick topic for a session by reading first portion of transcript
   * @param {string} sessionId - Session ID
   * @returns {string|null} - Primary topic or null
   */
  function getSessionTopic(sessionId) {
    if (!sessionId) return null;
    try {
      const transcriptPath = findTranscriptPath(sessionId);
      if (!transcriptPath) return null;

      // Serve from cache when the transcript hasn't changed since last parse.
      const mtimeMs = fs.statSync(transcriptPath).mtimeMs;
      const cached = topicCache.get(transcriptPath);
      if (cached && cached.mtimeMs === mtimeMs) {
        return cached.value;
      }

      // Read first 50KB of transcript (enough for topic detection, fast)
      const content = readFileHead(transcriptPath, HEAD_BYTES);
      if (!content) {
        topicCache.set(transcriptPath, { mtimeMs, value: null });
        return null;
      }
      const lines = content.split("\n").filter((l) => l.trim());

      // Extract text from messages
      // Transcript format: {type: "message", message: {role: "user"|"assistant", content: [...]}}
      let textSamples = [];
      for (const line of lines.slice(0, 30)) {
        // First 30 entries
        try {
          const entry = JSON.parse(line);
          if (entry.type === "message" && entry.message?.content) {
            const msgContent = entry.message.content;
            if (Array.isArray(msgContent)) {
              msgContent.forEach((c) => {
                if (c.type === "text" && c.text) {
                  textSamples.push(c.text.slice(0, 500));
                }
              });
            } else if (typeof msgContent === "string") {
              textSamples.push(msgContent.slice(0, 500));
            }
          }
        } catch (e) {
          /* skip malformed lines */
        }
      }

      if (textSamples.length === 0) {
        topicCache.set(transcriptPath, { mtimeMs, value: null });
        return null;
      }

      const topics = detectTopics(textSamples.join(" "));
      const value = topics.length > 0 ? topics.slice(0, 2).join(", ") : null;
      topicCache.set(transcriptPath, { mtimeMs, value });
      return value;
    } catch (e) {
      return null;
    }
  }

  // Helper to map a single session (extracted from getSessions)
  function mapSession(s) {
    const minutesAgo = s.ageMs ? s.ageMs / 60000 : Infinity;

    // Determine channel type from key (messaging platform)
    let channel = "other";
    if (s.key.includes("slack")) channel = "slack";
    else if (s.key.includes("telegram")) channel = "telegram";
    else if (s.key.includes("discord")) channel = "discord";
    else if (s.key.includes("signal")) channel = "signal";
    else if (s.key.includes("whatsapp")) channel = "whatsapp";

    // Determine session type (main, subagent, cron, channel-based)
    let sessionType = "channel";
    if (s.key.includes(":subagent:")) sessionType = "subagent";
    else if (s.key.includes(":cron:")) sessionType = "cron";
    else if (s.key === "agent:main:main") sessionType = "main";

    const originator = getSessionOriginator(s.sessionId);
    const label = s.groupChannel || s.displayName || parseSessionLabel(s.key, channelMap);
    const topic = getSessionTopic(s.sessionId);

    const totalTokens = s.totalTokens || 0;
    const sessionAgeMinutes = Math.max(1, Math.min(minutesAgo, 24 * 60));
    const burnRate = Math.round(totalTokens / sessionAgeMinutes);

    return {
      sessionKey: s.key,
      sessionId: s.sessionId,
      label: label,
      groupChannel: s.groupChannel || null,
      displayName: s.displayName || null,
      kind: s.kind,
      channel: channel,
      sessionType: sessionType,
      active: minutesAgo < 15,
      recentlyActive: minutesAgo < 60,
      minutesAgo: Math.round(minutesAgo),
      tokens: s.totalTokens || 0,
      model: s.model,
      originator: originator,
      topic: topic,
      metrics: {
        burnRate: burnRate,
        toolCalls: 0,
        minutesActive: Math.max(1, Math.min(Math.round(minutesAgo), 24 * 60)),
      },
    };
  }

  async function refreshSessionsCache() {
    if (sessionsCache.refreshing) return; // Don't double-refresh
    sessionsCache.refreshing = true;

    try {
      const output = await runOpenClawAsync("sessions --json 2>/dev/null");
      const jsonStr = extractJSON(output);
      if (jsonStr) {
        const data = JSON.parse(jsonStr);
        const sessions = data.sessions || [];

        // Map sessions (same logic as getSessions)
        const mapped = sessions.map((s) => mapSession(s));
        const withOriginator = mapped.filter((s) => s.originator != null);

        sessionsCache = {
          sessions: mapped,
          raw: sessions,
          timestamp: Date.now(),
          refreshing: false,
        };
        console.log(
          `[Sessions Cache] Refreshed: ${mapped.length} sessions (${withOriginator.length} with originator)`,
        );
      }
    } catch (e) {
      console.error("[Sessions Cache] Refresh error:", e.message);
    }
    sessionsCache.refreshing = false;
  }

  // Get sessions from cache, trigger async refresh if stale
  function getSessionsCached() {
    const now = Date.now();
    const isStale = now - sessionsCache.timestamp > SESSIONS_CACHE_TTL;

    if (isStale && !sessionsCache.refreshing) {
      // Trigger async refresh (don't await - return stale data immediately)
      refreshSessionsCache();
    }

    return sessionsCache.sessions;
  }

  /**
   * Get the raw (unmapped) session objects from cache, triggering an async
   * refresh when stale. On a cold cache (never populated) falls back to a
   * single synchronous fetch so the very first request still works; steady
   * state is fully non-blocking.
   */
  function getRawSessionsCached() {
    const now = Date.now();
    const isStale = now - sessionsCache.timestamp > SESSIONS_CACHE_TTL;

    if (sessionsCache.timestamp === 0) {
      // Cold start: one-time sync fetch to avoid an empty first render.
      try {
        const output = runOpenClaw("sessions --json 2>/dev/null");
        const jsonStr = extractJSON(output);
        if (jsonStr) {
          const data = JSON.parse(jsonStr);
          sessionsCache.raw = data.sessions || [];
        }
      } catch (e) {
        // leave whatever we have
      }
      refreshSessionsCache(); // warm the full cache in the background
    } else if (isStale && !sessionsCache.refreshing) {
      refreshSessionsCache();
    }

    return sessionsCache.raw || [];
  }

  function getSessions(options = {}) {
    const limit = Object.prototype.hasOwnProperty.call(options, "limit") ? options.limit : 20;
    const returnCount = options.returnCount || false;

    // For "get all" requests (limit: null), use the async cache
    // This is the expensive operation that was blocking
    if (limit === null) {
      const cached = getSessionsCached();
      const totalCount = cached.length;
      return returnCount ? { sessions: cached, totalCount } : cached;
    }

    // For limited requests, can still use sync (fast enough)
    try {
      const output = runOpenClaw("sessions --json 2>/dev/null");
      const jsonStr = extractJSON(output);
      if (jsonStr) {
        const data = JSON.parse(jsonStr);
        const totalCount = data.count || data.sessions?.length || 0;
        let sessions = data.sessions || [];
        if (limit != null) {
          sessions = sessions.slice(0, limit);
        }
        const mapped = sessions.map((s) => mapSession(s));
        return returnCount ? { sessions: mapped, totalCount } : mapped;
      }
    } catch (e) {
      console.error("Failed to get sessions:", e.message);
    }
    return returnCount ? { sessions: [], totalCount: 0 } : [];
  }

  // Read session transcript from JSONL file
  function readTranscript(sessionId) {
    const transcriptPath = findTranscriptPath(sessionId);

    try {
      if (!transcriptPath) return [];
      const content = fs.readFileSync(transcriptPath, "utf8");
      return content
        .trim()
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch (e) {
      console.error("Failed to read transcript:", e.message);
      return [];
    }
  }

  // Get detailed session info
  function getSessionDetail(sessionKey) {
    try {
      // Get basic session info from the cached raw sessions (non-blocking in
      // steady state; cold start does a one-time sync fetch inside the getter).
      const sessionInfo = getRawSessionsCached().find((s) => s.key === sessionKey);

      if (!sessionInfo) {
        return { error: "Session not found" };
      }

      // Read transcript directly from JSONL file
      const transcript = readTranscript(sessionInfo.sessionId);
      let messages = [];
      let tools = {};
      let facts = [];
      let needsAttention = [];

      // Aggregate token usage from transcript
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let totalCost = 0;
      let detectedModel = sessionInfo.model || null;

      // Process transcript entries (format: {type: "message", message: {role, content, usage}})
      transcript.forEach((entry) => {
        if (entry.type !== "message" || !entry.message) return;

        const msg = entry.message;
        if (!msg.role) return;

        // Extract token usage from messages (typically on assistant messages)
        if (msg.usage) {
          totalInputTokens += msg.usage.input || msg.usage.inputTokens || 0;
          totalOutputTokens += msg.usage.output || msg.usage.outputTokens || 0;
          totalCacheRead += msg.usage.cacheRead || msg.usage.cacheReadTokens || 0;
          totalCacheWrite += msg.usage.cacheWrite || msg.usage.cacheWriteTokens || 0;
          if (msg.usage.cost?.total) totalCost += msg.usage.cost.total;
        }

        // Detect model from assistant messages
        if (msg.role === "assistant" && msg.model && !detectedModel) {
          detectedModel = msg.model;
        }

        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          const textPart = msg.content.find((c) => c.type === "text");
          if (textPart) text = textPart.text || "";

          // Count tool calls
          msg.content
            .filter((c) => c.type === "toolCall" || c.type === "tool_use")
            .forEach((tc) => {
              const name = tc.name || tc.tool || "unknown";
              tools[name] = (tools[name] || 0) + 1;
            });
        }

        if (text && msg.role !== "toolResult") {
          messages.push({ role: msg.role, text, timestamp: entry.timestamp });
        }

        // Extract insights from user messages
        if (msg.role === "user" && text) {
          const lowerText = text.toLowerCase();

          // Look for questions
          if (text.includes("?")) {
            const questions = text.match(/[^.!?\n]*\?/g) || [];
            questions.slice(0, 2).forEach((q) => {
              if (q.length > 15 && q.length < 200) {
                needsAttention.push(`❓ ${q.trim()}`);
              }
            });
          }

          // Look for action items
          if (
            lowerText.includes("todo") ||
            lowerText.includes("remind") ||
            lowerText.includes("need to")
          ) {
            const match = text.match(/(?:todo|remind|need to)[^.!?\n]*/i);
            if (match) needsAttention.push(`📋 ${match[0].slice(0, 100)}`);
          }
        }

        // Extract facts from assistant messages
        if (msg.role === "assistant" && text) {
          const lowerText = text.toLowerCase();

          // Look for completions
          ["✅", "done", "created", "updated", "fixed", "deployed"].forEach((keyword) => {
            if (lowerText.includes(keyword)) {
              const lines = text.split("\n").filter((l) => l.toLowerCase().includes(keyword));
              lines.slice(0, 2).forEach((line) => {
                if (line.length > 5 && line.length < 150) {
                  facts.push(line.trim().slice(0, 100));
                }
              });
            }
          });
        }
      });

      // Generate summary from recent messages
      let summary = "No activity yet.";
      const userMessages = messages.filter((m) => m.role === "user");
      const assistantMessages = messages.filter((m) => m.role === "assistant");
      let topics = [];

      if (messages.length > 0) {
        summary = `${messages.length} messages (${userMessages.length} user, ${assistantMessages.length} assistant). `;

        // Identify main topics from all text using pattern matching
        const allText = messages.map((m) => m.text).join(" ");
        topics = detectTopics(allText);

        if (topics.length > 0) {
          summary += `Topics: ${topics.join(", ")}.`;
        }
      }

      // Convert tools to array
      const toolsArray = Object.entries(tools)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      // Calculate last active time
      const ageMs = sessionInfo.ageMs || 0;
      const lastActive =
        ageMs < 60000
          ? "Just now"
          : ageMs < 3600000
            ? `${Math.round(ageMs / 60000)} minutes ago`
            : ageMs < 86400000
              ? `${Math.round(ageMs / 3600000)} hours ago`
              : `${Math.round(ageMs / 86400000)} days ago`;

      // Determine readable channel name
      // Priority: groupChannel > displayName > parsed from key > fallback
      let channelDisplay = "Other";
      if (sessionInfo.groupChannel) {
        channelDisplay = sessionInfo.groupChannel;
      } else if (sessionInfo.displayName) {
        channelDisplay = sessionInfo.displayName;
      } else if (sessionKey.includes("slack")) {
        // Try to parse channel name from key
        const parts = sessionKey.split(":");
        const channelIdx = parts.indexOf("channel");
        if (channelIdx >= 0 && parts[channelIdx + 1]) {
          const channelId = parts[channelIdx + 1].toLowerCase();
          channelDisplay = channelMap[channelId] || `#${channelId}`;
        } else {
          channelDisplay = "Slack";
        }
      } else if (sessionKey.includes("telegram")) {
        channelDisplay = "Telegram";
      }

      // Use parsed totals or fallback to session info
      const finalTotalTokens = totalInputTokens + totalOutputTokens || sessionInfo.totalTokens || 0;
      const finalInputTokens = totalInputTokens || sessionInfo.inputTokens || 0;
      const finalOutputTokens = totalOutputTokens || sessionInfo.outputTokens || 0;

      // Format model name (strip prefix)
      const modelDisplay = (detectedModel || sessionInfo.model || "-")
        .replace("anthropic/", "")
        .replace("openai/", "");

      return {
        key: sessionKey,
        kind: sessionInfo.kind,
        channel: channelDisplay,
        groupChannel: sessionInfo.groupChannel || channelDisplay,
        model: modelDisplay,
        tokens: finalTotalTokens,
        inputTokens: finalInputTokens,
        outputTokens: finalOutputTokens,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
        estCost: totalCost > 0 ? `$${totalCost.toFixed(4)}` : null,
        lastActive,
        summary,
        topics, // Array of detected topics
        facts: [...new Set(facts)].slice(0, 8),
        needsAttention: [...new Set(needsAttention)].slice(0, 5),
        tools: toolsArray.slice(0, 10),
        messages: messages
          .slice(-15)
          .reverse()
          .map((m) => ({
            role: m.role,
            text: m.text.slice(0, 500),
          })),
      };
    } catch (e) {
      console.error("Failed to get session detail:", e.message);
      return { error: e.message };
    }
  }

  return {
    findTranscriptPath,
    getSessionOriginator,
    getSessionTopic,
    mapSession,
    refreshSessionsCache,
    getSessionsCached,
    getRawSessionsCached,
    getSessions,
    readTranscript,
    getSessionDetail,
    parseSessionLabel,
  };
}

module.exports = {
  createSessionsModule,
  CHANNEL_MAP,
  DEFAULT_CHANNEL_MAP,
  loadChannelMap,
  parseSessionLabel,
};
