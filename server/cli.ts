import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { ensureLocalService, serviceUrl } from './bootstrap';
import type { Asset, Environment, Workflow } from '../src/model';
import type { RunRecord } from '../src/run-client';

async function request(path: string, body?: unknown) {
  const response = await fetch(serviceUrl + '/local-api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '本地工作流服务请求失败');
  return result;
}
function parse(args: string[]) {
  const options = new Map<string, string>();
  const booleans = new Set(['detach', 'confirm-restart', 'help']);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith('--')) throw new Error('参数需要以 -- 开头：' + argument);
    const split = argument.indexOf('=');
    const name = argument.slice(2, split < 0 ? undefined : split);
    if (!name || options.has(name)) throw new Error('参数名称为空或重复：' + name);
    if (booleans.has(name)) {
      const value = split < 0 ? 'true' : argument.slice(split + 1);
      if (!['true', 'false'].includes(value))
        throw new Error('布尔参数需要 true 或 false：' + name);
      options.set(name, value);
      continue;
    }
    const value = split < 0 ? args[++index] : argument.slice(split + 1);
    if (value === undefined) throw new Error('参数缺少内容：' + name);
    options.set(name, value);
  }
  return options;
}
const mime: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream',
  '.obj': 'text/plain',
  '.usdz': 'model/vnd.usdz+zip',
  '.usd': 'application/octet-stream',
};
async function upload(path: string, type: string, environment: string): Promise<Asset> {
  const extension = extname(path).toLowerCase();
  const contentType = mime[extension];
  const models = ['.glb', '.gltf', '.fbx', '.obj', '.usdz', '.usd'];
  if (
    !contentType ||
    (type === 'model3d' ? !models.includes(extension) : !contentType.startsWith(type + '/'))
  )
    throw new Error('文件类型与变量不匹配：' + path);
  const bytes = await readFile(resolve(path));
  const form = new FormData();
  form.append('file', new File([bytes], basename(path), { type: contentType }));
  const response = await fetch(serviceUrl + '/mivo/' + environment + '/api/v1/file/', {
    method: 'POST',
    body: form,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '文件上传失败');
  const item = Array.isArray(result) ? result[0] : result;
  const fileId = item?.fileId ?? item?.id;
  if (typeof fileId !== 'string' || !/^[a-f\d]{24}$/i.test(fileId)) {
    throw new Error('上传响应缺少有效文件 ID');
  }
  return { fileId, name: item.name ?? basename(path), mediaType: type };
}
async function waitRun(initial: RunRecord, output?: string) {
  let run = initial;
  let lastStatus = '';
  while (run.snapshot.status === 'running') {
    const status = JSON.stringify(run.snapshot.nodes);
    if (status !== lastStatus) {
      for (const [id, node] of Object.entries(run.snapshot.nodes)) {
        const title = run.workflow.nodes.find((item) => item.id === id)?.data.title ?? id;
        console.error(title + '：' + (node.stage ?? node.status));
      }
      lastStatus = status;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    run = await request('/runs/' + run.id);
  }
  const end = run.workflow.nodes.find((node) => node.type === 'end');
  const result = end ? run.snapshot.nodes[end.id]?.output : undefined;
  if (output && result && run.snapshot.status === 'success') {
    await mkdir(output, { recursive: true });
    for (const [index, asset] of result.assets.entries()) {
      const response = await fetch(
        serviceUrl +
          '/mivo/' +
          run.snapshot.environment +
          '/api/v1/file/asset/' +
          asset.fileId +
          '?profile=original&export_proxy=true',
      );
      if (!response.ok) throw new Error('结果文件下载失败');
      const name = index + 1 + '-' + basename(asset.name).replaceAll(/[\x00-\x1f]/g, '_');
      await writeFile(join(output, name), Buffer.from(await response.arrayBuffer()));
    }
    await writeFile(
      join(output, 'result.json'),
      JSON.stringify({ runId: run.id, result }, null, 2),
    );
  }
  console.log(
    JSON.stringify(
      { runId: run.id, status: run.snapshot.status, output: result, error: run.error },
      null,
      2,
    ),
  );
  if (run.snapshot.status !== 'success') process.exitCode = 1;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parse(args);
  if (!command || command === '--help' || options.get('help') === 'true') {
    console.log(
      [
        'mivo-workflow list',
        'mivo-workflow show --workflow-id <id>',
        "mivo-workflow run --workflow-id <id> --字段1 '内容' --图片1 ./参考图.png",
        '  --environment local|test|production  --detach  --output ./outputs',
        '  --inputs-json ./inputs.json（用于包含空格或与命令选项同名的变量）',
        'mivo-workflow status --run-id <id>',
        'mivo-workflow stop --run-id <id>',
        'mivo-workflow resume --run-id <id> [--detach]',
        'mivo-workflow serve',
      ].join('\n'),
    );
    return;
  }
  await ensureLocalService();
  if (command === 'serve') {
    console.log(serviceUrl);
    return;
  }
  if (command === 'list') {
    const library = await request('/library');
    console.log(
      JSON.stringify(
        library.workflows.map((item: Workflow) => ({ id: item.id, name: item.name })),
        null,
        2,
      ),
    );
    return;
  }
  if (['status', 'stop', 'resume'].includes(command)) {
    const id = options.get('run-id');
    if (!id) throw new Error('请指定 --run-id');
    const suffix = command === 'status' ? '' : '/' + command;
    const run = await request(
      '/runs/' + encodeURIComponent(id) + suffix,
      command === 'status' ? undefined : {},
    );
    if (command === 'resume' && options.get('detach') !== 'true')
      await waitRun(run, options.get('output'));
    else console.log(JSON.stringify(run, null, 2));
    return;
  }
  if (!['show', 'run'].includes(command)) throw new Error('未知命令：' + command);
  const id = options.get('workflow-id');
  if (!id) throw new Error('请指定 --workflow-id');
  const workflow: Workflow = await request('/workflows/' + encodeURIComponent(id));
  if (command === 'show') {
    console.log(JSON.stringify(workflow, null, 2));
    return;
  }
  const settings = await request('/settings');
  const environment = options.get('environment') ?? settings.environment ?? 'local';
  if (!['local', 'test', 'production'].includes(environment)) throw new Error('无效的 API 环境');
  const reserved = new Set([
    'workflow-id',
    'environment',
    'detach',
    'output',
    'confirm-restart',
    'inputs-json',
  ]);
  const supplied = options.has('inputs-json')
    ? JSON.parse(await readFile(resolve(options.get('inputs-json')!), 'utf8'))
    : {};
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
    throw new Error('inputs-json 必须是变量名到值的 JSON 对象');
  }
  const raw = Object.fromEntries([...options].filter(([name]) => !reserved.has(name)));
  const values = { ...supplied, ...raw };
  const fields = workflow.nodes.find((node) => node.type === 'start')?.data.fields ?? [];
  const inputs: Record<string, string | Asset> = {};
  // Validate all names and value shapes before uploading anything.
  for (const [name, value] of Object.entries(values)) {
    if (!fields.some((field) => field.name.trim() === name)) throw new Error('未知变量：' + name);
    if (typeof value !== 'string') throw new Error('变量内容或本地文件路径必须是字符串：' + name);
  }
  for (const [name, value] of Object.entries(values)) {
    const field = fields.find((item) => item.name.trim() === name)!;
    Object.defineProperty(inputs, name, {
      enumerable: true,
      value:
        field.type === 'string' ? value : await upload(value as string, field.type, environment),
    });
  }
  const run = await request('/runs', {
    workflowId: id,
    inputs,
    environment,
    confirmRestart: options.get('confirm-restart') === 'true',
  });
  if (options.get('detach') === 'true')
    console.log(JSON.stringify({ runId: run.id, status: run.snapshot.status }));
  else await waitRun(run, options.get('output'));
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : '命令执行失败');
  process.exitCode = 1;
});
