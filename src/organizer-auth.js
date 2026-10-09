import { createRemoteJWKSet, customFetch, importPKCS8, jwtVerify, SignJWT } from "jose";

const encoder = new TextEncoder();
const FLOW_SECONDS = 600;
const COOKIE_NAME = "__Host-wevote_oauth";
const PROVIDERS = {
  google: { authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", keys: "https://www.googleapis.com/oauth2/v3/certs" },
  apple: { authorize: "https://appleid.apple.com/auth/authorize", token: "https://appleid.apple.com/auth/token", keys: "https://appleid.apple.com/auth/keys" },
};

function validProvider(provider) { return Object.hasOwn(PROVIDERS, provider); }

function randomHex() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalOrigin(env) {
  try {
    const url = new URL(env.PUBLIC_BASE_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch { return null; }
}

function setting(value, maximum = 4096) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

export function oauthAvailability(env) {
  const baseReady = Boolean(canonicalOrigin(env) && setting(env.VOTE_SIGNING_KEY) && env.VOTE_SIGNING_KEY.length >= 32);
  return {
    google: baseReady && setting(env.GOOGLE_CLIENT_ID, 1024) && setting(env.GOOGLE_CLIENT_SECRET),
    apple: baseReady && setting(env.APPLE_SERVICE_ID, 256) && setting(env.APPLE_TEAM_ID, 64) && setting(env.APPLE_KEY_ID, 64) &&
      setting(env.APPLE_PRIVATE_KEY, 16_384) && env.APPLE_PRIVATE_KEY.includes("-----BEGIN PRIVATE KEY-----"),
  };
}

function flowCookie(value, provider, maxAge = FLOW_SECONDS) {
  return `${COOKIE_NAME}=${value}; Secure; HttpOnly; Path=/; SameSite=${provider === "apple" ? "None" : "Lax"}; Max-Age=${maxAge}`;
}

function cookieValue(request) {
  return (request.headers.get("Cookie") || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1) || "";
}

function failure(message, status, provider) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  if (provider) headers["Set-Cookie"] = flowCookie("", provider, 0);
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

function diagnose(provider, stage, error) {
  const codes = new Set(["ERR_JWT_CLAIM_VALIDATION_FAILED", "ERR_JWT_EXPIRED", "ERR_JWS_SIGNATURE_VERIFICATION_FAILED", "ERR_JWKS_TIMEOUT", "ERR_JWKS_NO_MATCHING_KEY", "ERR_JWKS_INVALID", "ERR_JWK_INVALID", "ERR_JOSE_ALG_NOT_ALLOWED"]);
  // Only these fixed classifications may reach logs. Never serialize the
  // exception, callback, request URL, account identity or provider response.
  const reason = codes.has(error?.code) ? error.code : error?.name === "TimeoutError" ? "provider_timeout" : error?.name === "AbortError" ? "provider_aborted" : "failed";
  console.warn("wevote_oauth_failure", { provider, stage, reason });
}

function cancelled(origin, provider) {
  return new Response(null, { status: 303, headers: { Location: `${origin}/admin.html?auth_error=cancelled`, "Set-Cookie": flowCookie("", provider, 0), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

async function stateKey(env) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.VOTE_SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode("wevote:organizer-oauth-state:v1")));
}

async function readBoundedBody(body, maximum) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new Error("OAuth response too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function boundedProviderFetch(input, init = {}) {
  const timeout = AbortSignal.timeout(8000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  // Workers implements only follow/manual. Check redirects explicitly so an
  // authorization code or confidential client secret never follows a 3xx.
  const response = await fetch(input, { ...init, redirect: "manual", signal });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error("OAuth provider redirect rejected");
  }
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > 65_536) {
    await response.body?.cancel();
    throw new Error("OAuth response too large");
  }
  const body = await readBoundedBody(response.body, 65_536);
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

const remoteKeys = Object.fromEntries(Object.entries(PROVIDERS).map(([provider, endpoints]) => [provider,
  createRemoteJWKSet(new URL(endpoints.keys), { timeoutDuration: 8000, cacheMaxAge: 600_000, cooldownDuration: 30_000, [customFetch]: boundedProviderFetch }),
]));

export async function startOrganizerOAuth(request, env, provider, directory) {
  if (request.method !== "GET") return failure("方法無效。", 405);
  if (!validProvider(provider) || !oauthAvailability(env)[provider]) return failure("呢個登入方式尚未設定。", 503);
  const origin = canonicalOrigin(env);
  if (new URL(request.url).origin !== origin) return failure("請喺正式網站登入。", 400);
  const now = Math.floor(Date.now() / 1000);
  const state = await new SignJWT({ provider }).setProtectedHeader({ alg: "HS256", typ: "wevote-oauth+jwt" })
    .setIssuer("wevote-organizer-auth").setAudience(origin).setSubject(provider).setJti(randomHex()).setIssuedAt(now).setExpirationTime(now + FLOW_SECONDS).sign(await stateKey(env));
  const nonce = randomHex();
  const verifier = provider === "google" ? randomHex() : null;
  const redirectUri = `${origin}/api/auth/${provider}/callback`;
  await directory.createOAuthFlow({ stateHash: await hash(state), provider, nonce, verifier, redirectUri, expiresAt: (now + FLOW_SECONDS) * 1000 });
  const authorization = new URL(PROVIDERS[provider].authorize);
  authorization.search = new URLSearchParams({
    client_id: provider === "google" ? env.GOOGLE_CLIENT_ID : env.APPLE_SERVICE_ID,
    redirect_uri: redirectUri, response_type: "code", scope: provider === "google" ? "openid email profile" : "name email", state, nonce,
  }).toString();
  if (provider === "google") {
    authorization.searchParams.set("code_challenge", base64url(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
    authorization.searchParams.set("code_challenge_method", "S256");
  } else authorization.searchParams.set("response_mode", "form_post");
  return new Response(null, { status: 302, headers: { Location: authorization.href, "Set-Cookie": flowCookie(state, provider), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

async function appleClientSecret(env) {
  const key = await importPKCS8(env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n"), "ES256");
  return new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: env.APPLE_KEY_ID }).setIssuer(env.APPLE_TEAM_ID)
    .setSubject(env.APPLE_SERVICE_ID).setAudience("https://appleid.apple.com").setIssuedAt().setExpirationTime("5m").sign(key);
}

async function exchangeCode(provider, code, flow, env) {
  const form = new URLSearchParams({ code, grant_type: "authorization_code", redirect_uri: flow.redirectUri });
  form.set("client_id", provider === "google" ? env.GOOGLE_CLIENT_ID : env.APPLE_SERVICE_ID);
  form.set("client_secret", provider === "google" ? env.GOOGLE_CLIENT_SECRET : await appleClientSecret(env));
  if (provider === "google") form.set("code_verifier", flow.verifier);
  const response = await boundedProviderFetch(PROVIDERS[provider].token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  if (!response.ok) throw new Error("OAuth token exchange failed");
  const result = await response.json();
  if (typeof result.id_token !== "string" || result.id_token.length > 16_384) throw new Error("OAuth identity token missing");
  return result.id_token;
}

export async function verifyOrganizerIdentityToken(provider, token, clientId, nonce, keys = remoteKeys[provider]) {
  if (!validProvider(provider) || typeof token !== "string" || token.length > 16_384) throw new Error("OAuth identity token invalid");
  const { payload } = await jwtVerify(token, keys, {
    issuer: provider === "google" ? ["https://accounts.google.com", "accounts.google.com"] : "https://appleid.apple.com",
    audience: clientId, algorithms: ["RS256"], clockTolerance: 30, maxTokenAge: "10m", requiredClaims: ["sub", "iat", "exp", "nonce"],
  });
  if (payload.nonce !== nonce || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 256 || /[\u0000-\u001f\u007f]/.test(payload.sub) ||
      (payload.azp !== undefined && payload.azp !== clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new Error("OAuth identity claims invalid");
  const name = typeof payload.name === "string" ? payload.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) : "";
  return { subject: payload.sub, name: name || "主辦方" };
}

export async function finishOrganizerOAuth(request, env, provider, directory) {
  if (!validProvider(provider) || !oauthAvailability(env)[provider]) return failure("呢個登入方式尚未設定。", 503);
  if (request.method !== (provider === "google" ? "GET" : "POST")) return failure("方法無效。", 405, provider);
  const origin = canonicalOrigin(env);
  if (new URL(request.url).origin !== origin || new URL(request.url).pathname !== `/api/auth/${provider}/callback`) {
    diagnose(provider, "callback_origin");
    return failure("登入回調網址不符。", 400, provider);
  }
  let input;
  let stage = "callback_input";
  try {
    if (provider === "google") {
      if (request.url.length > 16_384) throw new Error("OAuth callback too large");
      input = new URL(request.url).searchParams;
    } else {
      if (!request.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return failure("登入回應格式無效。", 415, provider);
      input = new URLSearchParams(new TextDecoder().decode(await readBoundedBody(request.body, 16_384)));
    }
    if (["state", "code", "error"].some((name) => input.getAll(name).length > 1)) throw new Error("OAuth callback duplicate fields");
    stage = "browser_state";
    const state = input.get("state") || "";
    if (!state || state.length > 2048 || cookieValue(request) !== state) throw new Error("OAuth state mismatch");
    stage = "state_signature";
    const { payload } = await jwtVerify(state, await stateKey(env), { issuer: "wevote-organizer-auth", audience: origin, subject: provider,
      algorithms: ["HS256"], typ: "wevote-oauth+jwt", maxTokenAge: "10m", requiredClaims: ["iat", "exp", "jti"] });
    if (payload.provider !== provider || typeof payload.jti !== "string" || !/^[a-f0-9]{64}$/.test(payload.jti)) throw new Error("OAuth state invalid");
    stage = "durable_flow";
    const flow = await directory.consumeOAuthFlow(await hash(state), provider);
    if (!flow || flow.redirectUri !== `${origin}/api/auth/${provider}/callback`) throw new Error("OAuth flow expired");
    if (input.has("error")) return cancelled(origin, provider);
    const code = input.get("code") || "";
    stage = "authorization_code";
    if (!code || code.length > 4096) throw new Error("OAuth code invalid");
    stage = "token_exchange";
    const token = await exchangeCode(provider, code, flow, env);
    stage = "identity_verification";
    const identity = await verifyOrganizerIdentityToken(provider, token, provider === "google" ? env.GOOGLE_CLIENT_ID : env.APPLE_SERVICE_ID, flow.nonce);
    stage = "account_resolution";
    const principal = await directory.resolveOAuthAccount({ provider, subject: identity.subject, name: identity.name });
    if (!principal) {
      diagnose(provider, stage);
      return failure("呢個帳戶暫時未能登入。", 403, provider);
    }
    return { principal, redirectTo: `${origin}/admin.html?auth=success`, clearCookie: flowCookie("", provider, 0) };
  } catch (error) {
    // Codes, identity tokens, secrets and provider response bodies must never
    // appear in application logs or browser errors.
    diagnose(provider, stage, error);
    return failure("登入驗證失敗或已過期，請返回重新登入。", 400, provider);
  }
}
