import { createContext, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { AutoLayoutService, DagreGraph, dagreLib } from '@flowgram.ai/free-auto-layout-plugin';
import {
  EditorState,
  useClientContext,
  type FreeLayoutPluginContext,
} from '@flowgram.ai/free-layout-editor';
import { useStudio } from './context';

export type CanvasDirection = 'LR' | 'TB';
export const CanvasDirectionContext = createContext<CanvasDirection>('TB');
const EDGE_INSET = 16;
const TOOLBAR_GAP = 24;
const RESET_VIEW = 'mivo-reset-view';

export function resetCanvasView(ctx: FreeLayoutPluginContext) {
  ctx.playground.config.playgroundDomNode.dispatchEvent(new Event(RESET_VIEW));
}

export function AdaptiveCanvas({
  setDirection,
  onLayoutReady,
}: {
  setDirection: Dispatch<SetStateAction<CanvasDirection>>;
  onLayoutReady: Dispatch<SetStateAction<boolean>>;
}) {
  const ctx = useClientContext();
  const studio = useStudio();
  const scheduleRef = useRef<() => void>();
  const notifyRef = useRef(studio.notify);
  notifyRef.current = studio.notify;

  useEffect(() => {
    const config = ctx.playground.config;
    const element = config.playgroundDomNode;
    const main = element.closest('main');
    const service = ctx.get(AutoLayoutService);
    ctx.playground.editorState.changeState(EditorState.STATE_SELECT.id);
    let disposed = false;
    let busy = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    let lastKey = '';
    let revealFrame = 0;

    const nodes = () => ctx.document.getAllNodes().filter((node) => node !== ctx.document.root);
    const bounds = () => {
      const rectangles = nodes().map((node) => node.transform.bounds);
      if (!rectangles.length) return { x: 0, y: 0, width: 264, height: 80 };
      const x = Math.min(...rectangles.map((rect) => rect.x));
      const y = Math.min(...rectangles.map((rect) => rect.y));
      return {
        x,
        y,
        width: Math.max(...rectangles.map((rect) => rect.x + rect.width)) - x,
        height: Math.max(...rectangles.map((rect) => rect.y + rect.height)) - y,
      };
    };
    const visibleArea = () => {
      const canvas = element.getBoundingClientRect();
      const toolbar = main?.querySelector('.canvas-command-bar')?.getBoundingClientRect();
      const top = toolbar ? toolbar.bottom - canvas.top + TOOLBAR_GAP : EDGE_INSET;
      const bottom = canvas.height - EDGE_INSET;
      return {
        x: EDGE_INSET,
        y: top,
        width: Math.max(1, canvas.width - EDGE_INSET * 2),
        height: Math.max(1, bottom - top),
      };
    };
    const scaleFor = (rect: ReturnType<typeof bounds>) => {
      const area = visibleArea();
      return Math.min(area.width / rect.width, area.height / rect.height, 1.5);
    };
    const limitScroll = (scroll: { scrollX: number; scrollY: number }) => {
      if (disposed || busy) return scroll;
      const rect = bounds();
      const area = visibleArea();
      const zoom = config.zoom;
      const clamp = (value: number, start: number, size: number, offset: number, space: number) => {
        const min = start * zoom - offset;
        const max = (start + size) * zoom - offset - space;
        if (min > max) return (min + max) / 2;
        return Math.max(min, Math.min(max, value));
      };
      return {
        scrollX: clamp(scroll.scrollX, rect.x, rect.width, area.x, area.width),
        scrollY: clamp(scroll.scrollY, rect.y, rect.height, area.y, area.height),
      };
    };
    const fit = () => {
      if (disposed || ctx.document.disposed) return;
      const rect = bounds();
      const area = visibleArea();
      const zoom = Math.max(0.001, scaleFor(rect));
      // The SDK normalizes zoom against the existing limits, so relax the old floor first.
      config.updateConfig({ minZoom: 0.001, maxZoom: 2 });
      config.updateConfig({
        zoom,
        scrollX: (rect.x + rect.width / 2) * zoom - area.x - area.width / 2,
        scrollY: (rect.y + rect.height / 2) * zoom - area.y - area.height / 2,
      });
      config.updateConfig({ minZoom: zoom });
    };
    const layout = async () => {
      if (disposed || ctx.document.disposed) return;
      if (busy) {
        pending = true;
        return;
      }
      const area = visibleArea();
      const graph = ctx.document.toJSON();
      const key = JSON.stringify({
        x: Math.round(area.x),
        y: Math.round(area.y),
        width: Math.round(area.width),
        height: Math.round(area.height),
        nodes: Array.from(element.querySelectorAll<HTMLElement>('[data-workflow-node-id]'))
          .map((node) => [node.dataset.workflowNodeId, node.offsetWidth, node.offsetHeight])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
        edges: graph.edges,
      });
      if (key === lastKey) return;
      busy = true;
      try {
        const arrange = (rankdir: CanvasDirection) =>
          service.layout({
            layoutConfig: { rankdir, ranksep: 48, nodesep: 36, edgesep: 16 },
            enableAnimation: false,
            disableFitView: true,
            getFollowNode: () => undefined,
          });
        // Compare detached graphs so trial layouts never move the visible nodes.
        const measure = (rankdir: CanvasDirection) => {
          const preview = new DagreGraph({ multigraph: true });
          preview.setGraph({ rankdir, ranksep: 48, nodesep: 36, edgesep: 16 });
          preview.setDefaultEdgeLabel(() => ({}));
          for (const node of nodes()) {
            const { width, height } = node.transform.bounds;
            preview.setNode(node.id, { width, height });
          }
          for (const [index, edge] of graph.edges.entries()) {
            if (preview.hasNode(edge.sourceNodeID) && preview.hasNode(edge.targetNodeID)) {
              preview.setEdge(edge.sourceNodeID, edge.targetNodeID, {}, String(index));
            }
          }
          dagreLib.layout(preview, {});
          const { width, height } = preview.graph();
          return Math.min(area.width / width, area.height / height, 1.5);
        };
        const horizontalScale = measure('LR');
        const verticalScale = measure('TB');
        // Prefer top-to-bottom on portrait viewports when both choices fit equally well.
        const direction = horizontalScale > verticalScale * 1.03 ? 'LR' : 'TB';
        await arrange(direction);
        if (disposed || ctx.document.disposed) return;
        setDirection(direction);
        lastKey = key;
      } catch (error) {
        notifyRef.current(error instanceof Error ? error.message : '自动排列失败，请重试');
      } finally {
        busy = false;
        if (!disposed && !ctx.document.disposed) {
          fit();
          // Let React update port directions and the SDK redraw lines before revealing the canvas.
          cancelAnimationFrame(revealFrame);
          revealFrame = requestAnimationFrame(() => {
            revealFrame = requestAnimationFrame(() => {
              if (!disposed) onLayoutReady(true);
            });
          });
        }
        if (pending) {
          pending = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void layout(), 100);
    };
    scheduleRef.current = schedule;
    config.addScrollLimit(limitScroll);
    // A zoom update applies its scroll limit with the preceding zoom; clamp once more afterwards.
    const zoom = ctx.playground.onZoom(() => config.updateConfig(limitScroll(config.scrollData)));
    const changes = ctx.document.onContentChange(schedule);
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const observed = new WeakSet<Element>();
    const observeNodes = () => {
      for (const node of element.querySelectorAll('.node-card')) {
        if (!observed.has(node)) {
          observed.add(node);
          resize.observe(node);
        }
      }
    };
    const mutations = new MutationObserver(() => {
      observeNodes();
      schedule();
    });
    mutations.observe(element, { childList: true, subtree: true });
    observeNodes();
    element.addEventListener(RESET_VIEW, fit);
    schedule();
    return () => {
      disposed = true;
      clearTimeout(timer);
      cancelAnimationFrame(revealFrame);
      scheduleRef.current = undefined;
      changes.dispose();
      zoom.dispose();
      resize.disconnect();
      mutations.disconnect();
      config.addScrollLimit((scroll) => scroll);
      element.removeEventListener(RESET_VIEW, fit);
    };
  }, [ctx, setDirection, onLayoutReady]);

  const hasSnapshot = !!studio.snapshot;
  useEffect(() => scheduleRef.current?.(), [studio.selectedId, hasSnapshot]);
  return null;
}
