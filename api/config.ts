// Ported from server/config.js. No .env file parser is needed any more: on
// Supabase Edge Functions every value arrives as a real environment variable
// (set with `supabase secrets set`), which is exactly the precedence the old
// loader was emulating.

const num = (key: string, dflt: number): number => {
  const v = Number(Deno.env.get(key));
  return Number.isFinite(v) ? v : dflt;
};
const bool = (key: string, dflt: boolean): boolean => {
  const v = Deno.env.get(key);
  if (v === undefined) return dflt;
  return /^(1|true|yes|on)$/i.test(v.trim());
};

const DEV_FALLBACK_SECRET = 'dev-only-insecure-secret';

export const config = {
  jwtSecret: Deno.env.get('JWT_SECRET') ?? DEV_FALLBACK_SECRET,
  tokenTtlHours: num('TOKEN_TTL_HOURS', 12),

  tzOffsetMin: num('TZ_OFFSET_MIN', 180),
  tzLabel: Deno.env.get('TZ_LABEL') ?? 'Asia/Riyadh',

  maxAccuracyM: num('MAX_ACCURACY_M', 75),
  maxFixAgeSec: num('MAX_FIX_AGE_SEC', 90),
  maxClockSkewSec: num('MAX_CLOCK_SKEW_SEC', 120),
  allowOutOfFenceWithFlag: bool('ALLOW_OUT_OF_FENCE_WITH_FLAG', false),

  selfieMode: (['off', 'optional', 'required'] as const).includes(
      (Deno.env.get('SELFIE_MODE') ?? '') as 'off' | 'optional' | 'required')
    ? (Deno.env.get('SELFIE_MODE') as 'off' | 'optional' | 'required')
    : 'optional',
  maxPhotoKb: num('MAX_PHOTO_KB', 400),

  // Selfies now live in a Supabase Storage bucket instead of a local directory.
  photoBucket: Deno.env.get('PHOTO_BUCKET') ?? 'punch-photos',

  // Secret shared with the scheduler that pokes the auto-close endpoint. The
  // 10-minute in-process setInterval cannot exist on a serverless runtime.
  cronSecret: Deno.env.get('CRON_SECRET') ?? '',
};

// ---------------------------------------------------------------------------
// Refuse to start on a weak signing secret.
//
// Carried over from the fix agreed for the Node version, and hardened: there is
// no .env.example to compare against on this runtime, so instead of matching one
// known string we require real length AND real variety. The old placeholder was
// 33 characters with only 15 distinct ones, so it fails the variety check and can
// never reach production silently.
// ---------------------------------------------------------------------------
function secretProblem(secret: string): string | null {
  if (!Deno.env.get('JWT_SECRET')) return 'JWT_SECRET is not set.';
  if (secret === DEV_FALLBACK_SECRET) return 'JWT_SECRET is still the built-in development fallback.';
  const trimmed = secret.trim();
  if (trimmed.length < 32) return `JWT_SECRET is only ${trimmed.length} characters; at least 32 are required.`;
  const distinct = new Set(trimmed).size;
  if (distinct < 16) {
    return `JWT_SECRET has only ${distinct} distinct characters; it looks like a placeholder, not random bytes.`;
  }
  return null;
}

const problem = secretProblem(config.jwtSecret);
if (problem) {
  console.error(`[fatal] ${problem}`);
  console.error('[fatal] Every session token would be forgeable. Refusing to start.');
  console.error('[fatal] Generate one with:');
  console.error('[fatal]   openssl rand -base64 48');
  throw new Error(`Refusing to start: ${problem}`);
}

export default config;
