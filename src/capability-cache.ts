import { getHost } from './host';
import { localRequest } from './local-client';
import type { Capability } from './generation-protocol';

export type CatalogRequest = (path: string, signal: AbortSignal, body?: BodyInit) => Promise<any>;

interface Catalog {
  version: 1;
  syncedAt: number;
  items: Capability[];
}

const memory = new Map<string, Catalog>();
const syncing = new Map<string, Promise<Catalog>>();
export function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function isCapability(value: any): value is Capability {
  return (
    typeof value?.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.summary === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.mediaType === 'string' &&
    typeof value.execution === 'string' &&
    !!value.request?.bodyTemplate &&
    typeof value.request.bodyTemplate === 'object' &&
    !!value.request?.parameters &&
    typeof value.request.parameters === 'object'
  );
}

async function readCatalog(scope: string): Promise<Catalog | undefined> {
  if (memory.has(scope)) return memory.get(scope);
  const host = getHost();
  const saved = host
    ? await host.readCatalog(scope)
    : await localRequest('/cache/catalog?scope=' + encodeURIComponent(scope));
  if (
    saved?.version === 1 &&
    Number.isFinite(saved.syncedAt) &&
    Array.isArray(saved.items) &&
    saved.items.length &&
    saved.items.every(isCapability)
  ) {
    memory.set(scope, saved);
    return saved;
  }
}
async function writeCatalog(scope: string, catalog: Catalog) {
  const host = getHost();
  if (host) await host.writeCatalog(scope, catalog);
  else
    await localRequest('/cache/catalog', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, catalog }),
    });
  memory.set(scope, catalog);
}

export async function syncCapabilities(scope: string, request: CatalogRequest): Promise<Catalog> {
  const existing = syncing.get(scope);
  if (existing) return existing;
  const task = (async () => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
    // No limit or media filter: cache every discoverable capability and its full protocol.
    const list = await request('/capabilities/search', signal);
    if (
      !Array.isArray(list) ||
      !list.length ||
      list.some((item) => typeof item?.id !== 'string' || !item.id)
    ) {
      throw new Error('Mivo 全量能力列表格式无效');
    }
    const ids = [...new Set<string>(list.map((item) => item.id))];
    const items: Capability[] = new Array(ids.length);
    let next = 0;
    try {
      await Promise.all(
        Array.from({ length: Math.min(4, ids.length) }, async () => {
          while (next < ids.length) {
            signal.throwIfAborted();
            const index = next++;
            const detail = await request(`/capabilities/${encodeURIComponent(ids[index])}`, signal);
            if (!isCapability(detail) || detail.id !== ids[index]) {
              throw new Error('Mivo 能力详情格式无效，请重新同步');
            }
            items[index] = detail;
          }
        }),
      );
    } catch (error) {
      controller.abort();
      throw error;
    }
    const catalog: Catalog = { version: 1, syncedAt: Date.now(), items };
    await writeCatalog(scope, catalog);
    return catalog;
  })();
  syncing.set(scope, task);
  try {
    return await task;
  } finally {
    if (syncing.get(scope) === task) syncing.delete(scope);
  }
}

export async function warmCapabilities(scope: string, request: CatalogRequest) {
  if (syncing.has(scope)) return syncing.get(scope)!;
  const saved = await readCatalog(scope);
  if (saved && Date.now() - saved.syncedAt < 24 * 60 * 60_000) return saved;
  return syncCapabilities(scope, request);
}

export async function cachedCapabilities(
  scope: string,
  signal: AbortSignal,
): Promise<Capability[]> {
  const catalog = await withSignal(syncing.get(scope) ?? readCatalog(scope), signal);
  if (!catalog) throw new Error('能力尚未缓存，请在设置中重新保存 Mivo API Key');
  return catalog.items;
}
