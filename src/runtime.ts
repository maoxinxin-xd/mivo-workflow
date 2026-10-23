import type { MivoClient } from './api';
import {
  graphKey,
  type Bundle,
  type Environment,
  type NodeRun,
  type RunSnapshot,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from './model';
import { nodeRunSignatures, reconcileSnapshot } from './run-state';

interface RunnerOptions {
  workflow: Workflow;
  environment: Environment;
  owner: string;
  client: Pick<MivoClient, 'generate' | 'poll'>;
  onChange: (snapshot: RunSnapshot) => void;
  checkpoint?: RunSnapshot;
}

interface Graph {
  nodes: Map<string, WorkflowNode>;
  incoming: Map<string, WorkflowEdge[]>;
  outgoing: Map<string, WorkflowEdge[]>;
  ancestors: Map<string, Set<string>>;
  order: string[];
  startId: string;
  endId: string;
}

interface Context {
  outputs: Map<string, Bundle>;
  latest: Bundle;
}

const emptyBundle = (): Bundle => ({ text: '', assets: [] });
const clone = <T>(value: T): T => structuredClone(value);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function merge(bundles: Bundle[]): Bundle {
  const assets = new Map(bundles.flatMap((bundle) => bundle.assets.map((a) => [a.fileId, a])));
  return {
    text: [...new Set(bundles.map((bundle) => bundle.text).filter(Boolean))].join('\n\n'),
    assets: [...assets.values()],
    fields: Object.fromEntries(bundles.flatMap((bundle) => Object.entries(bundle.fields ?? {}))),
    variables: Object.fromEntries(
      bundles.flatMap((bundle) => Object.entries(bundle.variables ?? {})),
    ),
  };
}

function referencePath(reference: string): string[] {
  return reference
    .trim()
    .replace(/^\{\{\s*|\s*\}\}$/g, '')
    .split('.');
}

function resolve(reference: string, context: Context): string {
  const [id, kind, ...field] = referencePath(reference);
  const output = context.outputs.get(id);
  if (!output) throw new Error(`引用 ${reference} 的上游节点尚未成功运行或分支未命中`);
  if (kind === 'text' && field.length === 0) return output.text;
  if (kind === 'fields' && field.length > 0) {
    const name = field.join('.');
    if (output.fields && Object.hasOwn(output.fields, name)) return output.fields[name];
  }
  throw new Error(`引用 ${reference} 不存在，请重新选择上游输出`);
}

function resolveAssets(reference: string, context: Context) {
  const [id, kind, ...selectorParts] = referencePath(reference);
  const selector = selectorParts.join('.');
  const output = context.outputs.get(id);
  if (!output) throw new Error(`引用 ${reference} 的上游节点尚未运行或分支未命中`);
  if (kind === 'variables' && selector) {
    const asset = output.variables?.[selector];
    if (asset) return [asset];
    throw new Error(`引用 ${reference} 没有可用资源，请检查上游输出`);
  }
  if (kind !== 'assets' && kind !== 'outputs') {
    throw new Error(`引用 ${reference} 不是资源`);
  }
  const asset = kind === 'outputs' ? output.assets[Number(selector)] : undefined;
  const assets =
    kind === 'outputs'
      ? asset
        ? [asset]
        : []
      : selector
        ? output.assets.filter((item) => item.fileId === selector)
        : output.assets;
  if (!assets.length) throw new Error(`引用 ${reference} 没有可用资源，请检查上游输出`);
  return assets;
}

function template(text: string | undefined, context: Context): string {
  return (text ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path: string) =>
    ['assets', 'outputs', 'variables'].includes(referencePath(path)[1])
      ? `参考资源（${resolveAssets(path, context)
          .map((asset) => asset.name)
          .join('、')}）`
      : resolve(path, context),
  );
}

/** Executes the DAG connected through FlowGram's free-layout node ports. */
export class WorkflowRunner {
  private readonly options: RunnerOptions;
  private current: RunSnapshot;
  private controller?: AbortController;
  private stopped = false;
  private active = false;
  private readonly signatures: Record<string, string>;

