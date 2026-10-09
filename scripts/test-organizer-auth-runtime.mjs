// Run the real OAuth helper inside workerd. Provider requests are intercepted;
// only disposable generated keys and mock identities are used.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export async function testOrganizerAuthRuntime() {
  const origin = "https://runtime.example";
  const clientId = "offline-runtime-client";
  const clientSecret = "offline-runtime-secret";
  const keys = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(keys.publicKey), kid: "offline-runtime", alg: "RS256", use: "sig" };
  let nonce;
  let challenge;
  let mode = "valid";
  let tokenCalls = 0;
  let keyCalls = 0;
  const entry = `
    import { startOrganizerOAuth, finishOrganizerOAuth } from "./src/organizer-auth.js";
    const env = ${JSON.stringify({ PUBLIC_BASE_URL: origin, VOTE_SIGNING_KEY: "offline-runtime-state-secret-".repeat(3), GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret })};
    const flows = new Map();
    const directory = {
      async createOAuthFlow(flow) { flows.set(flow.stateHash, flow); },
      async consumeOAuthFlow(hash) { const flow = flows.get(hash); flows.delete(hash); return flow; },
      async resolveOAuthAccount() { return { id: "a".repeat(24), role: "organizer", selfRegistered: true }; }
    };
    export default { async fetch(request) {
      const url = new URL(request.url);
      const canonical = new Request(env.PUBLIC_BASE_URL + url.pathname + url.search, request);
      if (url.pathname.endsWith("/start")) return startOrganizerOAuth(canonical, env, "google", directory);
      const result = await finishOrganizerOAuth(canonical, env, "google", directory);
      return result instanceof Response ? result : Response.json({ signedIn: true });
    } };
  `;
  const bundle = await build({ stdin: { contents: entry, resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "oauth-runtime.mjs" }, bundle: true, format: "esm", platform: "browser", write: false, logLevel: "silent" });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: "2026-10-09", script: bundle.outputFiles[0].text,
    log: new Log(LogLevel.ERROR),
    async outboundService(request) {
      const url = new URL(request.url);
      if (url.href === "https://www.googleapis.com/oauth2/v3/certs") {
        keyCalls++;
        return Response.json({ keys: [jwk] });
      }
      assert.equal(url.href, "https://oauth2.googleapis.com/token", "runtime never follows a provider Location");
      tokenCalls++;
      assert.equal(request.method, "POST");
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get("client_id"), clientId);
      assert.equal(form.get("client_secret"), clientSecret);
      assert.equal(form.get("redirect_uri"), `${origin}/api/auth/google/callback`);
      assert.equal(Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier")))).toString("base64url"), challenge);
      if (mode === "redirect") return new Response(null, { status: 307, headers: { Location: "https://untrusted.example/token" } });
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ iss: "https://accounts.google.com", aud: clientId, sub: "offline-runtime-subject", nonce, iat: now, exp: now + 300 })
        .setProtectedHeader({ alg: "RS256", kid: jwk.kid }).sign(keys.privateKey);
      return Response.json({ id_token: idToken });
    },
  }));
  try {
    async function callback() {
      const start = await runtime.dispatchFetch(`${origin}/api/auth/google/start`, { redirect: "manual" });
      assert.equal(start.status, 302);
      const authorization = new URL(start.headers.get("Location"));
      nonce = authorization.searchParams.get("nonce");
      challenge = authorization.searchParams.get("code_challenge");
      return runtime.dispatchFetch(`${origin}/api/auth/google/callback?${new URLSearchParams({ state: authorization.searchParams.get("state"), code: "offline-runtime-code" })}`, { redirect: "manual", headers: { Cookie: start.headers.get("Set-Cookie").split(";")[0] } });
    }
    const result = await callback();
    assert.equal(result.status, 200, "real workerd fetch supports the OAuth exchange and JWKS request");
    assert.equal((await result.json()).signedIn, true);
    assert.equal(tokenCalls, 1);
    assert.equal(keyCalls, 1, "runtime verifies the provider signature through bounded JWKS fetch");
    mode = "redirect";
    const redirected = await callback();
    assert.equal(redirected.status, 400, "runtime rejects provider redirects");
    assert.equal(tokenCalls, 2, "redirect response makes exactly one exchange request");
    assert.equal(keyCalls, 1, "redirect failure cannot reach identity verification");
    return 7;
  } finally { await runtime.dispose(); }
}
