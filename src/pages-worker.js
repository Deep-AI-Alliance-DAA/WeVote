// Pages serves the public site while a private service binding handles voting.
export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    // Cache only the one public results URL. Ticketed votes and admin exports
    // always go straight to the API Worker.
    const publicResults = url.pathname === "/api/results" && request.method === "GET" &&
      !url.search && !request.headers.has("Authorization");
    if (!publicResults) return env.WEVOTE_API.fetch(request);

    const cached = await caches.default.match(request);
    if (cached) return cached;
    const response = await env.WEVOTE_API.fetch(request);
    if (response.ok && response.headers.get("Cache-Control")?.startsWith("public,")) {
      context.waitUntil(caches.default.put(request, response.clone()));
    }
    return response;
  },
};
