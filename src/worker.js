import { DurableObject } from "cloudflare:workers";

const SHARDS = 128;
const encoder = new TextEncoder();

function json(body, status = 200, cacheControl = "no-store") {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": cacheControl, "X-Content-Type-Options": "nosniff" },
  });
}

function settings(env) {
  const options = JSON.parse(env.POLL_OPTIONS_JSON || "null");
  const opensAt = Date.parse(env.POLL_OPENS_AT || "");
  const closesAt = Date.parse(env.POLL_CLOSES_AT || "");
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(env.POLL_ID || "") ||
    !env.POLL_QUESTION ||
    !Array.isArray(options) || options.length < 2 || options.length > 6 ||
    options.some((option) => !/^[a-zA-Z0-9_-]{1,32}$/.test(option?.id || "") || typeof option?.label !== "string" || !option.label.trim()) ||
    new Set(options.map((option) => option.id)).size !== options.length ||
    !Number.isFinite(opensAt) || !Number.isFinite(closesAt) || opensAt >= closesAt ||
    !env.VOTE_SIGNING_KEY || env.VOTE_SIGNING_KEY.length < 32 ||
    !env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY
  ) {
    throw new Error("Poll configuration is incomplete or invalid.");
  }
  return {
    id: env.POLL_ID,
    question: env.POLL_QUESTION,
    options,
    opensAt,
    closesAt,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
  };
}

function phase(config, now = Date.now()) {
  if (now < config.opensAt) return "pending";
  if (now >= config.closesAt) return "closed";
  return "open";
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(bytes, (char) => char.charCodeAt(0));
}

async function voterFromTicket(ticket, config, secret) {
  if (typeof ticket !== "string" || ticket.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket)) return null;
  try {
    const [payload, signature] = ticket.split(".");
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("HMAC", key, fromBase64Url(signature), encoder.encode(payload))) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (claims.p !== config.id || !/^[a-f0-9]{32}$/.test(claims.v || "") || !Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${claims.p}:${claims.v}`));
    const voterHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { voterHash, shard: new Uint8Array(digest)[0] % SHARDS };
  } catch {
    return null;
  }
}

async function checkTurnstile(token, env, request) {
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.set("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Turnstile verification unavailable.");
  const result = await response.json();
  if (!result.success) return false;
  const host = new URL(request.url).hostname;
  const testKey = env.TURNSTILE_SITE_KEY === "1x00000000000000000000AA";
  if (testKey && (host === "localhost" || host === "127.0.0.1")) return true;
  return result.hostname === host && result.action === "vote";
}

function shard(env, pollId, index) {
  const id = env.VOTE_SHARD.idFromName(`${pollId}:${index}`);
  return env.VOTE_SHARD.get(id);
}

async function readResults(env, config) {
  const counts = Object.fromEntries(config.options.map((option) => [option.id, 0]));
  let turnout = 0;
  // A cache miss reads each small shard once. Keep subrequests bounded.
  for (let start = 0; start < SHARDS; start += 16) {
    const batch = await Promise.all(Array.from({ length: Math.min(16, SHARDS - start) }, async (_, offset) => {
      const response = await shard(env, config.id, start + offset).fetch("https://shard.internal/count");
      if (!response.ok) throw new Error("Result shard unavailable.");
      return response.json();
    }));
    for (const data of batch) {
      turnout += data.turnout;
      for (const [id, total] of Object.entries(data.counts)) {
        if (id in counts) counts[id] += total;
      }
    }
  }
  return { turnout, counts };
}

async function results(request, env) {
  // Public results have one canonical cache key; ignore attempts to force a
  // separate shard fan-out with arbitrary query parameters or auth headers.
  if (new URL(request.url).search || request.headers.has("Authorization")) return json({ error: "請使用公開結果網址。" }, 400);
  const config = settings(env);
  const state = phase(config);
  const tally = await readResults(env, config);
  return json({
    pollId: config.id,
    question: config.question,
    options: config.options,
    opensAt: new Date(config.opensAt).toISOString(),
    closesAt: new Date(config.closesAt).toISOString(),
    phase: state,
    turnout: tally.turnout,
    counts: state === "closed" ? tally.counts : null,
    turnstileSiteKey: config.turnstileSiteKey,
    updatedAt: new Date().toISOString(),
  }, 200, `public, max-age=${state === "closed" ? 60 : 10}`);
}

async function vote(request, env) {
  const config = settings(env);
  if (phase(config) !== "open") return json({ error: "投票目前未開放。" }, 403);
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "來源不符。" }, 403);
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "請提交 JSON。" }, 415);
  if (Number(request.headers.get("Content-Length") || 0) > 8192) return json({ error: "資料過大。" }, 413);
  let body;
  try { body = await request.json(); } catch { return json({ error: "資料格式錯誤。" }, 400); }
  const optionId = body?.optionId;
  if (!config.options.some((option) => option.id === optionId)) return json({ error: "選項無效。" }, 400);
  const voter = await voterFromTicket(body?.ticket, config, env.VOTE_SIGNING_KEY);
  if (!voter) return json({ error: "投票連結無效或已過期。" }, 403);
  let human;
  try { human = await checkTurnstile(body?.turnstileToken, env, request); }
  catch { return json({ error: "驗證暫時失敗，請稍後再試。" }, 503); }
  if (!human) return json({ error: "人機驗證失敗，請重新驗證。" }, 403);
  const response = await shard(env, config.id, voter.shard).fetch("https://shard.internal/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voterHash: voter.voterHash, optionId, createdAt: Date.now() }),
  });
  const result = await response.json();
  if (!response.ok) return json(result, response.status);
  return json(result);
}

async function sameSecret(provided, expected) {
  if (!expected || expected.length < 32 || !provided) return false;
  const [a, b] = await Promise.all([provided, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  let diff = 0;
  const left = new Uint8Array(a), right = new Uint8Array(b);
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function exportShard(request, env) {
  const authorized = await sameSecret(request.headers.get("Authorization")?.replace(/^Bearer /, ""), env.ADMIN_EXPORT_KEY);
  if (!authorized) return json({ error: "未獲授權。" }, 401);
  const config = settings(env);
  if (phase(config) !== "closed") return json({ error: "投票結束後先可以匯出。" }, 403);
  const url = new URL(request.url);
  const index = Number(url.searchParams.get("shard"));
  if (!Number.isInteger(index) || index < 0 || index >= SHARDS) return json({ error: "Shard 無效。" }, 400);
  const after = url.searchParams.get("after") || "";
  if (after && !/^[a-f0-9]{64}$/.test(after)) return json({ error: "Cursor 無效。" }, 400);
  const response = await shard(env, config.id, index).fetch(`https://shard.internal/export?after=${after}`);
  return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/results" && request.method === "GET") return await results(request, env);
      if (url.pathname === "/api/vote" && request.method === "POST") return await vote(request, env);
      if (url.pathname === "/api/admin/export" && request.method === "GET") return await exportShard(request, env);
      return json({ error: "找不到頁面。" }, 404);
    } catch (error) {
      console.error(JSON.stringify({ event: "request_failed", message: error instanceof Error ? error.message : "unknown" }));
      return json({ error: "系統暫時未能處理請求。" }, 503);
    }
  },
};

