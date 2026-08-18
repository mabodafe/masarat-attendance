// Hono application — replaces server/index.js.
//
// WHAT MOVED OUT OF THIS FILE AND WHY:
//   * express.static      -> Cloudflare Pages serves public/ directly.
//   * https.createServer  -> TLS is terminated by Cloudflare. SSL_KEY/SSL_CERT are gone.
//   * setInterval         -> a serverless invocation ends when it responds, so the
//                            10-minute auto-close timer cannot live here. It is now
//                            POST /api/cron/auto-close, called by a scheduler and
//                            protected by CRON_SECRET.
//   * trust proxy         -> gone. See clientIp() in lib/auth.ts: the client IP is
//                            taken from cf-connecting-ip, which a client cannot forge.
//
// WHAT STAYED: every route path, status code, response shape and header the
// frontend already depends on, plus the JSON body limit.
import { Hono } from 'npm:hono@4.6.14';
import config from './config.ts';
import * as T from './lib/time.ts';
import { purgeOldAttempts } from './lib/auth.ts';
import type { SessionUser } from './lib/auth.ts';
import authRoutes from './routes/auth.ts';
import meRoutes from './routes/me.ts';
import adminRoutes from './routes/admin.ts';

export const app = new Hono<{ Variables: { user: SessionUser } }>();

// ---- security headers (same three the Node app set) ------------------------
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  // Geolocation must be permitted for this origin or the browser blocks the API.
  c.header('Permissions-Policy', 'geolocation=(self)');
  // Attendance responses must never be cached anywhere — but only set this when
  // the handler has not already chosen a policy. The punch-photo endpoint
  // deliberately sends `private, max-age=3600`, and blanket-overwriting it here
  // would have silently changed that response (caught during the route port).
  if (!c.res.headers.get('cache-control')) c.header('Cache-Control', 'no-store');
});

// ---- body size limit -------------------------------------------------------
// The Node app used express.json({ limit: ceil(MAX_PHOTO_KB * 1.4) + 64 kb }),
// which is ~624 KB at the default 400 KB photo cap. Same ceiling, enforced here.
const MAX_BODY_BYTES = (Math.ceil(config.maxPhotoKb * 1.4) + 64) * 1024;
app.use('*', async (c, next) => {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len && len > MAX_BODY_BYTES) {
    return c.json({ error: 'That request is too large.' }, 413);
  }
  await next();
});

// ---- public ----------------------------------------------------------------
app.get('/api/health', (c) => {
  const l = T.local();
  return c.json({
    ok: true,
    server_time: T.nowIso(),
    local_time: `${l.date} ${l.hhmm}`,
    tz: config.tzLabel,
  });
});

// ---- routes ----------------------------------------------------------------
// Same three mount points, same order, as the Node app's app.use() calls.
app.route('/api/auth', authRoutes);
app.route('/api/me', meRoutes);
app.route('/api/admin', adminRoutes);

// ---- scheduled work (replaces the in-process setInterval) ------------------
// Called every 10 minutes by an external scheduler. Rejects anything without the
// shared secret so it cannot be triggered by the public internet.
app.post('/api/cron/auto-close', async (c) => {
  if (!config.cronSecret || c.req.header('x-cron-secret') !== config.cronSecret) {
    return c.json({ error: 'Not authorised.' }, 401);
  }
  const { autoCloseStale } = await import('./lib/attendance.ts');
  try {
    const closed = await autoCloseStale();
    const purged = await purgeOldAttempts();
    if (closed) console.log(`[auto-close] closed ${closed} abandoned attendance record(s)`);
    return c.json({ ok: true, closed, throttle_rows_purged: purged });
  } catch (err) {
    console.error('[auto-close] failed', err);
    return c.json({ error: 'Auto-close failed.' }, 500);
  }
});

// ---- 404 for unknown API routes (same shape as before) ---------------------
app.all('/api/*', (c) => c.json({ error: 'Unknown endpoint.' }, 404));

// ---- error handler ---------------------------------------------------------
// The Node version matched the SQLite wording /UNIQUE constraint/, which Postgres
// never produces. It now uses the explicit flag set in db.ts (SQLSTATE 23505).
app.onError((err, c) => {
  console.error('[error]', err);
  const e = err as Error & { isUniqueViolation?: boolean };
  const msg = e.isUniqueViolation
    ? 'That value already exists.'
    : 'Something went wrong on the server.';
  return c.json({ error: msg }, 500);
});

export default app;
