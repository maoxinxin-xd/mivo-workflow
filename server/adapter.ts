import { createHash } from 'node:crypto';
import { MivoClient } from '../src/api';
import { configureHost } from '../src/host';
import type { Environment } from '../src/model';
import * as repository from './database';

interface Credentials {
  apiKey: string;
  token: string;
  expiresAt: number;
  owner: string;
  userName: string;
}
const upstreams: Record<Environment, string> = {
  local: process.env.MIVO_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8000',
  test: 'https://dev-ai-mid.xindong.com',
  production: 'https://aigc.xindong.com',
};
const refreshes = new Map<Environment, Promise<Credentials>>();
const sessionKey = (environment: Environment) => 'mivo:' + environment;
export function credentials(environment: Environment) {
  return repository.secret<Credentials>(sessionKey(environment));
}
function version(environment: Environment) {
  return repository.setting<number>('session-version:' + environment) ?? 0;
}
export function publicSession(environment: Environment) {
  const saved = credentials(environment);
  return saved
    ? { owner: saved.owner, userName: saved.userName, version: version(environment) }
    : undefined;
}
export function publicSettings() {
  return {
    sessions: Object.fromEntries(
      Object.keys(upstreams).map((environment) => [
        environment,
        publicSession(environment as Environment),
      ]),
    ),
    llmConfigured: !!repository.secret<string>('llm'),
    environment: repository.setting<Environment>('environment') ?? 'local',
  };
}
async function responseJSON(response: Response) {
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw Object.assign(new Error('上游服务返回了无法读取的响应'), { status: response.status });
  }
  if (!response.ok || (typeof body?.code === 'number' && body.code !== 0)) {
    const detail = body?.detail ?? body?.error ?? body?.message;
    const message = typeof detail === 'string' ? detail : detail?.message;
    throw Object.assign(new Error(message || '上游请求失败（HTTP ' + response.status + '）'), {
      status: response.status,
      retryWithNewId: detail?.retryWithNewId === true,
    });
  }
  return body && 'data' in body && 'code' in body ? body.data : body;
}
async function exchange(environment: Environment, apiKey: string): Promise<Credentials> {
  const response = await fetch(upstreams[environment] + '/api/v1/state/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
    signal: AbortSignal.timeout(120_000),
    redirect: 'error',
  });
  const result = await responseJSON(response);
  if (
    typeof result?.session !== 'string' ||
    !Number.isFinite(result.expiresAt) ||
    result.expiresAt <= Date.now()
  )
    throw new Error('Mivo 返回了无效的登录信息');
  const payload = JSON.parse(Buffer.from(result.session.split('.')[1], 'base64url').toString());
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('会话缺少用户身份');
  return {
    apiKey,
    token: result.session,
    expiresAt: result.expiresAt,
    owner: createHash('sha256').update(payload.sub).digest('hex'),
    userName: String(payload.realname || payload.name || payload.sub),
  };
}
export async function configureMivo(environment: Environment, raw: string, sync = true) {
  const apiKey = raw.trim();
  if (!apiKey) throw new Error('请输入 Mivo API Key');
  const next = await exchange(environment, apiKey);
  repository.transaction(() => {
    repository.setSecret(sessionKey(environment), next);
    repository.setSetting('session-version:' + environment, version(environment) + 1);
  });
  if (sync) {
    try {
      await new MivoClient(environment).syncCapabilities();
    } catch {
      throw new Error('Key 已配置，但能力同步失败；请重新保存以重试');
    }
  }
}
export function clearMivo(environment: Environment) {
  repository.transaction(() => {
    repository.setSecret(sessionKey(environment));
    repository.setSetting('session-version:' + environment, version(environment) + 1);
  });
}
export function configureLlm(raw: string) {
  const key = raw.trim();
  repository.setSecret('llm', key || undefined);
}
async function token(environment: Environment, previous: Credentials, rejected = false) {
  if (!rejected && previous.expiresAt > Date.now() + 60_000) return previous.token;
  let pending = refreshes.get(environment);
  if (!pending) {
    pending = exchange(environment, previous.apiKey)
      .then((next) => {
        if (credentials(environment)?.apiKey !== previous.apiKey || next.owner !== previous.owner) {
          throw new Error('登录状态已更改');
        }
        repository.setSecret(sessionKey(environment), next);
        return next;
      })
      .finally(() => refreshes.delete(environment));
    refreshes.set(environment, pending);
  }
  return (await pending).token;
}
export async function mivoRequest(
  environment: Environment,
  path: string,
  signal: AbortSignal,
  body?: BodyInit,
  binary = false,
): Promise<any> {
  const saved = credentials(environment);
  if (!saved) throw Object.assign(new Error('请先在设置中配置 Mivo API Key'), { status: 401 });
  const initialVersion = version(environment);
  const cacheable = typeof body === 'string' && ['/file/resolve', '/file/signUrl'].includes(path);
  const cacheKey = [environment, saved.owner, initialVersion, path, body ?? ''].join(':');
  if (cacheable) {
    const cached = repository.readCache(cacheKey);
    if (cached !== undefined) return cached;
  }
  let bearer = await token(environment, saved);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (initialVersion !== version(environment)) throw new Error('登录状态已更改');
    const headers: Record<string, string> = { Authorization: 'Bearer ' + bearer };
    if (typeof body === 'string') headers['content-type'] = 'application/json';
    let target = new URL(upstreams[environment] + '/api/v1' + path);
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      response = await fetch(target, {
        method: body === undefined ? 'GET' : 'POST',
        headers: target.origin === new URL(upstreams[environment]).origin ? headers : {},
        body,
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!binary || body !== undefined || !location || redirects >= 3) {
        throw new Error('上游服务返回了无法处理的重定向');
      }
      const destination = new URL(location, target);
      if (
        destination.username ||
        destination.password ||
        (destination.origin !== new URL(upstreams[environment]).origin &&
          destination.protocol !== 'https:')
      )
        throw new Error('文件重定向地址无效');
      target = destination;
    }
    if (response.status === 401 && attempt === 0) {
      await response.body?.cancel();
      bearer = await token(environment, saved, true);
      continue;
    }
    const value = binary && response.ok ? await response.blob() : await responseJSON(response);
    if (initialVersion !== version(environment)) throw new Error('登录状态已更改');
    if (cacheable) repository.writeCache(cacheKey, value, Date.now() + 30_000);
    return value;
  }
  throw new Error('登录已失效，请重新配置 API Key');
}
export async function llmRequest(path: string, body: unknown, signal: AbortSignal) {
  const apiKey = repository.secret<string>('llm');
  if (!apiKey) throw new Error('请先在设置中配置 Tapsvc API Key');
  const routes: Record<string, string> = {
    decisions: '/api/alpha/decisions',
    'chat/completions': '/v1/chat/completions',
  };
  if (!routes[path]) throw new Error('模型接口不存在');
  const response = await fetch('https://llm-proxy.tapsvc.com' + routes[path], {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
    redirect: 'error',
  });
  if (!response.ok) throw new Error('模型请求失败（HTTP ' + response.status + '）');
  return response.json();
}
export function catalogScope(environment: Environment) {
  const session = publicSession(environment);
  if (!session) throw new Error('当前环境尚未登录');
  return [environment, session.owner, session.version].join(':');
}
export function initializeAdapter() {
  configureHost({
    getSession: publicSession,
    request: mivoRequest,
    llmConfigured: () => !!repository.secret<string>('llm'),
    llmRequest,
    readCatalog: async (scope) => repository.readCatalog(scope),
    writeCatalog: async (scope, catalog) => {
      repository.writeCatalog(scope, catalog);
    },
  });
}
