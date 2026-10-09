import { DurableObject } from "cloudflare:workers";

const encoder = new TextEncoder();
const ACCOUNT_ID = /^[a-f0-9]{24}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const SESSION_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_ACCOUNTS = 100;
const SAFE_COLUMNS = "id, name, role, disabled, created_at, self_registered";
const ROOT = Object.freeze({ id: "root", name: "系統擁有人", role: "owner", disabled: false, createdAt: null, selfRegistered: false });

function randomHex(bytes = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeAccount(row) {
  return row ? { id: row.id, name: row.name, role: row.role, disabled: Boolean(row.disabled), createdAt: row.created_at, selfRegistered: Boolean(row.self_registered) } : null;
}

function accountId(id) {
  if (typeof id !== "string" || !ACCOUNT_ID.test(id)) throw new Error("帳戶編號無效。");
  return id;
}

function eventId(id) {
  if (typeof id !== "string" || !ACCOUNT_ID.test(id)) throw new Error("活動編號無效。");
  return id;
}

function accountName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) throw new Error("請填 1–80 字嘅帳戶名稱。");
  return value.trim();
}

function accountRole(value) {
  if (value !== "admin" && value !== "organizer") throw new Error("帳戶角色無效。");
  return value;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function paymentMode(env, id) {
  const mode = /^(?:sk|rk)_(test|live)_/.exec(env.STRIPE_SECRET_KEY || "")?.[1];
  if (mode === "test") return String(env.STRIPE_TEST_ORGANIZER_IDS || "").split(",").map(value => value.trim()).includes(id) ? 0 : null;
  // Removing Checkout configuration does not invalidate already bought live
  // credits. Test balances never become live balances after a key change.
  return 1;
}

// The private Worker owns authorization for these control-plane RPC methods.
// Generated login keys have 256 bits of entropy; these hashes are not a
// password-hashing scheme and must never be used for user-chosen passwords.
export class AdminDirectory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'organizer')),
        disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
        credential_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )`);
      // Existing key accounts stay exempt from the public signup quota.
      if (!this.sql.exec("PRAGMA table_info(accounts)").toArray().some((column) => column.name === "self_registered")) {
        this.sql.exec("ALTER TABLE accounts ADD COLUMN self_registered INTEGER NOT NULL DEFAULT 0 CHECK (self_registered IN (0, 1))");
      }
      this.sql.exec(`CREATE TABLE IF NOT EXISTS oauth_identities (
        provider TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
        subject TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (provider, subject)
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS oauth_flows (
        state_hash TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
        nonce TEXT NOT NULL,
        verifier TEXT,
        redirect_uri TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`);
      this.sql.exec("CREATE INDEX IF NOT EXISTS oauth_flows_expiry ON oauth_flows (expires_at)");
      this.sql.exec(`CREATE TABLE IF NOT EXISTS event_creation_reservations (
        account_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      if (!this.sql.exec("PRAGMA table_info(event_creation_reservations)").toArray().some((column) => column.name === "event_json")) {
        this.sql.exec("ALTER TABLE event_creation_reservations ADD COLUMN event_json TEXT");
      }
      this.sql.exec(`CREATE TABLE IF NOT EXISTS billing_orders (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, request_id TEXT NOT NULL,
        price_id TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL,
        livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)), origin TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'paid', 'expired', 'refunded', 'review', 'failed')),
        expires_at INTEGER NOT NULL, created_at TEXT NOT NULL,
        session_id TEXT, checkout_url TEXT, payment_intent TEXT,
        UNIQUE(account_id, request_id), UNIQUE(session_id, livemode), UNIQUE(payment_intent, livemode)
      )`);
      // SQLite cannot alter a CHECK constraint in place. Atomically replace
      // the old table, preserving its rows, insertion ordering and uniqueness.
      const orderSchema = this.sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'billing_orders'").one().sql;
      if (!orderSchema.includes("'failed'")) {
        ctx.storage.transactionSync(() => {
          this.sql.exec(orderSchema.replace(/CREATE TABLE(?: IF NOT EXISTS)?\s+(?:"billing_orders"|billing_orders)(?=\s*\()/i, "CREATE TABLE billing_orders_with_failed")
            .replace("'review'", "'review', 'failed'"));
          this.sql.exec(`INSERT INTO billing_orders_with_failed
            (rowid, id, account_id, request_id, price_id, amount_minor, currency, livemode, origin, status, expires_at, created_at, session_id, checkout_url, payment_intent)
            SELECT rowid, id, account_id, request_id, price_id, amount_minor, currency, livemode, origin, status, expires_at, created_at, session_id, checkout_url, payment_intent FROM billing_orders`);
          this.sql.exec("DROP TABLE billing_orders");
          this.sql.exec("ALTER TABLE billing_orders_with_failed RENAME TO billing_orders");
        });
      }
      this.sql.exec("CREATE INDEX IF NOT EXISTS billing_orders_account ON billing_orders (account_id, livemode, created_at)");
      this.sql.exec(`CREATE TABLE IF NOT EXISTS billing_checkout_requests (
        account_id TEXT NOT NULL, request_id TEXT NOT NULL, order_id TEXT NOT NULL,
        PRIMARY KEY(account_id, request_id)
      )`);
      this.sql.exec("CREATE INDEX IF NOT EXISTS billing_checkout_requests_order ON billing_checkout_requests (order_id)");
      this.sql.exec(`CREATE TABLE IF NOT EXISTS billing_credits (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL,
        session_id TEXT NOT NULL, payment_intent TEXT NOT NULL,
        livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('available', 'spent', 'revoked')),
        spent_event_id TEXT UNIQUE, created_at TEXT NOT NULL,
        UNIQUE(session_id, livemode), UNIQUE(payment_intent, livemode)
      )`);
      this.sql.exec("CREATE INDEX IF NOT EXISTS billing_credits_available ON billing_credits (account_id, livemode, status)");
      this.sql.exec(`CREATE TABLE IF NOT EXISTS paid_event_reservations (
        account_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE, event_json TEXT NOT NULL, credit_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, PRIMARY KEY(account_id, request_id)
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS billing_payment_reversals (
        payment_intent TEXT NOT NULL, livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
        created_at TEXT NOT NULL, PRIMARY KEY(payment_intent, livemode)
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`);
      this.sql.exec("CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id)");
      this.sql.exec("CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at)");
      this.sql.exec(`CREATE TABLE IF NOT EXISTS event_access (
        event_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        PRIMARY KEY (event_id, account_id)
      )`);
      this.sql.exec("CREATE INDEX IF NOT EXISTS event_access_account ON event_access (account_id, event_id)");
      this.sql.exec(`CREATE TABLE IF NOT EXISTS login_limits (
        ip_hash TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        attempts INTEGER NOT NULL
      )`);
      this.sql.exec("CREATE INDEX IF NOT EXISTS login_limits_window ON login_limits (window_start)");
    });
  }

  async authenticate(key) {
    if (typeof key !== "string" || !TOKEN.test(key)) return null;
    const hash = await digest(key);
    const row = this.sql.exec(`SELECT ${SAFE_COLUMNS} FROM accounts WHERE credential_hash = ? AND disabled = 0`, hash).toArray()[0];
    return safeAccount(row);
  }

  async createSession(principal) {
    const token = randomHex();
    const hash = await digest(token);
    let id;
    if (principal?.id === "root" && principal.role === "owner") {
      id = "root";
    } else {
      id = accountId(principal?.id);
      const row = this.sql.exec("SELECT disabled FROM accounts WHERE id = ?", id).toArray()[0];
      if (!row || row.disabled) throw new Error("登入狀態無效。");
    }
    const now = Date.now();
    this.sql.exec("DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at <= ? LIMIT 100)", now);
    this.sql.exec("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)", hash, id, now + SESSION_MS);
    await this.ctx.storage.sync();
    return token;
  }

  async session(token) {
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const hash = await digest(token);
    const session = this.sql.exec("SELECT account_id FROM sessions WHERE token_hash = ? AND expires_at > ?", hash, Date.now()).toArray()[0];
    if (!session) return null;
    if (session.account_id === "root") return { ...ROOT };
    // Read current account state on every call. Role changes apply immediately
    // and disabled accounts can never keep using an older session.
    const row = this.sql.exec(`SELECT ${SAFE_COLUMNS} FROM accounts WHERE id = ? AND disabled = 0`, session.account_id).toArray()[0];
    return safeAccount(row);
  }

  async logout(token) {
    if (typeof token !== "string" || !TOKEN.test(token)) return;
    const hash = await digest(token);
    this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", hash);
    await this.ctx.storage.sync();
  }

  listAccounts() {
    return this.sql.exec(`SELECT ${SAFE_COLUMNS} FROM accounts ORDER BY created_at, id`).toArray().map(safeAccount);
  }

  async createAccount(input) {
    const name = accountName(input?.name);
    const role = accountRole(input?.role);
    const id = randomHex(12);
    const key = randomHex();
    const hash = await digest(key);
    const createdAt = new Date().toISOString();
    const account = this.ctx.storage.transactionSync(() => {
      const count = this.sql.exec("SELECT COUNT(*) AS total FROM accounts WHERE self_registered = 0").one().total;
      if (count >= MAX_ACCOUNTS) throw new Error("帳戶數量已達 100 個上限。");
      this.sql.exec("INSERT INTO accounts (id, name, role, disabled, credential_hash, created_at) VALUES (?, ?, ?, 0, ?, ?)", id, name, role, hash, createdAt);
      return { id, name, role, disabled: false, createdAt, selfRegistered: false };
    });
    await this.ctx.storage.sync();
    return { account, key };
  }

  async createOAuthFlow(input) {
    const now = Date.now();
    if (!input || !TOKEN.test(input.stateHash) || !["google", "apple"].includes(input.provider) ||
        !TOKEN.test(input.nonce) || (input.provider === "google" ? !TOKEN.test(input.verifier) : input.verifier !== null) ||
        !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + 601_000) throw new Error("登入流程資料無效。");
    let redirect;
    try { redirect = new URL(input.redirectUri); } catch { throw new Error("登入回調網址無效。"); }
    if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.search || redirect.hash ||
        redirect.pathname !== `/api/auth/${input.provider}/callback`) throw new Error("登入回調網址無效。");
    this.sql.exec("DELETE FROM oauth_flows WHERE state_hash IN (SELECT state_hash FROM oauth_flows WHERE expires_at <= ? LIMIT 100)", now);
    this.sql.exec("INSERT INTO oauth_flows (state_hash, provider, nonce, verifier, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      input.stateHash, input.provider, input.nonce, input.verifier, input.redirectUri, input.expiresAt);
    await this.ctx.storage.sync();
  }

  async consumeOAuthFlow(stateHash, provider) {
    if (typeof stateHash !== "string" || !TOKEN.test(stateHash) || !["google", "apple"].includes(provider)) return null;
    const flow = this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec("SELECT nonce, verifier, redirect_uri, expires_at FROM oauth_flows WHERE state_hash = ? AND provider = ?", stateHash, provider).toArray()[0];
      if (!row) return null;
      this.sql.exec("DELETE FROM oauth_flows WHERE state_hash = ?", stateHash);
      return row.expires_at > Date.now() ? { nonce: row.nonce, verifier: row.verifier, redirectUri: row.redirect_uri, expiresAt: row.expires_at } : null;
    });
    await this.ctx.storage.sync();
    return flow;
  }

  async resolveOAuthAccount(input) {
    if (!input || !["google", "apple"].includes(input.provider) || typeof input.subject !== "string" ||
        !input.subject || input.subject.length > 256 || /[\u0000-\u001f\u007f]/.test(input.subject)) throw new Error("登入身份無效。");
    const name = accountName(input.name || "主辦方");
    const id = randomHex(12);
    // Retain the legacy schema without issuing a login key for social signup.
    // The raw random credential is discarded and cannot be derived from its hash.
    const unavailableCredentialHash = await digest(randomHex());
    const createdAt = new Date().toISOString();
    const configuredLimit = Number(this.env.PUBLIC_ORGANIZER_ACCOUNT_LIMIT || 10_000);
    const limit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 && configuredLimit <= 1_000_000 ? configuredLimit : 10_000;
    const account = this.ctx.storage.transactionSync(() => {
      const identity = this.sql.exec("SELECT account_id FROM oauth_identities WHERE provider = ? AND subject = ?", input.provider, input.subject).toArray()[0];
      if (identity) {
        const row = this.sql.exec(`SELECT ${SAFE_COLUMNS} FROM accounts WHERE id = ? AND disabled = 0`, identity.account_id).toArray()[0];
        return safeAccount(row);
      }
      if (this.sql.exec("SELECT COUNT(*) AS total FROM accounts WHERE self_registered = 1").one().total >= limit) return null;
      this.sql.exec("INSERT INTO accounts (id, name, role, disabled, credential_hash, created_at, self_registered) VALUES (?, ?, 'organizer', 0, ?, ?, 1)", id, name, unavailableCredentialHash, createdAt);
      this.sql.exec("INSERT INTO oauth_identities (provider, subject, account_id, created_at) VALUES (?, ?, ?, ?)", input.provider, input.subject, id, createdAt);
      return { id, name, role: "organizer", disabled: false, createdAt, selfRegistered: true };
    });
    await this.ctx.storage.sync();
    return account;
  }

  getCreationQuota(id) {
    if (id === "root") return { limit: null, used: 0, eventId: null, paidCredits: 0, remaining: null, canCreate: true, nextEvent: null };
    accountId(id);
    const account = this.sql.exec("SELECT role, disabled, self_registered FROM accounts WHERE id = ?", id).toArray()[0];
    if (!account || account.disabled) return null;
    const reservation = this.sql.exec("SELECT event_id FROM event_creation_reservations WHERE account_id = ?", id).toArray()[0];
    const limited = Boolean(account.self_registered && account.role !== "admin");
    const mode = paymentMode(this.env, id);
    const paidCredits = mode === null ? 0 : this.sql.exec("SELECT COUNT(*) AS total FROM billing_credits WHERE account_id = ? AND livemode = ? AND status = 'available'", id, mode).one().total;
    const used = reservation ? 1 : 0;
    const remaining = limited ? 1 - used + paidCredits : null;
    return { limit: limited ? 1 : null, used, eventId: reservation?.event_id || null, paidCredits,
      remaining, canCreate: !limited || remaining > 0,
      nextEvent: limited && remaining > 0 ? { kind: used ? "paid-credit" : "free-trial", voteLimit: 10000, maxDurationHours: used ? 168 : 24 } : null };
  }

  lookupSelfRegisteredEvent(id, input) {
    if (id === "root") return null;
    accountId(id);
    if (!input || typeof input.requestId !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(input.requestId) ||
        typeof input.payloadHash !== "string" || !TOKEN.test(input.payloadHash)) throw new Error("活動重試識別無效。");
    const account = this.sql.exec("SELECT role, disabled, self_registered FROM accounts WHERE id = ?", id).toArray()[0];
    if (!account || account.disabled) return { error: "unauthorized" };
    if (!account.self_registered || account.role === "admin") return null;
    const existing = this.sql.exec(`SELECT request_id, payload_hash, event_id FROM event_creation_reservations WHERE account_id = ? AND request_id = ?
      UNION ALL SELECT request_id, payload_hash, event_id FROM paid_event_reservations WHERE account_id = ? AND request_id = ?`, id, input.requestId, id, input.requestId).toArray()[0];
    if (!existing) return this.getCreationQuota(id).canCreate ? null : { error: "quota_exceeded" };
    if (existing.payload_hash !== input.payloadHash) return { error: "idempotency_conflict" };
    return { eventId: existing.event_id, reused: true };
  }

  getReservedEvent(id, requestId) {
    if (id === "root") return null;
    accountId(id);
    const account = this.sql.exec("SELECT disabled FROM accounts WHERE id = ?", id).toArray()[0];
    if (!account || account.disabled) return null;
    const row = requestId ? this.sql.exec(`SELECT event_json FROM event_creation_reservations WHERE account_id = ? AND request_id = ?
      UNION ALL SELECT event_json FROM paid_event_reservations WHERE account_id = ? AND request_id = ?`, id, requestId, id, requestId).toArray()[0]
      : this.sql.exec("SELECT event_json FROM event_creation_reservations WHERE account_id = ?", id).toArray()[0];
    return row?.event_json ? JSON.parse(row.event_json) : null;
  }

  getCreationReservations(id) {
    if (id === "root") return [];
    accountId(id);
    const account = this.sql.exec("SELECT disabled FROM accounts WHERE id = ?", id).toArray()[0];
    if (!account || account.disabled) return [];
    return this.sql.exec(`SELECT request_id, event_id, event_json FROM event_creation_reservations WHERE account_id = ?
      UNION ALL SELECT request_id, event_id, event_json FROM paid_event_reservations WHERE account_id = ?`, id, id).toArray()
      .map(row => ({ requestId: row.request_id, eventId: row.event_id, event: row.event_json ? JSON.parse(row.event_json) : null }));
  }

  async reserveSelfRegisteredEvent(id, input) {
    if (id !== "root") accountId(id);
    if (!input || typeof input.requestId !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(input.requestId) ||
        typeof input.payloadHash !== "string" || !TOKEN.test(input.payloadHash)) throw new Error("活動重試識別無效。");
    eventId(input.eventId);
    const result = this.ctx.storage.transactionSync(() => {
      if (id === "root") return { eventId: input.eventId, reused: false };
      const account = this.sql.exec("SELECT role, disabled, self_registered FROM accounts WHERE id = ?", id).toArray()[0];
      if (!account || account.disabled) return { error: "unauthorized" };
      if (!account.self_registered || account.role === "admin") return { eventId: input.eventId, reused: false };
      const existing = this.sql.exec(`SELECT request_id, payload_hash, event_id FROM event_creation_reservations WHERE account_id = ? AND request_id = ?
        UNION ALL SELECT request_id, payload_hash, event_id FROM paid_event_reservations WHERE account_id = ? AND request_id = ?`, id, input.requestId, id, input.requestId).toArray()[0];
      if (existing) {
        if (existing.payload_hash !== input.payloadHash) return { error: "idempotency_conflict" };
        return { eventId: existing.event_id, reused: true };
      }
      if (!input.event || typeof input.event !== "object" || Array.isArray(input.event) || input.event.id !== input.eventId || input.event.ownerId !== id) throw new Error("活動保留資料無效。");
      const freeUsed = Boolean(this.sql.exec("SELECT 1 AS used FROM event_creation_reservations WHERE account_id = ?", id).toArray()[0]);
      const mode = paymentMode(this.env, id);
      const credit = freeUsed && mode !== null ? this.sql.exec("SELECT id FROM billing_credits WHERE account_id = ? AND livemode = ? AND status = 'available' ORDER BY created_at, id LIMIT 1", id, mode).toArray()[0] : null;
      if (freeUsed && !credit) return { error: "quota_exceeded" };
      const event = freeUsed ? { ...input.event, entitlement: { kind: "paid-credit" }, trial: { voteLimit: 10000, maxDurationHours: 168 } } : input.event;
      const duration = Date.parse(event.closesAt) - Date.parse(event.opensAt);
      if (freeUsed && (!Number.isFinite(duration) || duration <= 0 || duration > 168 * 3600000)) return { error: "duration_exceeded" };
      const eventJson = JSON.stringify(event);
      if (encoder.encode(eventJson).byteLength > 8192) throw new Error("活動保留資料太大。");
      const createdAt = new Date().toISOString();
      if (freeUsed) {
        this.sql.exec("INSERT INTO paid_event_reservations (account_id, request_id, payload_hash, event_id, event_json, credit_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id, input.requestId, input.payloadHash, input.eventId, eventJson, credit.id, createdAt);
        this.sql.exec("UPDATE billing_credits SET status = 'spent', spent_event_id = ? WHERE id = ? AND status = 'available'", input.eventId, credit.id);
      } else {
        this.sql.exec("INSERT INTO event_creation_reservations (account_id, request_id, payload_hash, event_id, event_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          id, input.requestId, input.payloadHash, input.eventId, eventJson, createdAt);
      }
      return { eventId: input.eventId, reused: false };
    });
    // The lifetime reservation survives RPC/Worker failures. An ambiguous
    // initialization timeout must be retried with this same request identifier.
    await this.ctx.storage.sync();
    return result;
  }

  getBillingSummary(id) {
    const quota = this.getCreationQuota(id);
    if (!quota) return null;
    if (id === "root") return { paidCredits: 0, latestCheckout: null };
    const mode = paymentMode(this.env, id);
    const latestCheckout = mode === null ? null : this.sql.exec("SELECT * FROM billing_orders WHERE account_id = ? AND livemode = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", id, mode).toArray()[0] || null;
    return { paidCredits: quota.paidCredits, latestCheckout };
  }

  getBillingOrder(id) {
    if (!UUID.test(id || "")) return null;
    return this.sql.exec("SELECT * FROM billing_orders WHERE id = ?", id).toArray()[0] || null;
  }

  getBillingOrderByPayment(paymentIntent, livemode) {
    if (!/^pi_[A-Za-z0-9]{8,256}$/.test(paymentIntent || "") || typeof livemode !== "boolean") return null;
    return this.sql.exec("SELECT * FROM billing_orders WHERE payment_intent = ? AND livemode = ?", paymentIntent, Number(livemode)).toArray()[0] || null;
  }

  getOwnedBillingOrder(id, input) {
    if (!this.getCreationQuota(id) || id === "root") return null;
    const mode = paymentMode(this.env, id);
    if (mode === null) return null;
    return input?.orderId ? this.sql.exec("SELECT * FROM billing_orders WHERE id = ? AND account_id = ? AND livemode = ?", input.orderId, id, mode).toArray()[0] || null
      : this.sql.exec("SELECT * FROM billing_orders WHERE session_id = ? AND account_id = ? AND livemode = ?", input?.sessionId || "", id, mode).toArray()[0] || null;
  }

  async prepareBillingOrder(id, input) {
    accountId(id);
    if (!input || !UUID.test(input.requestId || "") || !UUID.test(input.orderId || "") || !/^price_[A-Za-z0-9]+$/.test(input.priceId || "") ||
        !Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1 || input.amountMinor > 100000000 || !/^[a-z]{3}$/.test(input.currency || "") ||
        typeof input.livemode !== "boolean" || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() / 1000 || input.expiresAt > Date.now() / 1000 + 86400) throw new Error("付款訂單資料無效。");
    const origin = new URL(input.origin);
    if (origin.protocol !== "https:" || origin.origin !== input.origin) throw new Error("付款回調來源無效。");
    const result = this.ctx.storage.transactionSync(() => {
      const account = this.sql.exec("SELECT disabled, role, self_registered FROM accounts WHERE id = ?", id).toArray()[0];
      const mode = paymentMode(this.env, id);
      if (!account || account.disabled || !account.self_registered || account.role !== "organizer" || mode !== Number(input.livemode)) return { error: "ineligible" };
      const existing = this.sql.exec(`SELECT o.* FROM billing_orders o WHERE o.account_id = ? AND o.request_id = ?
        UNION ALL SELECT o.* FROM billing_checkout_requests r JOIN billing_orders o ON o.id = r.order_id WHERE r.account_id = ? AND r.request_id = ?`, id, input.requestId, id, input.requestId).toArray()[0];
      if (existing) return existing.livemode === mode ? { order: existing } : { error: "ineligible" };
      const pending = this.sql.exec("SELECT * FROM billing_orders WHERE account_id = ? AND livemode = ? AND status IN ('creating', 'open', 'review') ORDER BY created_at DESC LIMIT 1", id, mode).toArray()[0];
      if (pending) {
        if (this.sql.exec("SELECT COUNT(*) AS total FROM billing_checkout_requests WHERE order_id = ?", pending.id).one().total >= 32) return { error: "too_many_requests" };
        // Every request that reopens the same pending checkout keeps that
        // binding after fulfillment; retrying another browser's UUID is safe.
        this.sql.exec("INSERT INTO billing_checkout_requests (account_id, request_id, order_id) VALUES (?, ?, ?)", id, input.requestId, pending.id);
        return { order: pending };
      }
      this.sql.exec("INSERT INTO billing_orders (id, account_id, request_id, price_id, amount_minor, currency, livemode, origin, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)",
        input.orderId, id, input.requestId, input.priceId, input.amountMinor, input.currency, mode, input.origin, input.expiresAt, new Date().toISOString());
      return { order: this.getBillingOrder(input.orderId) };
    });
    await this.ctx.storage.sync();
    return result;
  }

  async bindBillingSession(id, input) {
    const order = this.ctx.storage.transactionSync(() => {
      const row = this.getBillingOrder(id);
      if (!row || !/^cs_(?:test_|live_)?[A-Za-z0-9]{8,256}$/.test(input?.sessionId || "") || input.expiresAt !== row.expires_at) throw new Error("付款訂單識別無效。");
      if (row.session_id && row.session_id !== input.sessionId) throw new Error("付款訂單識別不符。");
      const url = new URL(input.url);
      if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || url.username || url.password) throw new Error("付款網址無效。");
      if (row.status === "creating" || row.status === "review") this.sql.exec("UPDATE billing_orders SET session_id = ?, checkout_url = ?, status = 'open' WHERE id = ?", input.sessionId, input.url, id);
      return this.getBillingOrder(id);
    });
    await this.ctx.storage.sync(); return order;
  }

  async reviewBillingOrder(id) {
    this.sql.exec("UPDATE billing_orders SET status = 'review' WHERE id = ? AND status = 'creating'", id);
    await this.ctx.storage.sync(); return this.getBillingOrder(id);
  }

  async failBillingOrder(id) {
    this.sql.exec("UPDATE billing_orders SET status = 'failed', checkout_url = NULL WHERE id = ? AND status = 'creating' AND session_id IS NULL AND payment_intent IS NULL", id);
    await this.ctx.storage.sync(); return this.getBillingOrder(id);
  }

  async expireBillingOrder(id) {
    this.sql.exec("UPDATE billing_orders SET status = 'expired', checkout_url = NULL WHERE id = ? AND status IN ('creating', 'open', 'review')", id);
    await this.ctx.storage.sync(); return this.getBillingOrder(id);
  }

  async fulfillBillingOrder(input) {
    const order = this.ctx.storage.transactionSync(() => {
      const row = this.getBillingOrder(input?.orderId);
      if (!row || row.livemode !== Number(input.livemode) || !/^pi_[A-Za-z0-9]{8,256}$/.test(input.paymentIntent || "") ||
          !/^cs_(?:test_|live_)?[A-Za-z0-9]{8,256}$/.test(input.sessionId || "") || (row.session_id && row.session_id !== input.sessionId) ||
          (row.payment_intent && row.payment_intent !== input.paymentIntent)) throw new Error("付款訂單不符。");
      if (!row.livemode && paymentMode(this.env, row.account_id) !== 0) throw new Error("測試付款帳戶未獲准。");
      const reversed = this.sql.exec("SELECT 1 AS reversed FROM billing_payment_reversals WHERE payment_intent = ? AND livemode = ?", input.paymentIntent, row.livemode).toArray()[0];
      const existing = this.sql.exec("SELECT order_id FROM billing_credits WHERE (session_id = ? OR payment_intent = ?) AND livemode = ?", input.sessionId, input.paymentIntent, row.livemode).toArray()[0];
      if (existing && existing.order_id !== row.id) throw new Error("付款已用於另一張訂單。");
      if (!existing && !reversed && row.status !== "refunded") this.sql.exec("INSERT INTO billing_credits (id, order_id, account_id, session_id, payment_intent, livemode, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'available', ?)",
        crypto.randomUUID(), row.id, row.account_id, input.sessionId, input.paymentIntent, row.livemode, new Date().toISOString());
      this.sql.exec("UPDATE billing_orders SET status = ?, session_id = ?, payment_intent = ?, checkout_url = NULL WHERE id = ?", reversed || row.status === "refunded" ? "refunded" : "paid", input.sessionId, input.paymentIntent, row.id);
      return this.getBillingOrder(row.id);
    });
    await this.ctx.storage.sync(); return order;
  }

  async revokeBillingPayment(input) {
    if (!/^pi_[A-Za-z0-9]{8,256}$/.test(input?.paymentIntent || "") || typeof input.livemode !== "boolean") throw new Error("退款付款識別無效。");
    this.ctx.storage.transactionSync(() => {
      const mode = Number(input.livemode);
      this.sql.exec("INSERT OR IGNORE INTO billing_payment_reversals (payment_intent, livemode, created_at) VALUES (?, ?, ?)", input.paymentIntent, mode, new Date().toISOString());
      this.sql.exec("UPDATE billing_credits SET status = 'revoked' WHERE payment_intent = ? AND livemode = ? AND status = 'available'", input.paymentIntent, mode);
      this.sql.exec("UPDATE billing_orders SET status = 'refunded', checkout_url = NULL WHERE payment_intent = ? AND livemode = ?", input.paymentIntent, mode);
    });
    await this.ctx.storage.sync(); return { revoked: true };
  }

  async updateAccount(id, input) {
    accountId(id);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["name", "role", "disabled"].includes(key))) throw new Error("帳戶資料無效。");
    const fields = [];
    const values = [];
    if (Object.hasOwn(input, "name")) { fields.push("name = ?"); values.push(accountName(input.name)); }
    if (Object.hasOwn(input, "role")) { fields.push("role = ?"); values.push(accountRole(input.role)); }
    if (Object.hasOwn(input, "disabled")) {
      if (typeof input.disabled !== "boolean") throw new Error("帳戶狀態無效。");
      fields.push("disabled = ?");
      values.push(Number(input.disabled));
    }
    const account = this.ctx.storage.transactionSync(() => {
      if (!this.sql.exec("SELECT id FROM accounts WHERE id = ?", id).toArray().length) return null;
      if (fields.length) this.sql.exec(`UPDATE accounts SET ${fields.join(", ")} WHERE id = ?`, ...values, id);
      if (input.disabled === true) this.sql.exec("DELETE FROM sessions WHERE account_id = ?", id);
      return safeAccount(this.sql.exec(`SELECT ${SAFE_COLUMNS} FROM accounts WHERE id = ?`, id).one());
    });
    await this.ctx.storage.sync();
    return account;
  }

  async rotateKey(id) {
    accountId(id);
    const key = randomHex();
    const hash = await digest(key);
    const account = this.ctx.storage.transactionSync(() => {
      if (!this.sql.exec("SELECT id FROM accounts WHERE id = ?", id).toArray().length) return null;
      this.sql.exec("UPDATE accounts SET credential_hash = ? WHERE id = ?", hash, id);
      this.sql.exec("DELETE FROM sessions WHERE account_id = ?", id);
      return safeAccount(this.sql.exec(`SELECT ${SAFE_COLUMNS} FROM accounts WHERE id = ?`, id).one());
    });
    await this.ctx.storage.sync();
    return account ? { account, key } : null;
  }

  permittedEvents(id) {
    if (id === "root") return [];
    accountId(id);
    const account = this.sql.exec("SELECT disabled FROM accounts WHERE id = ?", id).toArray()[0];
    if (!account || account.disabled) return [];
    // This is the explicit assignment list. Owner/admin access to all events
    // is represented by their role, not by enumerating every event here.
    return this.sql.exec("SELECT event_id FROM event_access WHERE account_id = ? ORDER BY event_id", id).toArray().map((row) => row.event_id);
  }

  async grantEvent(id, accountIds) {
    eventId(id);
    if (!Array.isArray(accountIds) || accountIds.length > MAX_ACCOUNTS) throw new Error("指派帳戶資料無效。");
    const ids = [...new Set(accountIds.map(accountId))];
    this.ctx.storage.transactionSync(() => {
      // Validate the complete replacement before deleting existing grants.
      for (const account of ids) {
        const row = this.sql.exec("SELECT role, disabled FROM accounts WHERE id = ?", account).toArray()[0];
        if (!row || row.disabled || row.role !== "organizer") throw new Error("只可以指派啟用中嘅主辦方帳戶。");
      }
      this.sql.exec("DELETE FROM event_access WHERE event_id = ?", id);
      for (const account of ids) this.sql.exec("INSERT INTO event_access (event_id, account_id) VALUES (?, ?)", id, account);
    });
    await this.ctx.storage.sync();
  }

  eventAssignees(id) {
    eventId(id);
    return this.sql.exec("SELECT account_id FROM event_access WHERE event_id = ? ORDER BY account_id", id).toArray().map((row) => row.account_id);
  }

  eventAssignments(eventIds) {
    if (!Array.isArray(eventIds) || eventIds.length > 1000) throw new Error("活動指派查詢無效。");
    const ids = [...new Set(eventIds.map(eventId))];
    const assignments = Object.fromEntries(ids.map((id) => [id, []]));
    // Bounded parameter batches avoid one RPC call per listed event.
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.sql.exec(`SELECT event_id, account_id FROM event_access WHERE event_id IN (${placeholders}) ORDER BY event_id, account_id`, ...batch).toArray();
      for (const row of rows) assignments[row.event_id].push(row.account_id);
    }
    return assignments;
  }

  hasEventAccess(id, event) {
    eventId(event);
    if (id === "root") return true;
    accountId(id);
    const account = this.sql.exec("SELECT role, disabled FROM accounts WHERE id = ?", id).toArray()[0];
    if (!account || account.disabled) return false;
    if (account.role === "admin") return true;
    return Boolean(this.sql.exec("SELECT 1 AS allowed FROM event_access WHERE event_id = ? AND account_id = ?", event, id).toArray()[0]);
  }

  async allowLogin(ipHash) {
    if (typeof ipHash !== "string" || !TOKEN.test(ipHash)) throw new Error("登入來源無效。");
    const now = Date.now();
    const allowed = this.ctx.storage.transactionSync(() => {
      // Fixed 15-minute windows per hashed IP; bounded expiry cleanup keeps
      // each control-plane request small even after a busy login period.
      this.sql.exec("DELETE FROM login_limits WHERE ip_hash IN (SELECT ip_hash FROM login_limits WHERE window_start <= ? LIMIT 100)", now - LOGIN_WINDOW_MS);
      const row = this.sql.exec("SELECT window_start, attempts FROM login_limits WHERE ip_hash = ?", ipHash).toArray()[0];
      if (!row || row.window_start <= now - LOGIN_WINDOW_MS) {
        this.sql.exec("INSERT INTO login_limits (ip_hash, window_start, attempts) VALUES (?, ?, 1) ON CONFLICT(ip_hash) DO UPDATE SET window_start = excluded.window_start, attempts = 1", ipHash, now);
        return true;
      }
      if (row.attempts >= 20) return false;
      this.sql.exec("UPDATE login_limits SET attempts = attempts + 1 WHERE ip_hash = ?", ipHash);
      return true;
    });
    await this.ctx.storage.sync();
    return allowed;
  }
}
