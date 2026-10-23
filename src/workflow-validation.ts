import { uniqueNodeTitle, variableTypes, type Workflow } from './model';

const types = new Set(['start', 'end', 'generate', 'condition']);

export function validateWorkflow(value: unknown): Workflow {
  const workflow = value as Workflow;
  if (
    workflow?.format !== 'mivo-flowgram' ||
    workflow.version !== 3 ||
    typeof workflow.id !== 'string' ||
    typeof workflow.name !== 'string' ||
    !Array.isArray(workflow.nodes) ||
    !Array.isArray(workflow.edges)
  )
    throw new Error('请选择支持自定义变量的新版 Mivo 工作流 JSON 文件');
  if (workflow.nodes.length > 500 || workflow.edges.length > 2000) {
    throw new Error('工作流最多支持 500 个节点和 2000 条连线');
  }
  const ids = new Set<string>();
  for (const node of workflow.nodes) {
    if (
      !node ||
      typeof node.id !== 'string' ||
      !/^[\w-]{1,100}$/.test(node.id) ||
      ids.has(node.id) ||
      !types.has(node.type) ||
      typeof node.data?.title !== 'string' ||
      !Number.isFinite(node.meta?.position?.x) ||
      !Number.isFinite(node.meta?.position?.y)
    )
      throw new Error('工作流包含无效节点、坐标或重复 ID');
    if (node.type === 'start') {
      if (!Array.isArray(node.data.fields)) throw new Error('自定义变量数据无效');
      for (const field of node.data.fields) {
        if (
          !field ||
          typeof field.name !== 'string' ||
          typeof field.value !== 'string' ||
          !variableTypes.some((type) => type.value === field.type) ||
          (field.asset &&
            (field.type === 'string' ||
              !/^[a-f\d]{24}$/i.test(field.asset.fileId) ||
              typeof field.asset.name !== 'string' ||
              field.asset.mediaType !== field.type))
        ) {
          throw new Error('自定义变量类型或内容无效');
        }
      }
    }
    ids.add(node.id);
  }
  if (
    workflow.nodes.filter((node) => node.type === 'start').length !== 1 ||
    workflow.nodes.filter((node) => node.type === 'end').length !== 1
  )
    throw new Error('工作流必须有唯一的开始和结束节点');
  for (const edge of workflow.edges) {
    if (
      !edge ||
      !ids.has(edge.sourceNodeID) ||
      !ids.has(edge.targetNodeID) ||
      edge.sourceNodeID === edge.targetNodeID ||
      (edge.sourcePortID !== undefined && typeof edge.sourcePortID !== 'string') ||
      (edge.targetPortID !== undefined && typeof edge.targetPortID !== 'string')
    )
      throw new Error('工作流包含无效连线');
  }
  const normalized = structuredClone(workflow);
  const reservedTitles = normalized.nodes.map((node) => node.data.title);
  const seenTitles = new Set<string>();
  for (const node of normalized.nodes) {
    const title = node.data.title.trim() || '节点';
    node.data.title = seenTitles.has(title) ? uniqueNodeTitle(title, reservedTitles) : title;
    seenTitles.add(node.data.title);
    reservedTitles.push(node.data.title);
    if ((node.data.outputType as string) === 'speech') node.data.outputType = 'audio';
  }
  return normalized;
}

export interface WorkflowDraft {
  id: string;
  savedAt: number | null;
  protected?: boolean;
  workflow: Workflow;
}

export interface WorkflowLibrary {
  activeId: string;
  workflows: Workflow[];
  drafts?: Record<string, WorkflowDraft[]>;
  selectedDraftId?: string;
}

export function workflowContent(workflow: Workflow): string {
  const sorted = {
    ...workflow,
    nodes: [...workflow.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...workflow.edges].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  return JSON.stringify(sorted, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}