  constructor(options: RunnerOptions) {
    this.options = { ...options, workflow: clone(options.workflow) };
    this.signatures = nodeRunSignatures(this.options.workflow);
    const { workflow, environment, owner, checkpoint } = options;
    const matches =
      checkpoint?.workflowId === workflow.id &&
      checkpoint.environment === environment &&
      checkpoint.owner === owner;
    this.current = matches
      ? reconcileSnapshot(workflow, checkpoint)
      : {
          workflowId: workflow.id,
          graph: graphKey(workflow),
          environment,
          owner,
          status: 'idle',
          nodes: {},
        };
    if (this.current.status === 'running') this.current.status = 'paused';
    for (const run of Object.values(this.current.nodes)) {
      if (run.status === 'running') run.status = 'paused';
    }
  }

  get snapshot(): RunSnapshot {
    return clone(this.current);
  }

  stop(): void {
    if (!this.active) return;
    this.stopped = true;
    this.controller?.abort(new Error('已暂停，可继续查询已提交的生成任务'));
    this.current.status = 'paused';
    for (const run of Object.values(this.current.nodes)) {
      if (run.status === 'running') run.status = 'paused';
    }
    this.emit();
  }

  async run(onlyNodeId?: string): Promise<void> {
    if (this.active) throw new Error('工作流正在运行');
    const graph = this.validate();
    this.controller = new AbortController();
    this.stopped = false;
    this.active = true;
    this.current.status = 'running';
    try {
      this.emit();
      if (onlyNodeId) await this.runSingle(onlyNodeId, graph);
      else await this.runGraph(graph);
      this.signal.throwIfAborted();
      this.current.status = 'success';
    } catch (error) {
      if (!this.signal.aborted) this.controller.abort(error);
      this.current.status = this.stopped ? 'paused' : 'error';
      for (const run of Object.values(this.current.nodes)) {
        if (run.status === 'running') run.status = 'paused';
      }
      throw error;
    } finally {
      this.active = false;
      this.emit();
    }
  }

  private get signal(): AbortSignal {
    if (!this.controller) throw new Error('工作流尚未启动');
    return this.controller.signal;
  }

  private emit(): void {
    this.options.onChange(this.snapshot);
  }

  private update(id: string, patch: Partial<NodeRun>): void {
    this.current.nodes[id] = {
      status: 'idle',
      ...this.current.nodes[id],
      ...patch,
      signature: this.signatures[id],
    };
    this.emit();
  }

