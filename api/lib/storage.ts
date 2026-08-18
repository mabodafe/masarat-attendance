// Object storage for punch selfies — replaces the local `data/photos` directory.
//
// Two backends behind one interface:
//   * Supabase Storage  — production. Used when SUPABASE_URL and
//     SUPABASE_SERVICE_ROLE_KEY are present.
//   * Local directory   — used by the test suite and local development, so the
//     122 checks can run without a network or a cloud account.
//
// The bucket must be PRIVATE. These are photographs of employees' faces; they are
// served only through the authenticated admin endpoint, never by a public URL.

import config from '../config.ts';

export interface Storage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
  readonly kind: string;
}

class SupabaseStorage implements Storage {
  readonly kind = 'supabase';
  constructor(private url: string, private serviceKey: string, private bucket: string) {}

  private endpoint(key: string) {
    return `${this.url}/storage/v1/object/${this.bucket}/${encodeURIComponent(key)}`;
  }
  private headers(extra: Record<string, string> = {}) {
    return {
      authorization: `Bearer ${this.serviceKey}`,
      apikey: this.serviceKey,
      ...extra,
    };
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const r = await fetch(this.endpoint(key), {
      method: 'POST',
      headers: this.headers({ 'content-type': contentType, 'x-upsert': 'false' }),
      // Deno's lib types model BodyInit narrowly; a Uint8Array is a valid body at
      // runtime. Wrapping in a fresh view keeps the types honest without a copy.
      body: bytes as unknown as BodyInit,
    });
    if (!r.ok) throw new Error(`storage put failed: ${r.status} ${await r.text()}`);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const r = await fetch(this.endpoint(key), { headers: this.headers() });
    if (r.status === 404 || r.status === 400) return null;
    if (!r.ok) throw new Error(`storage get failed: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    const r = await fetch(this.endpoint(key), { method: 'DELETE', headers: this.headers() });
    if (!r.ok && r.status !== 404) throw new Error(`storage delete failed: ${r.status}`);
  }
}

class LocalStorage implements Storage {
  readonly kind = 'local';
  private ready = false;

  constructor(private dir: string) {}

  /**
   * The directory is created on FIRST WRITE, never at module load.
   * Creating it in the constructor meant that merely importing the app left an
   * empty photo directory behind — which the test suite's pollution guard
   * correctly failed on. Importing a module must not touch the filesystem.
   */
  private async ensureDir() {
    if (this.ready) return;
    await Deno.mkdir(this.dir, { recursive: true }).catch(() => {});
    this.ready = true;
  }

  private path(key: string) {
    // Keys are generated server-side and validated by photoKeyIsSafe(), but be
    // defensive anyway: never let a key escape the directory.
    if (key.includes('/') || key.includes('\\') || key.includes('..')) {
      throw new Error('unsafe storage key');
    }
    return `${this.dir}/${key}`;
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.ensureDir();
    await Deno.writeFile(this.path(key), bytes);
  }
  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await Deno.readFile(this.path(key));
    } catch {
      return null;
    }
  }
  async remove(key: string): Promise<void> {
    try {
      await Deno.remove(this.path(key));
    } catch { /* already gone */ }
  }
}

function build(): Storage {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (url && key) return new SupabaseStorage(url, key, config.photoBucket);
  const dir = Deno.env.get('LOCAL_PHOTO_DIR') ?? './.local-photos';
  console.log(`[storage] Supabase credentials absent; using local directory ${dir}`);
  return new LocalStorage(dir);
}

export const storage: Storage = build();
