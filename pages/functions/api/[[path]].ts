// Cloudflare Pages Function — proxies /api/* to the Supabase Edge Function.
//
// WHY A PROXY INSTEAD OF CALLING SUPABASE DIRECTLY FROM THE BROWSER:
//
// 1. SAME ORIGIN. The frontend calls relative paths (/api/...) and there is no
//    API_BASE_URL anywhere in public/. Keeping the API on the same origin means the
//    frontend needs ZERO changes, there is no CORS to configure, and the service
//    worker's "never cache /api/" rule keeps working exactly as written.
// 2. GEOLOCATION. The app sends `Permissions-Policy: geolocation=(self)`. Same-origin
//    keeps that meaningful.
// 3. THE REAL CLIENT IP. This is the important one. Cloudflare knows the true client
//    IP; Supabase would only ever see Cloudflare's. The login throttle keys on the
//    client IP, so this proxy forwards `cf-connecting-ip` explicitly. Without it,
//    every employee in the country would share one throttle bucket.
//
// Deployed automatically by Cloudflare Pages from this directory.

interface Env {
  // e.g. https://abcdefghijkl.supabase.co  — set in the Pages project settings.
  SUPABASE_FUNCTIONS_ORIGIN: string;
  // Supabase requires an apikey header on function calls. The ANON key is correct
  // here: it grants nothing on its own, because the function is deployed with
  // --no-verify-jwt and this application does its own auth. The SERVICE ROLE key
  // must NEVER be placed in this proxy.
  SUPABASE_ANON_KEY: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);

  const target = `${env.SUPABASE_FUNCTIONS_ORIGIN}/functions/v1/api${url.pathname}${url.search}`;

  const headers = new Headers(request.headers);
  // Forward the true client IP so the login throttle is per-employee, not global.
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) headers.set('cf-connecting-ip', clientIp);
  // Supabase's gateway requires this; it is not a secret in the sense of granting data access.
  headers.set('apikey', env.SUPABASE_ANON_KEY);
  // Host must not be pinned to the Pages hostname or Supabase's router rejects it.
  headers.delete('host');
  // Let the platform negotiate encoding.
  headers.delete('accept-encoding');

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }

  const upstream = await fetch(target, init);

  // Pass the response through untouched, so status codes, JSON bodies and the
  // security headers the app sets all reach the browser exactly as generated.
  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete('content-encoding');
  outHeaders.delete('content-length');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
};
