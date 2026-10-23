import type { RunSnapshot, WorkflowEdge, WorkflowNode } from './model';

export type ConnectionState = 'waiting' | 'running' | 'success' | 'error' | 'paused' | 'skipped';

/** A branch is active only when its own source port was chosen, even after a merge. */
export function connectionState(
  edge: WorkflowEdge,
  nodes: WorkflowNode[],
  snapshot?: RunSnapshot,
): ConnectionState {
  const source = snapshot?.nodes[edge.sourceNodeID];
  const target = snapshot?.nodes[edge.targetNodeID];
  const condition = nodes.find((node) => node.id === edge.sourceNodeID)?.type === 'condition';
  if (
    source?.status === 'skipped' ||
    target?.status === 'skipped' ||
    (condition && source?.status === 'success' && source.activePort !== edge.sourcePortID)
  ) {
    return 'skipped';
  }
  if (source?.status !== 'success') return 'waiting';
  if (target?.status === 'running') return 'running';
  if (target?.status === 'error') return 'error';
  if (target?.status === 'paused') return 'paused';
  if (target?.status === 'success') return 'success';
  return 'waiting';
}
