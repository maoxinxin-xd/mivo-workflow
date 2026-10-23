import { graphKey, type RunSnapshot, type Workflow } from './model';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hash(value: string): string {
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second, 33) ^ code;
  }
  return `${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
}

/** Signatures include only execution settings and dependency signatures, never canvas positions. */
export function nodeRunSignatures(workflow: Workflow): Record<string, string> {
  const signatures: Record<string, string> = {};
  const pending = new Map(workflow.nodes.map((node) => [node.id, node]));
  while (pending.size) {
    let progressed = false;
    for (const [id, node] of pending) {
      const incoming = workflow.edges.filter((edge) => edge.targetNodeID === id);
      if (incoming.some((edge) => !signatures[edge.sourceNodeID])) continue;
      const { title, outputName, promptReferenceLabels, ...data } = node.data;
      // Keep display-only fields out of dependency invalidation.
      void title;
      void outputName;
      void promptReferenceLabels;
      const dependencies = incoming.map((edge) => ({
        source: edge.sourceNodeID,
        sourcePort: edge.sourcePortID ?? '',
        targetPort: edge.targetPortID ?? '',
        signature: signatures[edge.sourceNodeID],
      }));
      signatures[id] = hash(stable({ id, type: node.type, data, dependencies }));
      pending.delete(id);
      progressed = true;
    }
    // Invalid graphs are handled by runtime validation; cycles cannot reuse saved outputs.
    if (!progressed) break;
  }
  return signatures;
}

/** Reuse unchanged upstream runs. Argument order: workflow, snapshot. */
export function reconcileSnapshot(workflow: Workflow, snapshot: RunSnapshot): RunSnapshot {
  const graph = graphKey(workflow);
  const signatures = nodeRunSignatures(workflow);
  const nodes: RunSnapshot['nodes'] = {};
  if (snapshot.workflowId === workflow.id) {
    for (const [id, run] of Object.entries(snapshot.nodes)) {
      const signature = signatures[id];
      if (!signature) continue;
      const matches = run.signature ? run.signature === signature : snapshot.graph === graph;
      if (!matches) {
        if (
          (run.messageId || run.submissionUncertain) &&
          run.status !== 'success' &&
          run.status !== 'skipped'
        ) {
          nodes[id] = {
            ...structuredClone(run),
            signature,
            output: undefined,
            activePort: undefined,
            status: 'paused',
            invalidatedSubmission: true,
          };
        }
        continue;
      }
      nodes[id] = {
        ...structuredClone(run),
        signature,
        status: run.status,
      };
    }
  }
  const end = workflow.nodes.find((node) => node.type === 'end');
  const completed =
    end &&
    nodes[end.id]?.status === 'success' &&
    workflow.nodes.every((node) => ['success', 'skipped'].includes(nodes[node.id]?.status));
  const unchanged =
    snapshot.workflowId === workflow.id &&
    snapshot.graph === graph &&
    Object.keys(nodes).length === Object.keys(snapshot.nodes).length;
  return {
    ...snapshot,
    workflowId: workflow.id,
    graph,
    nodes,
    status: unchanged
      ? snapshot.status
      : !Object.keys(nodes).length
        ? 'idle'
        : completed
          ? 'success'
          : 'paused',
  };
}