  private validate(): Graph {
    const workflow = this.options.workflow;
    const nodes = new Map<string, WorkflowNode>();
    for (const node of workflow.nodes) {
      if (!node.id || nodes.has(node.id)) throw new Error('节点 ID 缺失或重复');
      if (!['start', 'end', 'generate', 'condition'].includes(node.type)) {
        throw new Error(`不支持的节点类型：${node.type}`);
      }
      nodes.set(node.id, node);
    }
    const starts = workflow.nodes.filter((node) => node.type === 'start');
    const ends = workflow.nodes.filter((node) => node.type === 'end');
    if (starts.length !== 1 || ends.length !== 1) {
      throw new Error('工作流必须有且只有一个开始节点和一个结束节点');
    }
    const startId = starts[0].id;
    const endId = ends[0].id;
    const incoming = new Map(workflow.nodes.map((node) => [node.id, [] as WorkflowEdge[]]));
    const outgoing = new Map(workflow.nodes.map((node) => [node.id, [] as WorkflowEdge[]]));
    const seenEdges = new Set<string>();
    for (const edge of workflow.edges) {
      const source = nodes.get(edge.sourceNodeID);
      const target = nodes.get(edge.targetNodeID);
      if (!source || !target) throw new Error('连线指向了不存在的节点');
      if (source.type === 'end' || target.type === 'start') {
        throw new Error('结束节点不能有出线，开始节点不能有入线');
      }
      if (edge.targetPortID) throw new Error('连线的输入端口无效');
      if (source.type === 'condition') {
        if (!['true', 'false'].includes(edge.sourcePortID ?? '')) {
          throw new Error('条件连线必须来自满足条件或否则端口');
        }
      } else if (edge.sourcePortID) {
        throw new Error('连线的输出端口无效');
      }
      const key = JSON.stringify([
        edge.sourceNodeID,
        edge.sourcePortID ?? '',
        edge.targetNodeID,
        edge.targetPortID ?? '',
      ]);
      if (seenEdges.has(key)) throw new Error('同一对端口不能重复连线');
      seenEdges.add(key);
      incoming.get(target.id)!.push(edge);
      outgoing.get(source.id)!.push(edge);
    }
    const pending = new Map([...incoming].map(([id, edges]) => [id, edges.length]));
    const queue = [...pending].filter(([, count]) => count === 0).map(([id]) => id);
    const order: string[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      order.push(id);
      for (const edge of outgoing.get(id)!) {
        const count = pending.get(edge.targetNodeID)! - 1;
        pending.set(edge.targetNodeID, count);
        if (count === 0) queue.push(edge.targetNodeID);
      }
    }
    if (order.length !== nodes.size) throw new Error('工作流包含循环，请移除形成回路的连线');
    const ancestors = new Map<string, Set<string>>();
    for (const id of order) {
      const before = new Set<string>();
      for (const edge of incoming.get(id)!) {
        before.add(edge.sourceNodeID);
        for (const ancestor of ancestors.get(edge.sourceNodeID)!) before.add(ancestor);
      }
      ancestors.set(id, before);
      if (id !== startId && !before.has(startId)) {
        throw new Error(`节点「${nodes.get(id)!.data.title}」未连接到开始节点`);
      }
    }
    const beforeEnd = ancestors.get(endId)!;
    for (const id of order) {
      if (id !== endId && !beforeEnd.has(id)) {
        throw new Error(`节点「${nodes.get(id)!.data.title}」无法到达结束节点`);
      }
      this.validateNode(nodes.get(id)!, ancestors.get(id)!, nodes, outgoing.get(id)!);
    }
    return { nodes, incoming, outgoing, ancestors, order, startId, endId };
  }

