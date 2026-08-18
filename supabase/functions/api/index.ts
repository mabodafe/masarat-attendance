// Supabase Edge Function entry point.
//
// Deployed as the function named `api`, so Supabase serves it at
//   https://<project-ref>.supabase.co/functions/v1/api/...
//
// MUST BE DEPLOYED WITH --no-verify-jwt.
// Supabase would otherwise try to validate the incoming Authorization header as a
// SUPABASE JWT and reject it. Our tokens are our own HS256 JWTs signed with
// JWT_SECRET, and this application does its own authentication and role checks
// (see api/lib/auth.ts). Turning Supabase's verification off does NOT make the
// API public — every /api/me/* and /api/admin/* route still goes through
// requireAuth and requireRole.
import { app } from '../../../api/index.ts';

// Supabase prefixes the path with /functions/v1/<function-name>. The application
// routes are all mounted under /api, so strip the platform prefix and hand the
// app the path it expects (/api/health, /api/auth/login, ...).
const PREFIX = '/functions/v1/api';

Deno.serve((req) => {
  const url = new URL(req.url);
  if (url.pathname.startsWith(PREFIX)) {
    url.pathname = url.pathname.slice(PREFIX.length) || '/';
    return app.fetch(new Request(url.toString(), req));
  }
  return app.fetch(req);
});
