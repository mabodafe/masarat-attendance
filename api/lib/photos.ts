// Ported from server/lib/photos.js.
//
// The validation is UNCHANGED and deliberately strict: real JPEG magic bytes are
// checked rather than trusting a filename or a MIME type, so a script cannot be
// smuggled in as a photo. Minimum 1 KB, maximum MAX_PHOTO_KB.
//
// Only the destination changed: fs.writeFileSync into data/photos becomes an
// upload into a private object-storage bucket. The stored value in
// attendance.check_in_photo / check_out_photo is still just the object key, so
// no database change is needed.
import config from '../config.ts';
import { storage } from './storage.ts';

const JPEG_PREFIX = /^data:image\/jpe?g;base64,/i;

export interface SaveResult {
  name?: string | null;
  error?: string;
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Stores a selfie taken at the moment of a punch. The client sends a downscaled
 * JPEG data URL; only JPEG is accepted and the magic bytes are checked, so a
 * renamed file or a script cannot be smuggled in as a photo.
 * Returns the stored object key, or an { error } object.
 */
export async function savePunchPhoto(
  dataUrl: unknown,
  { userId, kind }: { userId: number; kind: string },
): Promise<SaveResult> {
  if (!dataUrl) return { name: null };
  if (typeof dataUrl !== 'string' || !JPEG_PREFIX.test(dataUrl)) {
    return { error: 'The photo must be a JPEG image.' };
  }
  let buf: Uint8Array;
  try {
    buf = decodeBase64(dataUrl.replace(JPEG_PREFIX, ''));
  } catch {
    return { error: 'The photo could not be read.' };
  }
  if (buf.length < 1024) return { error: 'The photo is empty or too small.' };
  if (buf.length > config.maxPhotoKb * 1024) {
    return { error: `The photo is larger than ${config.maxPhotoKb} KB.` };
  }
  // JPEG starts FF D8 FF.
  if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) {
    return { error: 'That file is not a JPEG image.' };
  }

  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const name = `${new Date().toISOString().slice(0, 10)}_u${userId}_${kind}_${rand}.jpg`;
  await storage.put(name, buf, 'image/jpeg');
  return { name };
}

/**
 * Replaces photoPath(). There is no filesystem path any more, so this validates
 * the stored key with the same allowlist the old code used before touching disk,
 * then fetches the bytes. Returns null when the key is unsafe or missing.
 */
export async function readPunchPhoto(name: unknown): Promise<Uint8Array | null> {
  if (!name || typeof name !== 'string' || !/^[\w.\-]+\.jpg$/.test(name)) return null;
  return await storage.get(name);
}

/** Kept for parity with the old deletePhoto(). */
export async function deletePhoto(name: unknown): Promise<void> {
  if (!name || typeof name !== 'string' || !/^[\w.\-]+\.jpg$/.test(name)) return;
  await storage.remove(name);
}