  private validateNode(
    node: WorkflowNode,
    ancestors: Set<string>,
    nodes: Map<string, WorkflowNode>,
    outgoing: WorkflowEdge[],
  ): void {
    const refs = [node.data.prompt, node.data.additionalRequirements]
      .flatMap((text) => [...(text ?? '').matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)])
      .map((match) => match[1]);
    if (node.type === 'end' && node.data.finalOutputs !== undefined) {
      const outputs = node.data.finalOutputs;
      if (!Array.isArray(outputs) || !outputs.length) {
        throw new Error('请为结束节点添加至少一项最终产出');
      }
      const names = new Set<string>();
      for (const item of outputs) {
        if (!item || typeof item.name !== 'string' || !item.name.trim()) {
          throw new Error('请填写最终产出的名称');
        }
        if (names.has(item.name.trim())) throw new Error('最终产出名称不能重复');
        names.add(item.name.trim());
        if (typeof item.source !== 'string' || !item.source.trim()) {
          throw new Error(`请为最终产出「${item.name}」选择来源`);
        }
        refs.push(item.source);
      }
    }
    if (node.type === 'condition') {
      if (!node.data.condition?.source) throw new Error('请为条件分支选择判断来源');
      if (!['equals', 'contains', 'notEmpty'].includes(node.data.condition.operator)) {
        throw new Error('条件分支的判断方式无效');
      }
      refs.push(node.data.condition.source);
      if (!['true', 'false'].every((port) => outgoing.some((e) => e.sourcePortID === port))) {
        throw new Error('请将条件分支的两个输出端口都连接到后续节点');
      }
    }
    for (const ref of refs) {
      const [id, kind, ...field] = referencePath(ref);
      if (
        !ancestors.has(id) ||
        !['text', 'fields', 'assets', 'outputs', 'variables'].includes(kind)
      ) {
        throw new Error(`${node.data.title} 的引用 ${ref} 无效或未连接到上游`);
      }
      if (kind === 'outputs') {
        if (
          !['generate', 'end'].includes(node.type) ||
          nodes.get(id)?.type !== 'generate' ||
          field.length !== 1 ||
          !/^(0|[1-9]\d*)$/.test(field[0]) ||
          !Number.isSafeInteger(Number(field[0]))
        ) {
          throw new Error('产出引用无效，请重新选择上游生成产出');
        }
      }
      if (kind === 'assets') {
        if (
          !['generate', 'end'].includes(node.type) ||
          field.length > 1 ||
          (field.length === 1 && !/^[a-f\d]{24}$/i.test(field[0]))
        ) {
          throw new Error(`引用 ${ref} 的资源路径无效`);
        }
      }
      if (kind === 'variables') {
        const name = field.join('.');
        if (
          !['generate', 'end'].includes(node.type) ||
          nodes.get(id)?.type !== 'start' ||
          !name ||
          !nodes
            .get(id)
            ?.data.fields?.some((item) => item.name.trim() === name && item.type !== 'string')
        ) {
          throw new Error(`引用 ${ref} 的资源变量无效，请重新选择上游变量`);
        }
      }
      if (kind === 'text' && field.length > 0) {
        throw new Error(`引用 ${ref} 的字段路径无效`);
      }
      if (
        kind === 'fields' &&
        (!field.length ||
          !nodes.get(id)?.data.fields?.some((item) => item.name.trim() === field.join('.')))
      ) {
        throw new Error(`引用 ${ref} 的开始变量不存在`);
      }
    }
    if (node.type === 'start') {
      const fields = node.data.fields ?? [];
      const names = fields.map((field) => field.name.trim());
      if (names.some((name) => !name) || new Set(names).size !== names.length) {
        throw new Error('开始节点的变量名称不能为空或重复');
      }
      if (fields.some((field) => (field.type === 'string' ? !field.value.trim() : !field.asset))) {
        throw new Error('请填写变量内容，或上传对应类型的文件');
      }
    }
    if (node.type === 'generate') {
      if (!['image', 'video', 'model3d', 'audio'].includes(node.data.outputType ?? '')) {
        throw new Error('请为生成节点选择输出类型');
      }
      if (!['fast', 'standard', 'high'].includes(node.data.quality ?? '')) {
        throw new Error('请为生成节点选择生成质量');
      }
    }
  }

  private edgeActive(edge: WorkflowEdge, graph: Graph): boolean {
    const source = this.current.nodes[edge.sourceNodeID];
    if (source?.status !== 'success' || !source.output) return false;
    return (
      graph.nodes.get(edge.sourceNodeID)!.type !== 'condition' ||
      source.activePort === edge.sourcePortID
    );
  }

  private context(nodeId: string, graph: Graph): Context {
    const outputs = new Map<string, Bundle>();
    for (const id of graph.ancestors.get(nodeId)!) {
      const run = this.current.nodes[id];
      if (run?.status === 'success' && run.output) outputs.set(id, clone(run.output));
    }
    const inputs = graph.incoming
      .get(nodeId)!
      .filter((edge) => this.edgeActive(edge, graph))
      .map((edge) => this.current.nodes[edge.sourceNodeID].output!);
    return { outputs, latest: merge(inputs) };
  }

  private async runGraph(graph: Graph): Promise<void> {
    const tasks = new Map<string, Promise<void>>();
    let failure: unknown;
    const schedule = (id: string): Promise<void> => {
      const existing = tasks.get(id);
      if (existing) return existing;
      const task = (async () => {
        await Promise.all(graph.incoming.get(id)!.map((edge) => schedule(edge.sourceNodeID)));
        this.signal.throwIfAborted();
        const active = graph.incoming.get(id)!.some((edge) => this.edgeActive(edge, graph));
        if (id !== graph.startId && !active) {
          this.update(id, { status: 'skipped', output: undefined, activePort: undefined });
          return;
        }
        const saved = this.current.nodes[id];
        if (saved?.status === 'success' && saved.output) {
          if (graph.nodes.get(id)!.type !== 'condition' || saved.activePort) return;
        }
        await this.execute(graph.nodes.get(id)!, this.context(id, graph));
      })().catch((error: unknown) => {
        if (failure === undefined) failure = error;
        if (!this.signal.aborted) this.controller!.abort(error);
        throw error;
      });
      tasks.set(id, task);
      return task;
    };
    const settled = await Promise.allSettled(graph.order.map(schedule));
    if (settled.some((result) => result.status === 'rejected')) throw failure;
  }

  private async runSingle(id: string, graph: Graph): Promise<void> {
    const node = graph.nodes.get(id);
    if (!node) throw new Error('所选节点不存在');
    const ancestors = graph.ancestors.get(id)!;
    for (const before of graph.order.filter((candidate) => ancestors.has(candidate))) {
      const active = graph.incoming.get(before)!.some((edge) => this.edgeActive(edge, graph));
      if (before !== graph.startId && !active) {
        this.update(before, { status: 'skipped', output: undefined, activePort: undefined });
        continue;
      }
      const saved = this.current.nodes[before];
      if (
        saved?.status !== 'success' ||
        !saved.output ||
        (graph.nodes.get(before)!.type === 'condition' && !saved.activePort)
      ) {
        const title = graph.nodes.get(before)!.data.title;
        throw new Error(`请先运行上游节点「${title}」，再单独运行所选节点`);
      }
    }
    if (
      id !== graph.startId &&
      !graph.incoming.get(id)!.some((edge) => this.edgeActive(edge, graph))
    ) {
      throw new Error('所选节点的输入分支未命中，无法单独运行');
    }
    for (const candidate of graph.order) {
      if (graph.ancestors.get(candidate)!.has(id)) delete this.current.nodes[candidate];
    }
    if (this.current.nodes[id]?.status === 'success') delete this.current.nodes[id];
    await this.execute(node, this.context(id, graph));
  }

  private input(node: WorkflowNode, context: Context): Bundle {
    const input = clone(context.latest);
    if (node.type !== 'generate') return input;
    const resources = [node.data.prompt, node.data.additionalRequirements]
      .flatMap((text) => [...(text ?? '').matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)])
      .map((match) => match[1])
      .filter((ref) => ['assets', 'outputs', 'variables'].includes(referencePath(ref)[1]))
      .flatMap((ref) => resolveAssets(ref, context));
    return merge([input, { text: '', assets: resources }]);
  }

  private finalOutput(node: WorkflowNode, context: Context): Bundle {
    if (node.data.finalOutputs === undefined) return clone(context.latest);
    const assets: Bundle['assets'] = [];
    const fields: Record<string, string> = {};
    const texts: string[] = [];
    for (const item of node.data.finalOutputs) {
      const [sourceId, kind] = referencePath(item.source);
      // A non-selected conditional branch has no output in the active execution context.
      if (!context.outputs.has(sourceId)) continue;
      const name = item.name.trim();
      if (kind === 'assets' || kind === 'outputs' || kind === 'variables') {
        const selected = resolveAssets(item.source, context);
        for (const [index, asset] of selected.entries()) {
          if (assets.some((existing) => existing.fileId === asset.fileId)) continue;
          const extension = asset.name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0] ?? '';
          const label = selected.length > 1 ? `${name} ${index + 1}` : name;
          assets.push({ ...asset, name: label.endsWith(extension) ? label : label + extension });
        }
      } else {
        const value = resolve(item.source, context);
        Object.defineProperty(fields, name, { value, enumerable: true, configurable: true });
        texts.push(`${name}：${value}`);
      }
    }
    return { text: texts.join('\n\n'), assets, fields };
  }

  private async execute(node: WorkflowNode, context: Context): Promise<void> {
    try {
      this.signal.throwIfAborted();
      const input = this.input(node, context);
      this.update(node.id, {
        status: 'running',
        input,
        error: undefined,
        output: undefined,
        activePort: undefined,
        startedAt: Date.now(),
        finishedAt: undefined,
      });
      let output: Bundle;
      let activePort: 'true' | 'false' | undefined;
      if (node.type === 'start') {
        const variables = Object.fromEntries(
          (node.data.fields ?? []).flatMap((field) =>
            field.type !== 'string' && field.asset
              ? [[field.name.trim(), field.asset] as const]
              : [],
          ),
        );
        const fields = Object.fromEntries(
          (node.data.fields ?? [])
            .filter((field) => field.type === 'string')
            .map((field) => [field.name.trim(), field.value]),
        );
        output = {
          text: Object.entries(fields)
            .map(([name, value]) => `${name}：${value}`)
            .join('\n'),
          fields,
          assets: (node.data.fields ?? []).flatMap((field) =>
            field.type !== 'string' && field.asset ? [field.asset] : [],
          ),
          variables,
        };
      } else if (node.type === 'generate') {
        output = await this.generate(node, input, context);
      } else if (node.type === 'condition') {
        output = input;
        activePort = this.conditionPort(node, context);
      } else {
        output = this.finalOutput(node, context);
      }
      this.signal.throwIfAborted();
      this.update(node.id, {
        status: 'success',
        output,
        activePort,
        stage: node.type === 'generate' ? '生成完成' : undefined,
        finishedAt: Date.now(),
      });
    } catch (error) {
      const retryWithNewId =
        node.type === 'generate' &&
        error instanceof Error &&
        'retryWithNewId' in error &&
        error.retryWithNewId === true;
      this.update(node.id, {
        status: this.signal.aborted ? 'paused' : 'error',
        error: message(error),
        finishedAt: Date.now(),
        ...(retryWithNewId ? { requestId: undefined, messageId: undefined } : {}),
      });
      throw error;
    }
  }

  private async generate(node: WorkflowNode, input: Bundle, context: Context): Promise<Bundle> {
    const { client } = this.options;
    const saved = this.current.nodes[node.id];
    if (saved.invalidatedSubmission) {
      throw new Error(
        '节点配置已更改，但旧生成任务仍待确认；请先在 Mivo 检查任务，再重新运行整个工作流',
      );
    }
    if (saved.messageId) return client.poll(saved.messageId, this.signal);
    if (saved.submissionUncertain) {
      throw new Error('上次提交结果待确认，请先在 Mivo 检查任务；确认未提交后重新运行整个工作流');
    }
    const requestId = saved.requestId ?? crypto.randomUUID();
    this.update(node.id, { requestId });
    const data = {
      ...node.data,
      prompt: template(node.data.prompt, context),
      additionalRequirements: template(node.data.additionalRequirements, context),
    };
    if (!data.prompt.trim() && !input.text.trim() && !input.assets.length) {
      throw new Error('生成节点需要提示词或上游素材');
    }
    return client.generate(
      data,
      input,
      requestId,
      this.signal,
      (messageId) => this.update(node.id, { messageId, submissionUncertain: false }),
      (progress) => this.update(node.id, progress),
    );
  }

  private conditionPort(node: WorkflowNode, context: Context): 'true' | 'false' {
    const condition = node.data.condition!;
    const source = resolve(condition.source, context);
    const value = condition.value;
    const matches =
      condition.operator === 'notEmpty'
        ? source.trim().length > 0
        : condition.operator === 'contains'
          ? source.includes(value)
          : source === value;
    return matches ? 'true' : 'false';
  }
}
