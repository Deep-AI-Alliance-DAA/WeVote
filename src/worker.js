import { DurableObject } from "cloudflare:workers";

const SHARDS = 128;
const MAX_OPTIONS = 20;
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
    !Array.isArray(options) || options.length < 2 || options.length > MAX_OPTIONS ||
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

function timestamp(value) {
  return typeof value === "number" ? value : Date.parse(value);
}

function phase(config, now = Date.now()) {
  if (now < timestamp(config.opensAt)) return "pending";
  if (now >= timestamp(config.closesAt)) return "closed";
  return "open";
}

function resultsCacheControl(config, state, updatedAt) {
  let seconds = state === "closed" ? 60 : 10;
  if (state !== "closed" && updatedAt) seconds = Math.max(1, Math.floor((timestamp(updatedAt) + 10_000 - Date.now()) / 1000));
  const boundary = state === "pending" ? timestamp(config.opensAt) : timestamp(config.closesAt);
  if (state !== "closed") seconds = Math.max(1, Math.min(seconds, Math.floor((boundary - Date.now()) / 1000)));
  return `public, max-age=${seconds}`;
}

const eventPattern = /^[a-f0-9]{24}$/;
// Configurations are immutable. A bounded per-isolate cache keeps vote requests
// off the event coordinator after their first lookup. Never cache unknown IDs.
const eventConfigs = new Map();

function coordinator(env, id) {
  return env.EVENT_COORDINATOR.getByName(id);
}

async function eventConfig(env, id) {
  if (!eventPattern.test(id)) return null;
  if (eventConfigs.has(id)) return eventConfigs.get(id);
  const lookup = (async () => {
    const object = coordinator(env, id);
    const authoritative = await object.getConfig();
    if (authoritative) return authoritative;
    // Bootstrap older KV events. New links read durable config immediately.
    const legacy = await env.EVENTS.get(`event:${id}`, "json");
    return legacy ? object.initialize(legacy) : null;
  })();
  if (eventConfigs.size >= 256) eventConfigs.delete(eventConfigs.keys().next().value);
  eventConfigs.set(id, lookup);
  try {
    const config = await lookup;
    if (!config) eventConfigs.delete(id);
    return config;
  } catch (error) {
    eventConfigs.delete(id);
    throw error;
  }
}

class RequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function readJson(request) {
  const limit = 8192;
  if (Number(request.headers.get("Content-Length") || 0) > limit) throw new RequestError("資料過大。", 413);
  if (!request.body) throw new RequestError("資料格式錯誤。", 400);
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new RequestError("資料過大。", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestError("資料格式錯誤。", 400);
  }
}

