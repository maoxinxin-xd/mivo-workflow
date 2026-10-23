import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { environments, type Environment } from '../src/model';
import {
  initializeAdapter,
  publicSettings,
  configureMivo,
  clearMivo,
  configureLlm,
  credentials,
  mivoRequest,
  llmRequest,
  catalogScope,
  publicSession,
} from './adapter';
import * as repository from './database';
import { startRun, stopRun, requireRun, recoverInterruptedRuns, pauseActiveRuns } from './runs';

const port = Number(process.env.MIVO_WORKFLOW_PORT ?? 9531);
const origins = new Set([
  'http://127.0.0.1:9530',
  'http://localhost:9530',
  'http://127.0.0.1:' + port,
  'http://localhost:' + port,
]);
const hosts = new Set([...origins].map((origin) => new URL(origin).host));
function environment(value: unknown): Environment {
  if (typeof value !== 'string' || !Object.hasOwn(environments, value)) {
    throw new Error('无效的 API 环境');
  }
  return value as Environment;
}
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage, limit = 8 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求数据过大'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(request: IncomingMessage) {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw Object.assign(new Error('请求需要 application/json'), { status: 415 });
  }
  try {
    return JSON.parse((await body(request)).toString());
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('JSON 格式无效');
    throw error;
  }
}
const upstreamPaths = {
  GET: [
    /^\/capabilities\/(search|[\w.-]+)$/,
    /^\/message\/[a-f\d]{24}\/result$/i,
    /^\/file\/(asset|download|meta)\/[a-f\d]{24}$/i,
  ],
  POST: [/^\/file\/$/, /^\/file\/(resolve|signUrl)$/],
};
async function handle(request: IncomingMessage, response: ServerResponse) {
  const origin = request.headers.origin;
  if (
    !hosts.has(request.headers.host ?? '') ||
    (origin && !origins.has(origin)) ||
    request.headers['sec-fetch-site'] === 'cross-site'
  ) {
    json(response, { error: '请求来源不允许' }, 403);
    return;
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = request.method ?? 'GET';
  const signal = AbortSignal.timeout(120_000);
  if (path === '/local-api/health' && method === 'GET') {
    json(response, { service: 'mivo-workflow', version: 1 });
    return;
  }
  if (path === '/local-api/library' && method === 'GET') {
    json(response, repository.library());
    return;
  }
  if (path === '/local-api/library/migrate' && method === 'POST') {
    json(response, repository.migrateLibrary((await jsonBody(request)).library));
    return;
  }
  if (path === '/local-api/workflows' && method === 'POST') {
    const input = await jsonBody(request);
    json(response, repository.saveWorkflow(input.workflow, input.preserveDraft === true));
    return;
  }
  const workflowMatch = path.match(/^\/local-api\/workflows\/([^/]+)$/);
  if (workflowMatch && method === 'GET') {
    json(response, repository.getWorkflow(decodeURIComponent(workflowMatch[1])));
    return;
  }
  if (path === '/local-api/drafts/select' && method === 'POST') {
    const input = await jsonBody(request);
    json(response, repository.selectDraft(input.workflowId, input.draftId));
    return;
  }
  if (path === '/local-api/settings' && method === 'GET') {
    json(response, publicSettings());
    return;
  }
  if (path === '/local-api/settings' && method === 'PUT') {
    repository.setSetting('environment', environment((await jsonBody(request)).environment));
    json(response, publicSettings());
    return;
  }
  if (path === '/local-api/settings/mivo' && method === 'POST') {
    const input = await jsonBody(request);
    await configureMivo(environment(input.environment), String(input.apiKey ?? ''));
    json(response, publicSettings());
    return;
  }
  const clearMatch = path.match(/^\/local-api\/settings\/mivo\/([^/]+)$/);
  if (clearMatch && method === 'DELETE') {
    clearMivo(environment(clearMatch[1]));
    json(response, publicSettings());
    return;
  }
  if (path === '/local-api/settings/llm' && method === 'PUT') {
    configureLlm(String((await jsonBody(request)).apiKey ?? ''));
    json(response, publicSettings());
    return;
  }
  if (path === '/local-api/settings/migrate' && method === 'POST') {
    const input = await jsonBody(request);
    for (const env of Object.keys(environments) as Environment[]) {
      if (!credentials(env) && input.sessions?.[env]?.apiKey) {
        await configureMivo(env, String(input.sessions[env].apiKey), false);
      }
    }
    if (!repository.secret<string>('llm') && input.llmKey) configureLlm(String(input.llmKey));
    json(response, publicSettings());
    return;
  }
  if (path === '/local-api/cache/catalog') {
    const input = method === 'PUT' ? await jsonBody(request) : undefined;
    const scope = input?.scope ?? url.searchParams.get('scope');
    const valid = Object.keys(environments).some((env) => {
      try {
        return catalogScope(env as Environment) === scope;
      } catch {
        return false;
      }
    });
    if (!valid) throw Object.assign(new Error('能力缓存与当前账号不匹配'), { status: 403 });
    if (method === 'PUT') {
      const catalog = input.catalog;
      if (
        catalog?.version !== 1 ||
        !Number.isFinite(catalog.syncedAt) ||
        !Array.isArray(catalog.items)
      )
        throw new Error('能力缓存格式无效');
      repository.writeCatalog(scope, catalog);
    }
    json(response, repository.readCatalog(scope) ?? null);
    return;
  }
  if (path === '/local-api/runs/migrate' && method === 'POST') {
    const input = await jsonBody(request);
    if (!Array.isArray(input.snapshots)) throw new Error('运行记录迁移格式无效');
    const accepted: string[] = [];
    repository.transaction(() => {
      for (const snapshot of input.snapshots) {
        if (
          !snapshot ||
          typeof snapshot.workflowId !== 'string' ||
          typeof snapshot.owner !== 'string' ||
          !snapshot.nodes ||
          !['idle', 'running', 'success', 'error', 'paused'].includes(snapshot.status)
        )
          continue;
        const env = environment(snapshot.environment);
        if (snapshot.owner !== publicSession(env)?.owner) continue;
        const id = 'legacy-' + snapshot.workflowId + '-' + env + '-' + snapshot.owner;
        if (repository.getRun(id)) {
          accepted.push(id);
          continue;
        }
        let workflow;
        try {
          workflow = repository.getWorkflow(snapshot.workflowId);
        } catch {
          continue;
        }
        if (snapshot.status === 'running') snapshot.status = 'paused';
        for (const node of Object.values(snapshot.nodes) as Array<{ status: string }>) {
          if (node.status === 'running') node.status = 'paused';
        }
        repository.putRun({
          id,
          workflowId: workflow.id,
          workflow,
          inputs: {},
          snapshot,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        accepted.push(id);
      }
    });
    json(response, { migrated: true, accepted });
    return;
  }
  if (path === '/local-api/runs' && method === 'GET') {
    const env = environment(url.searchParams.get('environment') ?? 'local');
    const owner = publicSession(env)?.owner ?? 'local';
    json(
      response,
      repository.listRuns(url.searchParams.get('workflowId') ?? undefined, env, owner),
    );
    return;
  }
  if (path === '/local-api/runs' && method === 'POST') {
    const input = await jsonBody(request);
    json(
      response,
      await startRun({
        ...input,
        environment: environment(input.environment ?? repository.setting('environment') ?? 'local'),
      }),
      202,
    );
    return;
  }
  const runMatch = path.match(/^\/local-api\/runs\/([^/]+)(\/stop|\/resume)?$/);
  if (runMatch) {
    const id = decodeURIComponent(runMatch[1]);
    if (method === 'GET' && !runMatch[2]) {
      json(response, requireRun(id));
      return;
    }
    if (method === 'POST' && runMatch[2] === '/stop') {
      json(response, stopRun(id));
      return;
    }
    if (method === 'POST' && runMatch[2] === '/resume') {
      const old = requireRun(id);
      json(
        response,
        await startRun({
          workflowId: old.workflowId,
          environment: old.snapshot.environment,
          resumeRunId: old.id,
        }),
        202,
      );
      return;
    }
  }
  if (path.startsWith('/llm/') && method === 'POST') {
    json(response, await llmRequest(path.slice(5), await jsonBody(request), signal));
    return;
  }
  const mivo = path.match(/^\/mivo\/(local|test|production)\/api\/v1(\/.*)$/);
  if (mivo) {
    const env = environment(mivo[1]);
    const apiPath = mivo[2];
    const allowed = upstreamPaths[method as keyof typeof upstreamPaths];
    if (!allowed?.some((rule) => rule.test(apiPath))) {
      throw Object.assign(new Error('接口不存在'), { status: 404 });
    }
    let content: BodyInit | undefined;
    if (method === 'POST') {
      if (apiPath === '/file/') {
        const bytes = await body(request, 200 * 1024 * 1024);
        const parsed = new Response(bytes, {
          headers: { 'content-type': request.headers['content-type'] ?? '' },
        });
        content = await parsed.formData();
      } else content = JSON.stringify(await jsonBody(request));
    }
    const binary = /^\/file\/(asset|download)\//.test(apiPath);
    const cacheKey = catalogScope(env) + ':' + apiPath + url.search + ':' + (content ?? '');
    const cacheable =
      !binary && (/^\/capabilities\//.test(apiPath) || /^\/file\/(resolve|signUrl)$/.test(apiPath));
    let value = cacheable ? repository.readCache(cacheKey) : undefined;
    if (value === undefined) {
      value = await mivoRequest(env, apiPath + url.search, signal, content, binary);
      if (cacheable)
        repository.writeCache(
          cacheKey,
          value,
          Date.now() + (apiPath.startsWith('/capabilities/') ? 24 * 60 * 60_000 : 30_000),
        );
    }
    if (binary) {
      response.writeHead(200, {
        'content-type': value.type || 'application/octet-stream',
        'cache-control': 'private, no-store',
      });
      for await (const chunk of Readable.fromWeb(value.stream())) response.write(chunk);
      response.end();
    } else json(response, value);
    return;
  }
  throw Object.assign(new Error('接口不存在'), { status: 404 });
}
export function startLocalServer() {
  initializeAdapter();
  repository.ensureLibrary();
  recoverInterruptedRuns();
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      json(
        response,
        {
          error: error instanceof Error ? error.message : '本地服务请求失败',
          confirmRestartRequired: error.confirmRestartRequired === true,
        },
        error.status ?? 400,
      );
    });
  });
  server.listen(port, '127.0.0.1', () => console.log('Mivo 工作流服务：http://127.0.0.1:' + port));
  const shutdown = () => {
    pauseActiveRuns();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startLocalServer();
