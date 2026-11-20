import type { Env } from '../env';

/**
 * Magazyn plików: R2 jeśli podpięte (binding FILES), w przeciwnym razie Workers KV (FILES_KV).
 * Pliki są wysyłane z przeglądarki w kawałkach po CHUNK_SIZE — każdy kawałek to osobne żądanie,
 * które jest strumieniowane prosto do magazynu (prawie zero CPU w Workerze, limit KV to 25 MiB na wartość).
 */
export const CHUNK_SIZE = 20 * 1024 * 1024;

export interface BlobStore {
  kind: 'r2' | 'kv';
  put(key: string, body: ReadableStream | ArrayBuffer, contentType?: string): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
}

export function getStore(env: Env): BlobStore | null {
  if (env.FILES) {
    const b = env.FILES;
    return {
      kind: 'r2',
      async put(key, body, contentType) {
        await b.put(key, body, contentType ? { httpMetadata: { contentType } } : undefined);
      },
      async get(key) {
        return (await b.get(key))?.body ?? null;
      },
      async delete(key) {
        await b.delete(key);
      },
    };
  }
  if (env.FILES_KV) {
    const kv = env.FILES_KV;
    return {
      kind: 'kv',
      async put(key, body) {
        await kv.put(key, body);
      },
      async get(key) {
        return kv.get(key, 'stream');
      },
      async delete(key) {
        await kv.delete(key);
      },
    };
  }
  return null;
}

/** Skleja kawałki pliku w jeden strumień do pobrania */
export function concatParts(store: BlobStore, key: string, parts: number): ReadableStream {
  const { readable, writable } = new TransformStream();
  (async () => {
    try {
      for (let i = 0; i < parts; i++) {
        const s = await store.get(`${key}/${i}`);
        if (!s) throw new Error(`Brak części ${i} pliku`);
        await s.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    } catch (e) {
      await writable.abort(e);
    }
  })();
  return readable;
}

export async function deleteParts(store: BlobStore, key: string, parts: number): Promise<void> {
  const keys = [`${key}/preview`];
  for (let i = 0; i < parts; i++) keys.push(`${key}/${i}`);
  await Promise.all(keys.map((k) => store.delete(k).catch(() => undefined)));
}