function randomHex(bytes = 16) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cookieValue(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  const item = cookies.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item?.slice(name.length + 1) || null;
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function voterFromCookie(request, config, secret) {
  const cookie = cookieValue(request, `wv_${config.id}`);
  if (!cookie || !/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(cookie)) return null;
  const [id, signature] = cookie.split(".");
  const expected = await hmac(secret, `${config.id}:${id}`);
  // Both values are fixed length and hexadecimal; a constant-time comparison
  // avoids leaking information about the signature.
  let mismatch = 0;
  for (let i = 0; i < 64; i++) mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  if (mismatch) return null;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${config.id}:${id}`));
  const bytes = new Uint8Array(digest);
  const voterHash = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { voterHash, shard: bytes[0] % SHARDS };
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
  const before = phase(config);
  let tally = await readResults(env, config);
  const state = phase(config);
  if (state !== before) tally = await readResults(env, config);
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
  }, 200, resultsCacheControl(config, state));
}

async function eventResults(request, env, id) {
  if (new URL(request.url).search || request.headers.has("Authorization")) return json({ error: "請使用公開結果網址。" }, 400);
  const config = await eventConfig(env, id);
  if (!config) return json({ error: "搵唔到呢個活動。" }, 404);
  const tally = await coordinator(env, id).snapshot();
  const state = tally.phase;
  return json({
    pollId: config.id,
    name: config.name,
    question: config.question,
    options: config.options,
    opensAt: config.opensAt,
    closesAt: config.closesAt,
    phase: state,
    turnout: tally.turnout,
    counts: state === "closed" ? tally.counts : null,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    updatedAt: tally.updatedAt,
  }, 200, resultsCacheControl(config, state, tally.updatedAt));
}

async function eventIdentity(request, env, id) {
  const config = await eventConfig(env, id);
  if (!config) return json({ error: "搵唔到呢個活動。" }, 404);
  if (phase(config) === "closed") return json({ error: "投票已截止。" }, 403);
  if (await voterFromCookie(request, config, env.VOTE_SIGNING_KEY)) return json({ ready: true });
  const randomId = randomHex();
  const signature = await hmac(env.VOTE_SIGNING_KEY, `${id}:${randomId}`);
  const seconds = Math.max(1, Math.ceil((timestamp(config.closesAt) - Date.now()) / 1000));
  const response = json({ ready: true });
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  response.headers.set("Set-Cookie", `wv_${id}=${randomId}.${signature}; Max-Age=${seconds}; Path=/api/events/${id}; HttpOnly${secure}; SameSite=Lax`);
  return response;
}

async function eventVote(request, env, id) {
  const config = await eventConfig(env, id);
  if (!config) return json({ error: "搵唔到呢個活動。" }, 404);
  if (phase(config) !== "open") return json({ error: "投票目前未開放。" }, 403);
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "來源不符。" }, 403);
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "請提交 JSON。" }, 415);
  const body = await readJson(request);
  if (!config.options.some((option) => option.id === body?.optionId)) return json({ error: "選項無效。" }, 400);
  const voter = await voterFromCookie(request, config, env.VOTE_SIGNING_KEY);
  if (!voter) return json({ error: "瀏覽器投票識別已失效，請重新整理頁面。" }, 403);
  let human;
  try { human = await checkTurnstile(body.turnstileToken, env, request); }
  catch { return json({ error: "驗證暫時失敗，請稍後再試。" }, 503); }
  if (!human) return json({ error: "人機驗證失敗，請重新驗證。" }, 403);
  if (phase(config) !== "open") return json({ error: "投票目前未開放。" }, 403);
  const response = await shard(env, id, voter.shard).fetch("https://shard.internal/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voterHash: voter.voterHash, optionId: body.optionId, createdAt: Date.now(), closesAt: timestamp(config.closesAt) }),
  });
  const result = await response.json();
  return json(result, response.status);
}

async function adminEvents(request, env) {
  const provided = request.headers.get("Authorization")?.replace(/^Bearer /, "");
  if (!await sameSecret(provided, env.ADMIN_DASHBOARD_KEY)) return json({ error: "管理密鑰無效。" }, 401);
  if (request.method === "GET") {
    const list = await env.EVENTS.list({ prefix: "event:", limit: 1000 });
    const events = list.keys.map((key) => key.metadata).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json({ events, hasMore: !list.list_complete, publicBaseUrl: env.PUBLIC_BASE_URL || new URL(request.url).origin });
  }
  if (request.method !== "POST") return json({ error: "方法無效。" }, 405);
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "來源不符。" }, 403);
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "請提交 JSON。" }, 415);
  const input = await readJson(request);
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const question = typeof input?.question === "string" ? input.question.trim() : "";
  const labels = input?.options;
  const opensAt = Date.parse(input?.opensAt || "");
  const closesAt = Date.parse(input?.closesAt || "");
  if (!name || name.length > 100 || !question || question.length > 300 ||
      !Array.isArray(labels) || labels.length < 2 || labels.length > MAX_OPTIONS ||
      labels.some((label) => typeof label !== "string" || !label.trim() || label.trim().length > 100) ||
      !Number.isFinite(opensAt) || !Number.isFinite(closesAt) || closesAt <= Math.max(opensAt, Date.now()) ||
      closesAt - opensAt > 90 * 86400_000) return json({ error: "請檢查活動名稱、題目、選項同時間。" }, 400);
  const id = randomHex(12);
  const event = {
    id, name, question,
    options: labels.map((label, index) => ({ id: `o${index + 1}`, label: label.trim() })),
    opensAt: new Date(opensAt).toISOString(),
    closesAt: new Date(closesAt).toISOString(),
    createdAt: new Date().toISOString(),
    mode: "public-link",
  };
  const object = coordinator(env, id);
  await object.initialize(event);
  const catalogPending = !await object.publishCatalog();
  return json({ event, catalogPending, publicBaseUrl: env.PUBLIC_BASE_URL || new URL(request.url).origin }, 201);
}

async function vote(request, env) {
  const config = settings(env);
  if (phase(config) !== "open") return json({ error: "投票目前未開放。" }, 403);
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "來源不符。" }, 403);
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "請提交 JSON。" }, 415);
  const body = await readJson(request);
  const optionId = body?.optionId;
  if (!config.options.some((option) => option.id === optionId)) return json({ error: "選項無效。" }, 400);
  const voter = await voterFromTicket(body?.ticket, config, env.VOTE_SIGNING_KEY);
  if (!voter) return json({ error: "投票連結無效或已過期。" }, 403);
  let human;
  try { human = await checkTurnstile(body?.turnstileToken, env, request); }
  catch { return json({ error: "驗證暫時失敗，請稍後再試。" }, 503); }
  if (!human) return json({ error: "人機驗證失敗，請重新驗證。" }, 403);
  if (phase(config) !== "open") return json({ error: "投票目前未開放。" }, 403);
  const response = await shard(env, config.id, voter.shard).fetch("https://shard.internal/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voterHash: voter.voterHash, optionId, createdAt: Date.now(), closesAt: timestamp(config.closesAt) }),
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
  return exportPollShard(request, env, config.id);
}

async function exportEventShard(request, env, id) {
  if (!await sameSecret(request.headers.get("Authorization")?.replace(/^Bearer /, ""), env.ADMIN_DASHBOARD_KEY)) return json({ error: "管理密鑰無效。" }, 401);
  const config = await eventConfig(env, id);
  if (!config) return json({ error: "搵唔到呢個活動。" }, 404);
  if (phase(config) !== "closed") return json({ error: "投票結束後先可以匯出。" }, 403);
  return exportPollShard(request, env, id);
}

async function exportPollShard(request, env, id) {
  const url = new URL(request.url);
  if (!url.searchParams.has("shard")) return json({ error: "Shard 無效。" }, 400);
  const index = Number(url.searchParams.get("shard"));
  if (!Number.isInteger(index) || index < 0 || index >= SHARDS) return json({ error: "Shard 無效。" }, 400);
  const after = url.searchParams.get("after") || "";
  if (after && !/^[a-f0-9]{64}$/.test(after)) return json({ error: "Cursor 無效。" }, 400);
  const response = await shard(env, id, index).fetch(`https://shard.internal/export?after=${after}`);
  return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/admin/events") return await adminEvents(request, env);
      const eventExport = /^\/api\/admin\/events\/([a-f0-9]{24})\/export$/.exec(url.pathname);
      if (eventExport) return request.method === "GET" ? await exportEventShard(request, env, eventExport[1]) : json({ error: "方法無效。" }, 405);
      const eventRoute = /^\/api\/events\/([a-f0-9]{24})\/(results|identity|vote)$/.exec(url.pathname);
      if (eventRoute) {
        const [, id, action] = eventRoute;
        if (action === "results" && request.method === "GET") return await eventResults(request, env, id);
        if (action === "identity" && request.method === "GET") return await eventIdentity(request, env, id);
        if (action === "vote" && request.method === "POST") return await eventVote(request, env, id);
        return json({ error: "方法無效。" }, 405);
      }
      if (url.pathname === "/api/results") return request.method === "GET" ? await results(request, env) : json({ error: "方法無效。" }, 405);
      if (url.pathname === "/api/vote") return request.method === "POST" ? await vote(request, env) : json({ error: "方法無效。" }, 405);
      if (url.pathname === "/api/admin/export") return request.method === "GET" ? await exportShard(request, env) : json({ error: "方法無效。" }, 405);
      return json({ error: "找不到頁面。" }, 404);
    } catch (error) {
      if (error instanceof RequestError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ event: "request_failed", message: error instanceof Error ? error.message : "unknown" }));
      return json({ error: "系統暫時未能處理請求。" }, 503);
    }
  },
};

