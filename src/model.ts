export type Environment = 'local' | 'test' | 'production';
export type NodeType = 'start' | 'end' | 'generate' | 'condition';
export type OutputType = 'image' | 'video' | 'model3d' | 'audio';
export type VariableType = 'string' | 'image' | 'video' | 'audio' | 'model3d';
export const variableTypes: Array<{ value: VariableType; label: string; prefix: string }> = [
  { value: 'string', label: '字符串', prefix: '字段' },
  { value: 'image', label: '图片', prefix: '图片' },
  { value: 'video', label: '视频', prefix: '视频' },
  { value: 'audio', label: '音频', prefix: '音频' },
  { value: 'model3d', label: '模型', prefix: '模型' },
];
export type Quality = 'fast' | 'standard' | 'high';

export interface Asset {
  fileId: string;
  name: string;
  mediaType?: string;
}

export interface Bundle {
  text: string;
  assets: Asset[];
  fields?: Record<string, string>;
  variables?: Record<string, Asset>;
}

export interface NodeData {
  title: string;
  prompt?: string;
  promptReferenceLabels?: Record<string, string>;
  outputType?: OutputType;
  outputName?: string;
  finalOutputs?: Array<{ id: string; name: string; source: string }>;
  quality?: Quality;
  additionalRequirements?: string;
  fields?: Array<{ name: string; value: string; type: VariableType; asset?: Asset }>;
  assets?: Asset[];
  condition?: {
    source: string;
    operator: 'equals' | 'contains' | 'notEmpty';
    value: string;
  };
}

export interface WorkflowNode {
  id: string;
  type: NodeType;
  data: NodeData;
  meta: { position: { x: number; y: number } };
}

export interface WorkflowEdge {
  sourceNodeID: string;
  targetNodeID: string;
  sourcePortID?: string;
  targetPortID?: string;
}

export interface Workflow {
  format: 'mivo-flowgram';
  version: 3;
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

// Automatic viewing layouts do not change the saved draft's node coordinates.
export function captureWorkflow(
  workflow: Workflow,
  graph: { nodes: Workflow['nodes']; edges: Workflow['edges'] },
): Workflow {
  const positions = new Map(workflow.nodes.map((node) => [node.id, node.meta.position]));
  return {
    ...workflow,
    nodes: graph.nodes.map((node) => ({
      ...node,
      meta: { ...node.meta, position: positions.get(node.id) ?? node.meta.position },
    })),
    edges: graph.edges,
  };
}

export type RunStatus = 'idle' | 'running' | 'success' | 'error' | 'paused' | 'skipped';
export interface NodeRun {
  signature?: string;
  status: RunStatus;
  input?: Bundle;
  output?: Bundle;
  requestId?: string;
  messageId?: string;
  stage?: string;
  abilityId?: string;
  selectionConfidence?: number;
  submissionUncertain?: boolean;
  invalidatedSubmission?: boolean;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  activePort?: 'true' | 'false';
}

export interface RunSnapshot {
  workflowId: string;
  graph: string;
  environment: Environment;
  owner: string;
  status: RunStatus;
  nodes: Record<string, NodeRun>;
}

export const environments: Record<Environment, string> = {
  local: '本地环境',
  test: '测试环境',
  production: '生产环境',
};

export const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

export function outputLabel(data: NodeData): string {
  const labels: Record<OutputType, string> = {
    image: '图片',
    video: '视频',
    model3d: '模型',
    audio: '音频',
  };
  return labels[data.outputType ?? 'image'] || '生成产出';
}

export function uniqueNodeTitle(title: string, existingTitles: string[]): string {
  const base = title.trim() || '节点';
  const used = new Set(existingTitles.map((name) => name.trim()));
  if (!used.has(base)) return base;
  let index = 1;
  while (used.has(`${base}${index}`)) index++;
  return `${base}${index}`;
}

export function createNode(type: NodeType, existingTitles: string[] = []): WorkflowNode {
  const labels = {
    start: '开始',
    end: '结束',
    generate: '生成',
    condition: '条件分支',
  };
  const node: WorkflowNode = {
    id: makeId(type),
    type,
    data: {
      title: uniqueNodeTitle(labels[type], existingTitles),
    },
    meta: { position: { x: 0, y: 0 } },
  };
  if (type === 'generate') {
    Object.assign(node.data, { prompt: '', outputType: 'image', quality: 'standard' });
  }
  if (type === 'start') node.data.fields = [{ name: '字段1', value: '', type: 'string' }];
  if (type === 'condition') {
    node.data.condition = { source: '', operator: 'notEmpty', value: '' };
  }
  return node;
}

export function createWorkflow(): Workflow {
  const start = createNode('start');
  const generate = createNode('generate');
  const end = createNode('end');
  start.meta.position = { x: 100, y: 240 };
  generate.meta.position = { x: 480, y: 208 };
  end.meta.position = { x: 860, y: 240 };
  return {
    format: 'mivo-flowgram',
    version: 3,
    id: crypto.randomUUID(),
    name: '未命名工作流',
    nodes: [start, generate, end],
    edges: [
      { sourceNodeID: start.id, targetNodeID: generate.id },
      { sourceNodeID: generate.id, targetNodeID: end.id },
    ],
  };
}

export function graphKey(workflow: Workflow): string {
  return JSON.stringify({
    nodes: workflow.nodes.map(({ id, type, data }) => ({ id, type, data })),
    edges: workflow.edges,
  });
}

export function upstreamNodes(
  nodes: WorkflowNode[],
  targetId: string,
  edges: WorkflowEdge[],
): WorkflowNode[] {
  const seen = new Set<string>([targetId]);
  const visit = (id: string) => {
    for (const edge of edges.filter((item) => item.targetNodeID === id)) {
      if (!seen.has(edge.sourceNodeID)) {
        seen.add(edge.sourceNodeID);
        visit(edge.sourceNodeID);
      }
    }
  };
  visit(targetId);
  return nodes.filter((node) => node.id !== targetId && seen.has(node.id));
}
