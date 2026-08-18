/**
 * Helper for the 'Selfie policy modes' section of test/run.ts.
 *
 * The Node suite reassigned `cfg.selfieMode` between assertions. api/config.ts now
 * reads Deno.env once at module load, so the only faithful way to exercise all
 * three policies is one process per policy. The parent spawns this script three
 * times with SELFIE_MODE=off|optional|required (and its own PORT), and reads the
 * single JSON line printed on stdout.
 *
 * Boots the app on its own port first, which proves the configuration is accepted,
 * then calls attendance.handlePhoto() exactly as the original section did.
 */
const jpegUrl = Deno.env.get('TEST_JPEG_DATA_URL');
if (!jpegUrl) throw new Error('TEST_JPEG_DATA_URL is not set.');

const port = Number(Deno.env.get('PORT') ?? 3200);

const { app } = await import('../api/index.ts');
const config = (await import('../api/config.ts')).default;
const AT = await import('../api/lib/attendance.ts');
const { close } = await import('../api/db.ts');

const server = Deno.serve({ port, hostname: '127.0.0.1', onListen: () => {} }, app.fetch);
const health = await fetch(`http://127.0.0.1:${port}/api/health`);
if (!health.ok) throw new Error(`child app did not boot: ${health.status}`);
await health.body?.cancel();

const withPhoto = await AT.handlePhoto(jpegUrl, { userId: 1, kind: 'in' });
const withoutPhoto = await AT.handlePhoto(null, { userId: 1, kind: 'in' });

console.log(JSON.stringify({ mode: config.selfieMode, withPhoto, withoutPhoto }));

await server.shutdown();
await close();
