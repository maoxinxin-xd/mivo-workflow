import { withSignal, type CatalogRequest } from './capability-cache';

export type AssetProfile = 'placeholder' | 'preview-640' | 'original';

export interface ResourceInfo {
  fileId: string;
  status: 'ok' | 'not_found' | 'forbidden' | 'error';
  contentType?: string;
  size?: number;
  width?: number | null;
  height?: number | null;
  dimensionStatus?: 'ready' | 'pending' | 'unavailable';
}

export interface ResourceUrls {
  fileId: string;
  status: string;
  urls?: Partial<Record<AssetProfile, { url: string; expiresAt: number }>>;
  errors?: Partial<Record<AssetProfile, { status: string }>>;
}

interface Entry {
  value: ResourceInfo | ResourceUrls;
  expiresAt: number;
}

interface Pending {
  key: string;
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
}

interface Batch {
  path: string;
  profiles?: AssetProfile[];
  request: CatalogRequest;
  items: Map<string, Pending>;
}

const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<any>>();
const batches = new Map<string, Batch>();
const blobs = new Map<string, { expiresAt: number; value: Promise<Blob> }>();

function remember(key: string, entry: Entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > 512) cache.delete(cache.keys().next().value!);
}

async function flush(group: string) {
  const batch = batches.get(group)!;
  batches.delete(group);
  const entries = [...batch.items];
  for (let offset = 0; offset < entries.length; offset += 50) {
    const chunk = entries.slice(offset, offset + 50);
    try {
      const result = await batch.request(
        batch.path,
        AbortSignal.timeout(120_000),
        JSON.stringify({
          fileIds: chunk.map(([id]) => id),
          ...(batch.profiles ? { profiles: batch.profiles } : {}),
        }),
      );
      const items = batch.profiles ? result?.items : result;
      if (!Array.isArray(items)) throw new Error('Mivo 资源信息格式无效');
      for (const [fileId, item] of chunk) {
        const value = items.find((candidate) => candidate?.fileId === fileId);
        if (!value || typeof value.status !== 'string') {
          item.reject(new Error('Mivo 未返回资源信息'));
          continue;
        }
        const urls = Object.values(value.urls ?? {}) as Array<{ expiresAt: number }>;
        const expiresAt = batch.profiles
          ? urls.length
            ? Math.min(...urls.map((url) => url.expiresAt * 1000 - 60_000))
            : Date.now() + 30_000
          : Date.now() +
            (value.status !== 'ok'
              ? 30_000
              : value.dimensionStatus === 'pending'
                ? 3000
                : 5 * 60_000);
        remember(item.key, { value, expiresAt });
        item.resolve(value);
      }
    } catch (error) {
      for (const [, item] of chunk) item.reject(error);
    } finally {
      for (const [, item] of chunk) pending.delete(item.key);
    }
  }
}

async function resource<T extends ResourceInfo | ResourceUrls>(
  scope: string,
  fileId: string,
  request: CatalogRequest,
  signal: AbortSignal,
  profiles?: AssetProfile[],
): Promise<T> {
  signal.throwIfAborted();
  const group = JSON.stringify([scope, profiles ?? 'resolve']);
  const key = JSON.stringify([group, fileId]);
  const saved = cache.get(key);
  if (saved && saved.expiresAt > Date.now()) {
    return withSignal(Promise.resolve(saved.value as T), signal);
  }
  let task = pending.get(key);
  if (!task) {
    let batch = batches.get(group);
    if (!batch) {
      batch = {
        path: profiles ? '/file/signUrl' : '/file/resolve',
        profiles,
        request,
        items: new Map(),
      };
      batches.set(group, batch);
      setTimeout(() => void flush(group), 0);
    }
    task = new Promise<T>((resolve, reject) => {
      batch.items.set(fileId, { key, resolve, reject });
    });
    pending.set(key, task);
  }
  return withSignal(task, signal);
}

export const resolveResource = (
  scope: string,
  fileId: string,
  request: CatalogRequest,
  signal: AbortSignal,
) => resource<ResourceInfo>(scope, fileId, request, signal);

export const signResource = (
  scope: string,
  fileId: string,
  profiles: AssetProfile[],
  request: CatalogRequest,
  signal: AbortSignal,
) => resource<ResourceUrls>(scope, fileId, request, signal, profiles);

export function cachedPreviewBlob(
  scope: string,
  fileId: string,
  profile: Exclude<AssetProfile, 'original'>,
  load: (signal: AbortSignal) => Promise<Blob>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const key = JSON.stringify([scope, fileId, profile]);
  let saved = blobs.get(key);
  if (!saved || saved.expiresAt <= Date.now()) {
    const value = load(AbortSignal.timeout(120_000));
    saved = { value, expiresAt: Date.now() + 5 * 60_000 };
    blobs.delete(key);
    blobs.set(key, saved);
    void value.catch(() => {
      if (blobs.get(key)?.value === value) blobs.delete(key);
    });
    while (blobs.size > 64) blobs.delete(blobs.keys().next().value!);
  }
  return withSignal(saved.value, signal);
}

export function signedUrl(result: ResourceUrls, profile: AssetProfile): string | undefined {
  const entry = result.urls?.[profile];
  if (!entry || !Number.isFinite(entry.expiresAt)) return;
  if (entry.expiresAt * 1000 <= Date.now() + 30_000) return;
  try {
    const url = new URL(entry.url.startsWith('//') ? `https:${entry.url}` : entry.url);
    if (url.protocol === 'https:') return url.href;
  } catch {
    return;
  }
}
