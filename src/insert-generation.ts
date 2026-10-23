import { createNode, type Workflow, type WorkflowEdge } from './model';

/** Split exactly one edge, preserving its branch and input ports. */
export function insertGeneration(
  workflow: Workflow,
  edge: WorkflowEdge,
  center: { x: number; y: number },
) {
  const index = workflow.edges.findIndex(
    (item) =>
      item.sourceNodeID === edge.sourceNodeID &&
      item.targetNodeID === edge.targetNodeID &&
      (item.sourcePortID ?? '') === (edge.sourcePortID ?? '') &&
      (item.targetPortID ?? '') === (edge.targetPortID ?? ''),
  );
  if (index < 0) throw new Error('这条连线已不存在，请重试');
  if (workflow.nodes.length >= 500) throw new Error('工作流最多支持 500 个节点');
  if (workflow.edges.length >= 2000) throw new Error('工作流最多支持 2000 条连线');
  const next = structuredClone(workflow);
  const source = next.nodes.find((node) => node.id === edge.sourceNodeID)!;
  const target = next.nodes.find((node) => node.id === edge.targetNodeID)!;
  const node = createNode(
    'generate',
    next.nodes.map((item) => item.data.title),
  );
  node.meta.position = {
    x: Math.max(source.meta.position.x + 344, center.x - 132),
    y: center.y - 72,
  };
  const shift = Math.max(0, node.meta.position.x + 344 - target.meta.position.x);
  if (shift) {
    const downstream = new Set([target.id]);
    const queue = [target.id];
    for (let i = 0; i < queue.length; i++) {
      for (const item of next.edges.filter((item) => item.sourceNodeID === queue[i])) {
        if (!downstream.has(item.targetNodeID)) {
          downstream.add(item.targetNodeID);
          queue.push(item.targetNodeID);
        }
      }
    }
    for (const item of next.nodes) {
      if (downstream.has(item.id)) item.meta.position.x += shift;
    }
  }
  next.nodes.push(node);
  next.edges.splice(
    index,
    1,
    { sourceNodeID: edge.sourceNodeID, sourcePortID: edge.sourcePortID, targetNodeID: node.id },
    { sourceNodeID: node.id, targetNodeID: edge.targetNodeID, targetPortID: edge.targetPortID },
  );
  return { workflow: next, nodeId: node.id };
}
