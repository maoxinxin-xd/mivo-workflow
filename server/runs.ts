import { WorkflowRunner } from '../src/runtime';
import { MivoClient } from '../src/api';
import { graphKey, type Asset, type Environment, type Workflow } from '../src/model';
import { validateWorkflow } from '../src/workflow-validation';
import { publicSession } from './adapter';
import * as repository from './database';

const active = new Map<string, WorkflowRunner>();
export interface RunRequest {
  workflowId: string;
  workflow?: Workflow;
  inputs?: Record<string, string | Asset>;
  environment: Environment;
  nodeId?: string;
  resumeRunId?: string;
  confirmRestart?: boolean;
}
export function recoverInterruptedRuns() {
  for (const run of repository.interruptedRuns()) {
    run.snapshot.status = 'paused';
    for (const node of Object.values(run.snapshot.nodes)) {
      if (node.status === 'running') node.status = 'paused';
    }
    run.error = '本地服务已重启，可继续查询已提交的任务';
    run.updatedAt = Date.now();
    repository.putRun(run);
  }
}
export function requireRun(id: string) {
  const run = repository.getRun(id);
  if (!run) throw Object.assign(new Error('运行记录不存在'), { status: 404 });
  const owner = publicSession(run.snapshot.environment)?.owner ?? 'local';
  if (run.snapshot.owner !== owner) {
    throw Object.assign(new Error('运行记录属于其他账号'), { status: 403 });
  }
  return run;
}
export async function startRun(request: RunRequest) {
  const owner = publicSession(request.environment)?.owner ?? 'local';
  const runs = repository.listRuns(request.workflowId, request.environment, owner);
  if (runs.some((run) => active.has(run.id))) {
    throw Object.assign(new Error('此工作流正在运行，请先暂停'), { status: 409 });
  }
  let workflow = validateWorkflow(request.workflow ?? repository.getWorkflow(request.workflowId));
  if (workflow.id !== request.workflowId) throw new Error('工作流 ID 不匹配');
  let checkpoint = request.resumeRunId ? requireRun(request.resumeRunId) : undefined;
  if (
    checkpoint &&
    (checkpoint.workflowId !== request.workflowId ||
      checkpoint.snapshot.environment !== request.environment)
  ) {
    throw new Error('恢复记录与工作流或环境不匹配');
  }
  if (checkpoint && ['running', 'success'].includes(checkpoint.snapshot.status)) {
    throw new Error('只能恢复暂停或失败的运行');
  }
  if (!checkpoint && request.nodeId) checkpoint = runs[0];
  const uncertain = runs.some((run) =>
    Object.values(run.snapshot.nodes).some(
      (node) =>
        node.submissionUncertain ||
        node.invalidatedSubmission ||
        (node.messageId && !['success', 'skipped', 'error'].includes(node.status)),
    ),
  );
  if (!checkpoint && uncertain && !request.confirmRestart) {
    throw Object.assign(new Error('存在待确认的生成任务，请先恢复运行或确认后重新运行'), {
      status: 409,
      confirmRestartRequired: true,
    });
  }
  if (request.resumeRunId) {
    if (Object.keys(request.inputs ?? {}).length) throw new Error('恢复运行时不能更改输入');
    workflow = structuredClone(checkpoint!.workflow);
  } else {
    const start = workflow.nodes.find((node) => node.type === 'start')!;
    const fields = start.data.fields ?? [];
    const entries = Object.entries(request.inputs ?? {});
    const rebindings: Array<[string, string]> = [];
    for (const [name, value] of entries) {
      const field = fields.find((item) => item.name.trim() === name);
      if (!field) throw new Error('未知变量：' + name);
      if (field.type === 'string') {
        if (typeof value !== 'string') throw new Error(name + ' 需要字符串');
        field.value = value;
      } else {
        if (
          !value ||
          typeof value !== 'object' ||
          !/^[a-f\d]{24}$/i.test(value.fileId) ||
          value.mediaType !== field.type ||
          typeof value.name !== 'string'
        ) {
          throw new Error(name + ' 需要已上传的对应类型文件');
        }
        const previousId = field.asset?.fileId;
        field.asset = value;
        // Existing workflows may reference a default upload by ID. Rebind those references.
        if (previousId && previousId !== value.fileId) {
          const before = start.id + '.assets.' + previousId;
          const after = start.id + '.assets.' + value.fileId;
          rebindings.push([before, after]);
        }
      }
    }
    if (rebindings.length) {
      workflow = JSON.parse(
        JSON.stringify(workflow, (_key, item) =>
          typeof item === 'string'
            ? rebindings.reduce((text, [before, after]) => text.replaceAll(before, after), item)
            : item,
        ),
      );
    }
    workflow = validateWorkflow(workflow);
  }
  if (workflow.nodes.some((node) => node.type === 'generate') && owner === 'local') {
    throw new Error('请先在设置中配置当前环境的 Mivo API Key');
  }
  const now = Date.now();
  const record: repository.StoredRun = {
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    workflow,
    inputs: request.resumeRunId ? checkpoint!.inputs : (request.inputs ?? {}),
    createdAt: now,
    updatedAt: now,
    snapshot: {
      workflowId: workflow.id,
      graph: graphKey(workflow),
      environment: request.environment,
      owner,
      status: 'running',
      nodes: {},
    },
  };
  const runner = new WorkflowRunner({
    workflow,
    environment: request.environment,
    owner,
    client: new MivoClient(request.environment),
    checkpoint: checkpoint?.snapshot,
    onChange: (snapshot) => {
      record.snapshot = snapshot;
      record.updatedAt = Date.now();
      repository.putRun(record);
    },
  });
  repository.putRun(record);
  active.set(record.id, runner);
  // Detached from the HTTP response and browser connection; persist before any next side effect.
  void runner
    .run(request.nodeId)
    .catch((error) => {
      record.error = error instanceof Error ? error.message : String(error);
      record.snapshot = runner.snapshot;
      if (record.snapshot.status === 'running') record.snapshot.status = 'error';
      record.updatedAt = Date.now();
      repository.putRun(record);
    })
    .finally(() => active.delete(record.id));
  return record;
}
export function stopRun(id: string) {
  const record = requireRun(id);
  active.get(id)?.stop();
  return repository.getRun(record.id)!;
}
export function pauseActiveRuns() {
  for (const runner of active.values()) runner.stop();
}