export class VoteShard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS votes (voter_hash TEXT PRIMARY KEY, option_id TEXT NOT NULL, created_at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS counts (option_id TEXT PRIMARY KEY, total INTEGER NOT NULL)");
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/vote" && request.method === "POST") {
      const data = await request.json();
      if (!/^[a-f0-9]{64}$/.test(data?.voterHash || "") || !/^[a-zA-Z0-9_-]{1,32}$/.test(data?.optionId || "") || !Number.isSafeInteger(data?.createdAt)) return json({ error: "資料無效。" }, 400);
      const inserted = this.ctx.storage.transactionSync(() => {
        const write = this.sql.exec("INSERT OR IGNORE INTO votes (voter_hash, option_id, created_at) VALUES (?, ?, ?)", data.voterHash, data.optionId, data.createdAt);
        if (write.rowsWritten === 0) return false;
        this.sql.exec("INSERT INTO counts (option_id, total) VALUES (?, 1) ON CONFLICT(option_id) DO UPDATE SET total = total + 1", data.optionId);
        return true;
      });
      await this.ctx.storage.sync();
      if (inserted) return json({ ok: true, recorded: true });
      const original = this.sql.exec("SELECT option_id FROM votes WHERE voter_hash = ?", data.voterHash).one();
      if (original?.option_id === data.optionId) return json({ ok: true, recorded: true, duplicate: true });
      return json({ error: "呢條投票連結已經投咗另一個選項。" }, 409);
    }
    if (url.pathname === "/count" && request.method === "GET") {
      const counts = Object.fromEntries(this.sql.exec("SELECT option_id, total FROM counts").toArray().map((row) => [row.option_id, row.total]));
      const turnout = Object.values(counts).reduce((sum, count) => sum + count, 0);
      return json({ turnout, counts });
    }
    if (url.pathname === "/export" && request.method === "GET") {
      const after = url.searchParams.get("after") || "";
      if (after && !/^[a-f0-9]{64}$/.test(after)) return json({ error: "Cursor 無效。" }, 400);
      const rows = this.sql.exec("SELECT voter_hash, option_id, created_at FROM votes WHERE voter_hash > ? ORDER BY voter_hash LIMIT 500", after).toArray();
      return json({ rows, next: rows.length === 500 ? rows[rows.length - 1].voter_hash : null });
    }
    return json({ error: "找不到頁面。" }, 404);
  }
}