export class EventCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.snapshotValue = null;
    this.refreshPromise = null;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec("CREATE TABLE IF NOT EXISTS event_config (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), config_json TEXT NOT NULL)");
    });
  }

  getConfig() {
    const row = this.sql.exec("SELECT config_json FROM event_config WHERE singleton = 1").toArray()[0];
    return row ? JSON.parse(row.config_json) : null;
  }

  async initialize(config) {
    const inserted = this.sql.exec("INSERT OR IGNORE INTO event_config (singleton, config_json) VALUES (1, ?)", JSON.stringify(config));
    // Persist the retry before returning. A request interrupted after creation
    // still gets its catalog entry once the alarm runs.
    if (inserted.rowsWritten) await this.ctx.storage.setAlarm(Date.now() + 5000);
    return this.getConfig();
  }

  async publishCatalog() {
    const config = this.getConfig();
    if (!config) return false;
    const { id, name, opensAt, closesAt, createdAt } = config;
    try {
      await this.env.EVENTS.put(`event:${id}`, JSON.stringify(config), { metadata: { id, name, opensAt, closesAt, createdAt } });
    } catch {
      console.error(JSON.stringify({ event: "event_catalog_retry", eventId: id }));
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return false;
    }
    await this.ctx.storage.deleteAlarm();
    return true;
  }

  async alarm() {
    await this.publishCatalog();
  }

  async snapshot() {
    const config = this.getConfig();
    if (!config) throw new Error("Event configuration unavailable.");
    while (true) {
      const state = phase(config);
      if (this.snapshotValue?.phase === state && Date.now() - this.snapshotValue.refreshedAt < 10_000) {
        return this.snapshotValue;
      }
      // Every edge location reaches this same event object. Concurrent cache
      // misses share one aggregation rather than each reading all vote shards.
      if (!this.refreshPromise) {
        this.refreshPromise = readResults(this.env, config).then((tally) => {
          const refreshedAt = Date.now();
          this.snapshotValue = { ...tally, phase: state, refreshedAt, updatedAt: new Date(refreshedAt).toISOString() };
          return this.snapshotValue;
        }).finally(() => { this.refreshPromise = null; });
      }
      const snapshot = await this.refreshPromise;
      // A scan started before closing may have read early shards too soon.
      // Scan again once when the opening/closing boundary changed during it.
      if (snapshot.phase === phase(config)) return snapshot;
    }
  }
}

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
      if (data.closesAt !== undefined && (!Number.isFinite(data.closesAt) || Date.now() >= data.closesAt)) return json({ error: "投票已截止。" }, 403);
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
