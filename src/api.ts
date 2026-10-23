import { prepareGeneration, type GenerationProgress } from './generation';
import type { Asset, Bundle, Environment, NodeData } from './model';
import {
  cachedCapabilities,
  syncCapabilities,
  warmCapabilities,
  withSignal,
} from './capability-cache';
import {
  cachedPreviewBlob,
  resolveResource,
  signResource,
  type AssetProfile,
} from './resource-cache';

import { getHost, type PublicSession } from './host';
import { localRequest } from './local-client';
import { updateLlmStatus } from './llm';

const sessions = new Map<Environment, PublicSession>();
const base = (environment: Environment) => '/mivo/' + environment + '/api/v1';
const objectId = /^[a-f\d]{24}$/i;

function updateSettings(settings: any) {
  sessions.clear();
  for (const environment of ['local', 'test', 'production'] as Environment[]) {
    if (settings.sessions?.[environment]) sessions.set(environment, settings.sessions[environment]);
  }
  updateLlmStatus(settings.llmConfigured === true);
  window.dispatchEvent(new Event('mivo-session'));
}
export async function initializeSettings() {
  let settings = await localRequest('/settings');
  const legacy: Record<string, unknown> = {};
  const migratedKeys: string[] = [];
  for (const environment of ['local', 'test', 'production']) {
    const key = 'mivo-flowgram:session:' + environment;
    const raw = sessionStorage.getItem(key);
    if (!raw) continue;
    try {
      const saved = JSON.parse(raw);
      if (typeof saved?.apiKey === 'string' && saved.apiKey) {
        legacy[environment] = { apiKey: saved.apiKey };
        migratedKeys.push(key);
      }
    } catch {
      /* Keep unreadable legacy credentials for manual recovery. */
    }
  }
  const llmKey = sessionStorage.getItem('mivo-flowgram:llm-key') ?? '';
  if (Object.keys(legacy).length || llmKey) {
    settings = await localRequest('/settings/migrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessions: legacy, llmKey }),
    });
    for (const key of migratedKeys) sessionStorage.removeItem(key);
    if (llmKey) sessionStorage.removeItem('mivo-flowgram:llm-key');
  }
  updateSettings(settings);
}
export function getSession(environment: Environment) {
  return getHost()?.getSession(environment) ?? sessions.get(environment);
}
export async function logout(environment: Environment) {
  updateSettings(await localRequest('/settings/mivo/' + environment, { method: 'DELETE' }));
}
export async function login(
  environment: Environment,
  apiKey: string,
  onSync: () => void = () => {},
) {
  onSync();
  try {
    const settings = await localRequest('/settings/mivo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ environment, apiKey: apiKey.trim() }),
    });
    updateSettings(settings);
  } catch (error) {
    updateSettings(await localRequest('/settings'));
    throw error;
  }
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryWithNewId = false,
  ) {
    super(message);
  }
}

