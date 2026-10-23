import type { FreeLayoutPluginContext } from '@flowgram.ai/free-layout-editor';

export function deleteNodesAndReconnect(ctx: FreeLayoutPluginContext, ids: string[]) {
  if (ctx.playground.config.readonlyOrDisabled) return;
  const requested = new Set(ids);
  const removed = new Set(
    ctx.document
      .getAllNodes()
      .filter((node) => requested.has(node.id) && ctx.document.canRemove(node))
      .map((node) => node.id),
  );
  if (!removed.size) return;
  const graph = ctx.document.toJSON();
  const remaining = graph.edges.filter(
    (edge) => !removed.has(edge.sourceNodeID) && !removed.has(edge.targetNodeID),
  );
  const edgeKey = (edge: (typeof graph.edges)[number]) =>
    JSON.stringify([
      edge.sourceNodeID,
      edge.sourcePortID ?? '',
      edge.targetNodeID,
      edge.targetPortID ?? '',
    ]);
  const keys = new Set(remaining.map(edgeKey));
  const added: (typeof graph.edges)[number][] = [];
  const findLine = (edge: (typeof graph.edges)[number]) =>
    ctx.document.linesManager.getLine({
      from: edge.sourceNodeID,
      to: edge.targetNodeID,
      fromPort: edge.sourcePortID,
      toPort: edge.targetPortID,
    });
  const reaches = (start: string, target: string, excluded?: (typeof graph.edges)[number]) => {
    const seen = new Set<string>();
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const edge of remaining) {
        if (edge !== excluded && edge.sourceNodeID === id) queue.push(edge.targetNodeID);
      }
    }
    return false;
  };
  for (const incoming of graph.edges) {
    if (removed.has(incoming.sourceNodeID) || !removed.has(incoming.targetNodeID)) continue;
    const fromPort = findLine(incoming)?.fromPort;
    if (!fromPort) continue;
    const seen = new Set<string>();
    const queue = [incoming.targetNodeID];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (seen.has(id)) continue;
      seen.add(id);
      for (const outgoing of graph.edges.filter((edge) => edge.sourceNodeID === id)) {
        if (removed.has(outgoing.targetNodeID)) {
          queue.push(outgoing.targetNodeID);
          continue;
        }
        const edge = {
          sourceNodeID: incoming.sourceNodeID,
          sourcePortID: incoming.sourcePortID,
          targetNodeID: outgoing.targetNodeID,
          targetPortID: outgoing.targetPortID,
        };
        const key = edgeKey(edge);
        if (keys.has(key) || remaining.length >= 2000) continue;
        if (reaches(edge.targetNodeID, edge.sourceNodeID)) continue;
        const toPort = findLine(outgoing)?.toPort;
        if (!toPort || !ctx.document.linesManager.canAddLine(fromPort, toPort, true)) continue;
        keys.add(key);
        remaining.push(edge);
        added.push(edge);
      }
    }
  }
  // Check after collecting all bridges so parallel deletions are independent of edge order.
  for (const edge of added) {
    if (reaches(edge.sourceNodeID, edge.targetNodeID, edge)) {
      remaining.splice(remaining.indexOf(edge), 1);
    }
  }
  ctx.operation.fromJSON({
    ...graph,
    nodes: graph.nodes.filter((node) => !removed.has(node.id)),
    edges: remaining,
  });
  ctx.selection.selection = ctx.selection.selection.filter((entity) => !entity.disposed);
}
