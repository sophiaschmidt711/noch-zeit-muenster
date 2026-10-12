/**
 * OPTIONAL: Cloudflare Worker that sits between the website and the BusRadar API.
 *
 * Use it only if the upstream API starts to require a secret key. The key lives in the
 * Worker's encrypted secrets and never reaches the browser or this repository.
 *
 * What it does
 *  - forwards only a fixed allow-list of read-only GET endpoints
 *  - answers CORS only for your own site (ALLOWED_ORIGIN)
 *  - adds the upstream key header server-side (if configured)
 *  - caches responses for a few seconds, which also reduces load on the upstream API
 *
 * Limits (be realistic)
 *  - The Origin check only stops *other websites* from using your proxy in a browser.
 *    Scripts can fake the header, so add a rate-limiting rule in Cloudflare and use the
 *    quota settings of the upstream key as the real safety net.
 *
 * Setup (see README.md): create the Worker, set the variables below, then change
 * `apiBase` in app.js to the Worker URL.
 *
 * Variables / secrets
 *   ALLOWED_ORIGIN     e.g. https://sophiaschmidt711.github.io        (variable)
 *   UPSTREAM_BASE      default https://rest.busradar.conterra.de/prod  (variable, optional)
 *   UPSTREAM_KEY_HEADER  header name the upstream expects, e.g. "x-api-key"   (variable)
 *   UPSTREAM_KEY       the secret key value                              (SECRET: wrangler secret put UPSTREAM_KEY)
 */

const ALLOWED_PATHS = [
  /^\/haltestellen$/,
  /^\/haltestellen\/\d+\/abfahrten$/,
  /^\/fahrzeuge$/,
  /^\/fahrten\/[^/]+$/
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = env.ALLOWED_ORIGIN;
    const cors = origin && origin === allowed
      ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" }
      : { "Vary": "Origin" };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });
    if (origin && origin !== allowed) return new Response("Forbidden", { status: 403, headers: cors });

    const url = new URL(request.url);
    if (!ALLOWED_PATHS.some(re => re.test(url.pathname))) return new Response("Not found", { status: 404, headers: cors });

    // Only the "sekunden" parameter is passed on, capped at 2 hours.
    const upstream = new URL((env.UPSTREAM_BASE || "https://rest.busradar.conterra.de/prod") + url.pathname);
    const seconds = Number(url.searchParams.get("sekunden"));
    if (Number.isFinite(seconds) && seconds > 0) upstream.searchParams.set("sekunden", String(Math.min(seconds, 7200)));

    const headers = { "Accept": "application/json" };
    if (env.UPSTREAM_KEY && env.UPSTREAM_KEY_HEADER) headers[env.UPSTREAM_KEY_HEADER] = env.UPSTREAM_KEY;

    const response = await fetch(upstream, { headers, cf: { cacheTtl: 15, cacheEverything: true } });
    return new Response(response.body, {
      status: response.status,
      headers: { "Content-Type": response.headers.get("Content-Type") || "application/json", "Cache-Control": "public, max-age=15", ...cors }
    });
  }
};
