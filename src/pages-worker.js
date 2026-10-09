// Pages serves the public site while a private service binding handles voting.
export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    // Cache canonical public result URLs. Votes, identities and admin exports
    // always go straight to the API Worker.
    const resultsPath = url.pathname === "/api/results" || /^\/api\/events\/[a-f0-9]{24}\/results$/.test(url.pathname);
    const publicResults = resultsPath && request.method === "GET" &&
      !url.search && !request.headers.has("Authorization");
    if (!publicResults) return env.WEVOTE_API.fetch(request);

    const cacheKey = new Request(url.origin + url.pathname);
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
    const response = await env.WEVOTE_API.fetch(request);
    if (response.ok && response.headers.get("Cache-Control")?.startsWith("public,")) {
      context.waitUntil(caches.default.put(cacheKey, response.clone()));
    }
    return response;
  },
};
