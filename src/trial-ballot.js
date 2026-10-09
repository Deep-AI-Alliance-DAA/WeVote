// Trial ballots stay in their event coordinator. This is a storage cap, not a
// claim that a single Durable Object can serve a particular simultaneous burst.
const MAX_VOTES = 10_000;
const MAX_HOURS = 24;
const SHARDS = 128;
const PAGE_SIZE = 500;
const HASH = /^[a-f0-9]{64}$/;
const OPTION = /^[a-zA-Z0-9_-]{1,32}$/;

function failed(status, error, code) {
  return { status, body: { error, ...(code ? { code } : {}) } };
}

function unavailable() {
  return Object.assign(new Error("試用活動設定無效，暫時未能投票。"), { status: 503, code: "TRIAL_CONFIG_INVALID" });
}

function timestamp(value) {
  if (typeof value === "number") return value;
  return typeof value === "string" && value.length <= 64 ? Date.parse(value) : NaN;
}

function trialConfig(config) {
  const { voteLimit, maxDurationHours } = config?.trial || {};
  const opensAt = timestamp(config?.opensAt);
  const closesAt = timestamp(config?.closesAt);
  const version = config?.ballotVersion ?? "legacy";
  const options = config?.options;
  if (!Number.isSafeInteger(voteLimit) || voteLimit < 1 || voteLimit > MAX_VOTES ||
      !Number.isSafeInteger(maxDurationHours) || maxDurationHours < 1 || maxDurationHours > MAX_HOURS ||
      !Number.isSafeInteger(opensAt) || !Number.isSafeInteger(closesAt) || closesAt <= opensAt ||
      closesAt - opensAt > maxDurationHours * 3_600_000 ||
      (config.lifecycle !== undefined && !["draft", "published"].includes(config.lifecycle)) ||
      typeof version !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(version) ||
      !Array.isArray(options) || options.length < 2 || options.length > 20 ||
      options.some(option => typeof option?.id !== "string" || !OPTION.test(option.id)) ||
      new Set(options.map(option => option.id)).size !== options.length) throw unavailable();
  return { voteLimit, opensAt, closesAt, version, optionIds: options.map(option => option.id) };
}

function total(sql, limit) {
  const row = sql.exec("SELECT total FROM trial_totals WHERE singleton = 1").toArray()[0];
  if (!Number.isSafeInteger(row?.total) || row.total < 0 || row.total > limit) throw unavailable();
  return row.total;
}

export function initTrialBallot(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS trial_votes (voter_hash TEXT PRIMARY KEY CHECK(length(voter_hash) = 64 AND voter_hash NOT GLOB '*[^0-9a-f]*'), shard INTEGER NOT NULL CHECK(shard >= 0 AND shard < 128), option_id TEXT NOT NULL, created_at INTEGER NOT NULL)");
  sql.exec("CREATE INDEX IF NOT EXISTS trial_votes_shard_hash ON trial_votes (shard, voter_hash)");
  sql.exec("CREATE TABLE IF NOT EXISTS trial_counts (option_id TEXT PRIMARY KEY, total INTEGER NOT NULL CHECK(total >= 0 AND total <= 10000))");
  sql.exec("CREATE TABLE IF NOT EXISTS trial_totals (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), total INTEGER NOT NULL CHECK(total >= 0 AND total <= 10000))");
  sql.exec("INSERT OR IGNORE INTO trial_totals (singleton, total) VALUES (1, 0)");
}

export async function recordTrialVote(ctx, config, data, now = Date.now()) {
  let ballot;
  try { ballot = trialConfig(config); }
  catch { return failed(503, "試用活動設定無效，暫時未能投票。", "TRIAL_CONFIG_INVALID"); }
  if (!Number.isSafeInteger(now) || now < 0) return failed(400, "資料無效。");
  if (config.lifecycle === "draft" || now < ballot.opensAt || now >= ballot.closesAt) return failed(403, "投票目前未開放。");
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      typeof data.voterHash !== "string" || !HASH.test(data.voterHash) ||
      typeof data.optionId !== "string" || !OPTION.test(data.optionId) ||
      typeof data.ballotVersion !== "string" || data.ballotVersion.length > 64) return failed(400, "資料無效。");
  if (data.ballotVersion !== ballot.version) return failed(409, "投票內容已更新，請重新整理後再投票。");
  if (!ballot.optionIds.includes(data.optionId)) return failed(400, "選項無效。");
  try {
    const sql = ctx.storage.sql;
    const result = ctx.storage.transactionSync(() => {
      const original = sql.exec("SELECT option_id FROM trial_votes WHERE voter_hash = ?", data.voterHash).toArray()[0];
      if (original) {
        return original.option_id === data.optionId
          ? { status: 200, body: { ok: true, recorded: true, duplicate: true } }
          : failed(409, "呢條投票連結已經投咗另一個選項。");
      }
      const turnout = total(sql, ballot.voteLimit);
      if (turnout >= ballot.voteLimit) {
        return failed(403, `試用活動已達 ${ballot.voteLimit.toLocaleString("en-US")} 票上限。`, "TRIAL_VOTE_LIMIT");
      }
      // All eligibility/cap checks and writes stay synchronous in one atomic
      // transaction. Only the authoritative server timestamp is stored.
      sql.exec("INSERT INTO trial_votes (voter_hash, shard, option_id, created_at) VALUES (?, ?, ?, ?)", data.voterHash, Number.parseInt(data.voterHash.slice(0, 2), 16) % SHARDS, data.optionId, now);
      sql.exec("INSERT INTO trial_counts (option_id, total) VALUES (?, 1) ON CONFLICT(option_id) DO UPDATE SET total = total + 1", data.optionId);
      sql.exec("UPDATE trial_totals SET total = total + 1 WHERE singleton = 1");
      return { status: 200, body: { ok: true, recorded: true } };
    });
    // A committed-but-unconfirmed request returns 503; a retry reads the same
    // hash and confirms durability before returning idempotent success.
    if (result.status === 200) await ctx.storage.sync();
    return result;
  } catch {
    return failed(503, "投票儲存暫時未能確認，請重試。", "TRIAL_STORAGE_UNCONFIRMED");
  }
}

export function readTrialResults(sql, config) {
  const ballot = trialConfig(config);
  const turnout = total(sql, ballot.voteLimit);
  const counts = Object.fromEntries(ballot.optionIds.map(id => [id, 0]));
  for (const row of sql.exec("SELECT option_id, total FROM trial_counts").toArray()) {
    if (!Object.hasOwn(counts, row.option_id) || !Number.isSafeInteger(row.total) || row.total < 0) throw unavailable();
    counts[row.option_id] = row.total;
  }
  if (Object.values(counts).reduce((sum, count) => sum + count, 0) !== turnout) throw unavailable();
  return { turnout, counts };
}

export function exportTrialVotes(sql, config, { index, after = "" } = {}) {
  trialConfig(config);
  if (!Number.isInteger(index) || index < 0 || index >= SHARDS || typeof after !== "string" || (after && !HASH.test(after))) {
    throw Object.assign(new Error("Shard 或 Cursor 無效。"), { status: 400 });
  }
  const rows = sql.exec("SELECT voter_hash, option_id, created_at FROM trial_votes WHERE shard = ? AND voter_hash > ? ORDER BY voter_hash LIMIT 500", index, after).toArray();
  return { rows, next: rows.length === PAGE_SIZE ? rows[rows.length - 1].voter_hash : null };
}