async function jsonResponse(response: Response): Promise<any> {
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(`Mivo 返回了无法读取的响应（${response.status}）`, response.status);
  }
  if (!response.ok || (typeof body?.code === 'number' && body.code !== 0)) {
    const detail = body?.detail ?? body?.error ?? body?.message;
    const message = typeof detail === 'string' ? detail : detail?.message;
    throw new ApiError(
      message || `Mivo 请求失败（${response.status}）`,
      response.status,
      detail?.retryWithNewId === true,
    );
  }
  return body && 'data' in body && 'code' in body ? body.data : body;
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export class MivoClient {
  private owner?: string;
  private version?: number;
  constructor(private environment: Environment) {
    const session = getSession(environment);
    this.owner = session?.owner;
    this.version = session?.version;
  }
  private assertSession() {
    const saved = getSession(this.environment);
    if (!saved) throw new Error('请先在设置中配置 Mivo API Key');
    this.owner ??= saved.owner;
    this.version ??= saved.version;
    if (saved.owner !== this.owner || saved.version !== this.version) {
      throw new Error('登录状态已更改，请重新运行');
    }
    return saved;
  }
  private async cacheScope() {
    const session = this.assertSession();
    return [this.environment, session.owner, session.version].join(':');
  }
  private async request(path: string, signal: AbortSignal, body?: BodyInit, binary = false) {
    signal.throwIfAborted();
    this.assertSession();
    const host = getHost();
    let result: any;
    if (host) {
      try {
        result = await host.request(this.environment, path, signal, body, binary);
      } catch (error) {
        if (error instanceof Error && 'status' in error) {
          throw new ApiError(
            error.message,
            Number(error.status),
            'retryWithNewId' in error && error.retryWithNewId === true,
          );
        }
        throw error;
      }
    } else {
      const response = await fetch(base(this.environment) + path, {
        method: body === undefined ? 'GET' : 'POST',
        cache: 'no-store',
        headers: typeof body === 'string' ? { 'content-type': 'application/json' } : undefined,
        body,
        signal,
      });
      result = binary && response.ok ? await response.blob() : await jsonResponse(response);
    }
    this.assertSession();
    return result;
  }

  async syncCapabilities() {
    const scope = await this.cacheScope();
    return syncCapabilities(scope, (path, signal, body) => this.request(path, signal, body));
  }

  async warmCapabilities(signal: AbortSignal) {
    const scope = await this.cacheScope();
    return withSignal(
      warmCapabilities(scope, (path, abort, body) => this.request(path, abort, body)),
      signal,
    );
  }

  async resolveAsset(asset: Asset, signal: AbortSignal) {
    if (!objectId.test(asset.fileId)) throw new Error('无效的文件 ID');
    const scope = await this.cacheScope();
    const result = await resolveResource(
      scope,
      asset.fileId,
      (path, abort, body) => this.request(path, abort, body),
      signal,
    );
    this.assertSession();
    return result;
  }

  async assetUrls(asset: Asset, profiles: AssetProfile[], signal: AbortSignal) {
    if (!objectId.test(asset.fileId)) throw new Error('无效的文件 ID');
    const scope = await this.cacheScope();
    const result = await signResource(
      scope,
      asset.fileId,
      profiles,
      (path, abort, body) => this.request(path, abort, body),
      signal,
    );
    this.assertSession();
    return result;
  }

  async previewBlob(
    asset: Asset,
    profile: Exclude<AssetProfile, 'original'>,
    signal: AbortSignal,
  ): Promise<Blob> {
    if (!objectId.test(asset.fileId)) throw new Error('无效的文件 ID');
    const scope = await this.cacheScope();
    const blob = await cachedPreviewBlob(
      scope,
      asset.fileId,
      profile,
      (abort) =>
        this.request(
          `/file/asset/${asset.fileId}?profile=${profile}&export_proxy=true`,
          abort,
          undefined,
          true,
        ),
      signal,
    );
    this.assertSession();
    return blob;
  }

  private preloadAssets(assets: Asset[]) {
    const signal = AbortSignal.timeout(30_000);
    for (const asset of assets) {
      void this.resolveAsset(asset, signal).catch(() => {});
    }
  }

  async generate(
    data: NodeData,
    input: Bundle,
    _requestId: string,
    signal: AbortSignal,
    onSubmitted: (messageId: string) => void,
    onProgress: (progress: GenerationProgress) => void = () => {},
  ): Promise<Bundle> {
    const unique = [...new Map(input.assets.map((asset) => [asset.fileId, asset])).values()];
    onProgress({ stage: '读取本地能力缓存' });
    const catalog = await cachedCapabilities(await this.cacheScope(), signal);
    this.assertSession();
    let resourceInfo: Awaited<ReturnType<MivoClient['resolveAsset']>>[] = [];
    if (unique.length) {
      onProgress({ stage: '读取参考素材尺寸' });
      const metadataSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
      const resolved = await Promise.all(
        unique.map((asset) => this.resolveAsset(asset, metadataSignal).catch(() => undefined)),
      );
      signal.throwIfAborted();
      this.assertSession();
      resourceInfo = resolved.filter((info) => info !== undefined && info.status === 'ok');
    }
    const prepared = await prepareGeneration(
      catalog,
      data,
      input,
      unique,
      signal,
      onProgress,
      resourceInfo,
    );
    onProgress({ stage: '创建生成会话' });
    const session = await this.request(
      '/message/chat',
      signal,
      JSON.stringify({ type: prepared.chatSessionType ?? 'freeform' }),
    );
    const sessionId = session?.id ?? session?.object_id ?? session?._id;
    if (typeof sessionId !== 'string' || !objectId.test(sessionId)) {
      throw new Error('Mivo 未返回有效的生成会话 ID');
    }
    const pointer = prepared.chatSessionPointer ?? '/chatSessionId';
    const parts = pointer
      .slice(1)
      .split('/')
      .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    let target = prepared.body;
    for (const part of parts.slice(0, -1)) {
      if (['__proto__', 'prototype', 'constructor'].includes(part)) {
        throw new Error('会话协议包含无效的字段位置');
      }
      target = target[part] ??= {};
    }
    const last = parts.at(-1)!;
    if (['__proto__', 'prototype', 'constructor'].includes(last)) {
      throw new Error('会话协议包含无效的字段位置');
    }
    target[last] = sessionId;
    const body = JSON.stringify(prepared.body);
    signal.throwIfAborted();
    // Persist before the POST. A lost response must never cause an automatic duplicate.
    onProgress({ stage: '提交生成任务', submissionUncertain: true });
    let result: any;
    try {
      result = await this.request('/message', signal, body);
    } catch (error) {
      if (error instanceof ApiError && [400, 401, 403, 404, 405, 422, 429].includes(error.status)) {
        onProgress({ submissionUncertain: false });
        throw error;
      }
      throw new Error('提交结果待确认，请先在 Mivo 检查任务；确认未提交后再重新运行工作流');
    }
    const messageId = result?.id ?? result?.object_id ?? result?._id;
    if (typeof messageId !== 'string' || !objectId.test(messageId)) {
      throw new Error('提交响应缺少任务 ID，请先在 Mivo 检查任务，避免重复生成');
    }
    onSubmitted(messageId);
    onProgress({ stage: '等待生成结果', submissionUncertain: false });
    return this.poll(messageId, signal);
  }

  async poll(messageId: string, signal: AbortSignal): Promise<Bundle> {
    if (!objectId.test(messageId)) throw new Error('无效的生成任务 ID');
    const deadline = Date.now() + 30 * 60_000;
    let completedAt = 0;
    while (Date.now() < deadline) {
      const result = await this.request(`/message/${messageId}/result?force=true`, signal);
      const content = result?.content ?? {};
      const status = String(result?.status ?? content.status ?? 'processing').toLowerCase();
      if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)) {
        throw new ApiError(
          typeof content.error === 'string' ? content.error : 'Mivo 生成任务失败',
          422,
          true,
        );
      }
      if (['success', 'completed'].includes(status)) {
        const assets = extractAssets(content);
        if (assets.length) {
          this.preloadAssets(assets);
          return {
            text: typeof content.text === 'string' ? content.text : (result.title ?? ''),
            assets,
          };
        }
        completedAt ||= Date.now();
        if (Date.now() - completedAt > 20_000) {
          throw new Error('任务已完成，但没有返回可展示的资源');
        }
      } else {
        completedAt = 0;
      }
      await wait(3000, signal);
    }
    throw new Error('等待已超过 30 分钟，可以恢复运行继续查询');
  }

  async upload(file: File, signal: AbortSignal): Promise<Asset> {
    const form = new FormData();
    form.append('file', file);
    const response = await this.request('/file/', signal, form);
    const item = Array.isArray(response) ? response[0] : response;
    const fileId = item?.fileId ?? item?.id;
    if (typeof fileId !== 'string' || !objectId.test(fileId)) {
      throw new Error('Mivo 未返回有效的文件 ID');
    }
    const asset: Asset = {
      fileId,
      name: item.name ?? file.name,
      mediaType: file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('video/')
          ? 'video'
          : file.type.startsWith('audio/')
            ? 'audio'
            : /\.(glb|gltf|fbx|obj|usdz|usd)$/i.test(file.name)
              ? 'model3d'
              : 'file',
    };
    this.preloadAssets([asset]);
    return asset;
  }

  async blob(asset: Asset, signal: AbortSignal, download = false): Promise<Blob> {
    if (!objectId.test(asset.fileId)) throw new Error('无效的文件 ID');
    const path = download
      ? `/file/download/${asset.fileId}?attachment=true`
      : `/file/asset/${asset.fileId}?profile=original&export_proxy=true`;
    return this.request(path, signal, undefined, true);
  }
}

function extractAssets(content: Record<string, unknown>): Asset[] {
  const assets: Asset[] = [];
  const groups = {
    images: 'image',
    videos: 'video',
    audios: 'audio',
    model_files: 'model3d',
  };
  for (const [field, mediaType] of Object.entries(groups)) {
    const values = content[field];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const raw =
        typeof value === 'string'
          ? value
          : (value?.fileId ?? value?.file_id ?? value?.id ?? value?.uri ?? value?.url);
      if (typeof raw !== 'string') continue;
      const fileId = objectId.test(raw)
        ? raw
        : raw.match(/\/file\/(?:asset|download|image|video|audio)\/([a-f\d]{24})(?:$|[/?#])/i)?.[1];
      if (!fileId || assets.some((asset) => asset.fileId === fileId)) continue;
      const names = content.image_names;
      const name = Array.isArray(names) && mediaType === 'image' ? names[assets.length] : '';
      assets.push({ fileId, name: String(name || `${mediaType}-${assets.length + 1}`), mediaType });
    }
  }
  return assets;
}
