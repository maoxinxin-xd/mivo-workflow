/**
 * Adapted from @flowgram.ai/demo-free-layout (MIT).
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates.
 */
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  EditorRenderer,
  FreeLayoutEditorProvider,
  WorkflowPortRender,
  useClientContext,
  useNodeRender,
  WorkflowNodePortsData,
  WorkflowCommands,
  WorkflowLineEntity,
  createShortcutsPlugin,
  type FreeLayoutPluginContext,
  type FreeLayoutProps,
  type WorkflowNodeRegistry,
} from '@flowgram.ai/free-layout-editor';
import {
  createFreeNodePanelPlugin,
  WorkflowNodePanelService,
  type NodePanelRenderProps,
} from '@flowgram.ai/free-node-panel-plugin';
import { Popover } from '@douyinfe/semi-ui';
import {
  GitBranch,
  Maximize,
  Play,
  Plus,
  Redo2,
  Sparkles,
  Square,
  Trash2,
  Undo2,
} from 'lucide-react';
import { createNode, outputLabel, type NodeData, type NodeType } from './model';
import { useStudio } from './context';
import { connectionState } from './line-state';
import { insertGeneration } from './insert-generation';
import { deleteNodesAndReconnect } from './delete-nodes';
import {
  AdaptiveCanvas,
  CanvasDirectionContext,
  resetCanvasView,
  type CanvasDirection,
} from './AdaptiveCanvas';
import '@flowgram.ai/free-layout-editor/index.css';

export const nodeInfo = {
  start: { title: '开始', icon: Play, caption: '定义工作流输入', color: 'green' },
  end: { title: '结束', icon: Square, caption: '选择工作流的最终产出', color: 'slate' },
  generate: { title: '生成', icon: Sparkles, caption: '图片、视频、模型与音频', color: 'blue' },
  condition: { title: '条件分支', icon: GitBranch, caption: '根据条件选择路径', color: 'amber' },
};

const formMeta = { render: () => null };
const registries: WorkflowNodeRegistry[] = [
  {
    type: 'start',
    meta: {
      draggable: false,
      isStart: true,
      deleteDisable: true,
      copyDisable: true,
      defaultPorts: [{ type: 'output', location: 'right' }],
      size: { width: 264, height: 80 },
    },
    formMeta,
  },
  {
    type: 'end',
    meta: {
      draggable: false,
      isNodeEnd: true,
      deleteDisable: true,
      copyDisable: true,
      defaultPorts: [{ type: 'input', location: 'left' }],
      size: { width: 264, height: 80 },
    },
    formMeta,
  },
  {
    type: 'generate',
    meta: {
      draggable: false,
      defaultPorts: [
        { type: 'input', location: 'left' },
        { type: 'output', location: 'right' },
      ],
      size: { width: 264, height: 144 },
    },
    formMeta,
  },
  {
    type: 'condition',
    meta: {
      draggable: false,
      useDynamicPort: true,
      defaultPorts: [{ type: 'input', location: 'left' }],
      size: { width: 264, height: 132 },
    },
    formMeta,
  },
];

export function NodeCard() {
  const render = useNodeRender();
  const direction = useContext(CanvasDirectionContext);
  const ctx = useClientContext();
  useLayoutEffect(() => {
    render.node.getData(WorkflowNodePortsData).updateDynamicPorts();
    for (const port of render.ports) {
      const location =
        direction === 'TB'
          ? port.portType === 'input'
            ? 'top'
            : 'bottom'
          : port.portType === 'input'
            ? 'left'
            : 'right';
      if (port.location !== location) port.update({ location });
    }
  }, [direction, render.node, render.ports]);
  const studio = useStudio();
  const type = render.type as NodeType;
  const info = nodeInfo[type];
  const Icon = info.icon;
  const data = render.data as NodeData;
  const run = studio.snapshot?.nodes[render.id];
  const moved = useRef(false);
  const stopTracking = useRef<() => void>();
  useEffect(() => () => stopTracking.current?.(), []);
  const outputCount = run?.output?.assets.length ?? 0;
  const statusLabel = {
    idle: '待运行',
    running: '运行中',
    success: '已完成',
    error: '运行失败',
    paused: '已暂停',
    skipped: '已跳过',
  }[run?.status ?? 'idle'];
  return (
    <>
      <div
        ref={render.nodeRef}
        draggable={false}
        onPointerDownCapture={(event) => {
          if (event.button !== 0) return;
          stopTracking.current?.();
          moved.current = false;
          const { clientX, clientY, pointerId } = event;
          const initialScroll = ctx.playground.config.scrollData;
          const target = event.target as HTMLElement;
          const canPan = !target.closest('button, input, textarea, select, a, [contenteditable]');
          const track = (next: PointerEvent) => {
            if (next.pointerId !== pointerId) return;
            if (Math.hypot(next.clientX - clientX, next.clientY - clientY) > 5) {
              moved.current = true;
            }
            if (moved.current && canPan) {
              next.preventDefault();
              ctx.playground.config.updateConfig({
                scrollX: initialScroll.scrollX - next.clientX + clientX,
                scrollY: initialScroll.scrollY - next.clientY + clientY,
              });
            }
          };
          const stop = (next: PointerEvent) => {
            if (next.pointerId !== pointerId) return;
            if (next.type === 'pointercancel') moved.current = true;
            track(next);
            stopTracking.current?.();
          };
          stopTracking.current = () => {
            document.removeEventListener('pointermove', track, true);
            document.removeEventListener('pointerup', stop, true);
            document.removeEventListener('pointercancel', stop, true);
            stopTracking.current = undefined;
          };
          document.addEventListener('pointermove', track, true);
          document.addEventListener('pointerup', stop, true);
          document.addEventListener('pointercancel', stop, true);
        }}
        onDragStart={(event) => event.preventDefault()}
        onFocus={render.onFocus}
        onBlur={render.onBlur}
        data-node-selected={String(render.selected)}
        data-workflow-node-id={render.id}
        className={[
          'node-card',
          `node-type-${type}`,
          direction === 'TB' ? 'node-vertical' : '',
          studio.selectedId === render.id ? 'selected' : '',
          `status-${run?.status ?? 'idle'}`,
        ].join(' ')}
        onClick={(event) => {
          if (event.detail !== 0 && moved.current) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          render.selectNode(event);
          studio.select(render.id);
        }}
      >
        <div className="node-heading">
          <span className={`node-icon ${info.color}`}>
            <Icon size={15} />
          </span>
          <strong>{data.title || info.title}</strong>
          {run && <span className={`status-dot ${run.status}`} title={statusLabel} />}
          {type !== 'start' && type !== 'end' && !studio.running && (
            <button
              className="icon-button node-delete"
              title="删除节点"
              onClick={(event) => {
                event.stopPropagation();
                deleteNodesAndReconnect(ctx, [render.id]);
                if (studio.selectedId === render.id) studio.select(undefined);
              }}
            >
              <Trash2 size={17} strokeWidth={1.75} />
            </button>
          )}
        </div>
        <div className={`node-description ${type === 'generate' ? 'node-prompt' : ''}`}>
          {type === 'generate'
            ? (data.prompt || '点击配置生成内容')
                .split(/(\{\{\s*[^{}]+?\s*\}\})/g)
                .map((part, index) => {
                  const reference = part.match(/^\{\{\s*([^{}]+?)\s*\}\}$/)?.[1];
                  const outputReference = reference?.match(/^(.+)\.outputs\.(\d+)$/);
                  const source = outputReference
                    ? studio.workflow.nodes.find((item) => item.id === outputReference[1])
                    : undefined;
                  const label =
                    source && outputReference
                      ? `${source.data.title} · ${outputLabel(source.data)} ${
                          Number(outputReference[2]) + 1
                        }`
                      : reference && data.promptReferenceLabels?.[reference];
                  return reference ? (
                    <span className="prompt-reference-tag" key={index}>
                      @ {label || '上游引用'}
                    </span>
                  ) : (
                    part
                  );
                })
            : type === 'end'
              ? data.finalOutputs === undefined
                ? '汇总连入节点的内容'
                : data.finalOutputs.length
                  ? `${data.finalOutputs.map((item) => item.name || '未命名产出').join('、')} · ${
                      data.finalOutputs.length
                    } 项`
                  : '点击选择最终产出'
              : info.caption}
        </div>
        {type === 'generate' && (
          <div className="node-footer min-w-0 flex-col gap-1.5">
            <span className="min-w-0 break-words">
              产出：{outputLabel(data)} 1{outputCount > 1 && ` 等 ${outputCount} 个资源`}
            </span>
            <span
              className={`break-words ${run?.status === 'error' ? 'text-red-500' : ''}`}
              title={run?.error ?? run?.stage ?? statusLabel}
            >
              {run?.status === 'running'
                ? (run.stage ?? '生成中…')
                : run?.status === 'success'
                  ? outputCount
                    ? `已产出 ${outputCount} 个资源 · 下游可 @ 引用`
                    : '已完成 · 未返回资源'
                  : run?.status === 'error'
                    ? '运行失败 · 点击查看原因'
                    : run?.status === 'paused' || run?.status === 'skipped'
                      ? statusLabel
                      : '连接下游后可 @ 引用'}
            </span>
          </div>
        )}
        {type === 'condition' && (
          <div className="condition-outputs">
            {(['true', 'false'] as const).map((port) => (
              <div className="condition-output" key={port}>
                <span>{port === 'true' ? '满足' : '否则'}</span>
                <span
                  className="dynamic-port-anchor"
                  data-port-id={port}
                  data-port-type="output"
                  data-port-location={direction === 'TB' ? 'bottom' : 'right'}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {render.ports.map((port) => (
        <WorkflowPortRender
          key={port.id}
          entity={port}
          primaryColor="#2563eb"
          secondaryColor="#98a8c1"
          backgroundColor="#fff"
        />
      ))}
    </>
  );
}

function NodeMenuOptions({
  onChoose,
}: {
  onChoose: (type: 'generate' | 'condition', event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="node-menu" aria-label="选择节点">
      {(['generate', 'condition'] as const).map((type) => {
        const info = nodeInfo[type];
        const Icon = info.icon;
        return (
          <button key={type} onClick={(event) => onChoose(type, event)}>
            <span className={`node-icon ${info.color}`}>
              <Icon size={16} />
            </span>
            <span>
              <strong>{info.title}</strong>
              <small>{info.caption}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function NodeSelectionPanel({ onSelect, position, onClose }: NodePanelRenderProps) {
  const ctx = useClientContext();
  return (
    <Popover
      visible
      trigger="custom"
      position="right"
      showArrow={false}
      className="node-selection-popover"
      onClickOutSide={onClose}
      content={
        <NodeMenuOptions
          onChoose={(type, event) => {
            const node = createNode(
              type,
              ctx.document.toJSON().nodes.map((item) => item.data.title),
            );
            onSelect({
              nodeType: type,
              nodeJSON: { id: node.id, type, data: node.data },
              selectEvent: event,
            });
          }}
        />
      }
    >
      <span
        style={{ position: 'absolute', left: position.x, top: position.y, width: 1, height: 1 }}
      />
    </Popover>
  );
}

function LineInsertButtons() {
  const ctx = useClientContext();
  const studio = useStudio();
  const [lines, setLines] = useState<WorkflowLineEntity[]>([]);
  const [, refresh] = useState(0);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (ctx.document.disposed) return;
        setLines(ctx.document.linesManager.getAllAvailableLines());
        refresh((value) => value + 1);
      });
    };
    update();
    const changes = ctx.document.onContentChange(update);
    const layout = ctx.document.linesManager.onForceUpdate(update);
    const hover = ctx.document.linesManager.hoverService.onHoveredChange(update);
    return () => {
      cancelAnimationFrame(frame);
      changes.dispose();
      layout.dispose();
      hover.dispose();
    };
  }, [ctx]);
  return lines
    .filter((line) => !line.disposed && !line.isDrawing && line.to)
    .map((line) => {
      const center = line.center;
      return createPortal(
        <button
          type="button"
          className={`line-insert-button${
            ctx.document.linesManager.hoverService.isHovered(line.id) ? ' is-visible' : ''
          }`}
          title="插入生成节点"
          aria-label="在连线中插入生成节点"
          disabled={studio.running}
          style={{ left: center.x, top: center.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (studio.running || ctx.playground.config.readonly || line.disposed) return;
            try {
              const graph = ctx.document.toJSON();
              const result = insertGeneration(
                {
                  ...studio.workflow,
                  nodes: graph.nodes as typeof studio.workflow.nodes,
                  edges: graph.edges as typeof studio.workflow.edges,
                },
                {
                  sourceNodeID: line.info.from,
                  targetNodeID: line.info.to!,
                  sourcePortID: line.info.fromPort,
                  targetPortID: line.info.toPort,
                },
                center,
              );
              ctx.operation.fromJSON(result.workflow);
              studio.save(ctx);
              studio.select(result.nodeId);
            } catch (error) {
              studio.notify(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          <Plus size={12} strokeWidth={1.8} />
        </button>,
        line.node,
        `insert-${line.id}`,
      );
    });
}

function ConnectionStates() {
  const ctx = useClientContext();
  const { workflow, snapshot } = useStudio();
  useEffect(() => {
    const manager = ctx.document.linesManager;
    manager.setDefaultUIState({ hideArrow: true, shrink: 0, strokeWidth: 1.8 });
    const sync = () => {
      if (ctx.document.disposed) return;
      for (const line of manager.getAllLines()) {
        const state = connectionState(
          {
            sourceNodeID: line.info.from,
            targetNodeID: line.info.to ?? '',
            sourcePortID: line.info.fromPort,
          },
          workflow.nodes,
          snapshot,
        );
        const colors = { success: '#269579', paused: '#b48232', skipped: '#cbd2dc' };
        line.updateUIState({
          hideArrow: true,
          shrink: 0,
          strokeWidth: state === 'waiting' || state === 'skipped' ? 1.8 : 2.2,
          strokeWidthSelected: 3,
          flowing: state === 'running',
          hasError: state === 'error',
          lockedColor: state in colors ? colors[state as keyof typeof colors] : '',
          className: `mivo-line mivo-line-${state}`,
        });
      }
    };
    sync();
    const subscription = manager.onAvailableLinesChange(sync);
    return () => subscription.dispose();
  }, [ctx, workflow, snapshot]);
  return null;
}

function CanvasTools({ container }: { container: HTMLDivElement | null }) {
  const ctx = useClientContext();
  const studio = useStudio();
  const [version, setVersion] = useState(0);
  const [showNodeMenu, setShowNodeMenu] = useState(false);
  const nodeMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showNodeMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!nodeMenuRef.current?.contains(event.target as Node)) setShowNodeMenu(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowNodeMenu(false);
        nodeMenuRef.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [showNodeMenu]);
  useEffect(() => {
    const subscription = ctx.history.undoRedoService.onChange(() => setVersion((v) => v + 1));
    return () => subscription.dispose();
  }, [ctx]);
  if (!container) return null;
  return createPortal(
    <div className="canvas-tools" data-history-version={version}>
      <div className="canvas-add-node" ref={nodeMenuRef}>
        <button
          title="添加节点"
          aria-label="添加节点"
          aria-expanded={showNodeMenu}
          aria-controls="canvas-node-menu"
          disabled={studio.running}
          onClick={() => setShowNodeMenu((open) => !open)}
        >
          <Plus />
        </button>
        {showNodeMenu && !studio.running && (
          <div className="canvas-node-menu" id="canvas-node-menu" aria-label="选择节点">
            <NodeMenuOptions
              onChoose={(type) => {
                if (studio.running || ctx.playground.config.readonly) return;
                const viewport = ctx.playground.config.getViewport();
                const node = ctx.document.createWorkflowNodeByType(
                  type,
                  {
                    x: viewport.x + viewport.width / 2 - 132,
                    y: viewport.y + viewport.height / 2 - 60,
                  },
                  createNode(
                    type,
                    ctx.document.toJSON().nodes.map((item) => item.data.title),
                  ),
                );
                setShowNodeMenu(false);
                studio.save(ctx);
                if (node) studio.select(node.id);
              }}
            />
          </div>
        )}
      </div>
      <i />
      <button
        title="撤销"
        disabled={!ctx.history.canUndo() || studio.running}
        onClick={() => ctx.history.undo()}
      >
        <Undo2 />
      </button>
      <button
        title="重做"
        disabled={!ctx.history.canRedo() || studio.running}
        onClick={() => ctx.history.redo()}
      >
        <Redo2 />
      </button>
      <i />
      <button title="重置视角" aria-label="重置视角" onClick={() => resetCanvasView(ctx)}>
        <Maximize />
      </button>
    </div>,
    container,
  );
}

export function WorkflowEditor({
  onReady,
  toolbarContainer,
}: {
  onReady: (ctx: FreeLayoutPluginContext) => void;
  toolbarContainer: HTMLDivElement | null;
}) {
  const studio = useStudio();
  const [direction, setDirection] = useState<CanvasDirection>('TB');
  const [layoutReady, setLayoutReady] = useState(false);
  const props = useMemo<FreeLayoutProps>(
    () => ({
      initialData: { nodes: studio.workflow.nodes, edges: studio.workflow.edges },
      nodeRegistries: registries,
      background: true,
      playground: { preventGlobalGesture: true, reverseScroll: true },
      nodeEngine: { enable: true },
      twoWayConnection: true,
      isHideArrowLine: () => true,
      history: { enable: true, enableChangeNode: true },
      onContentChange: (ctx) => {
        if (!ctx.document.disposed) queueMicrotask(() => studio.save(ctx));
      },
      canAddLine: (_ctx, from, to) => {
        if (from.portType === to.portType || from.node === to.node) return false;
        const source = from.portType === 'output' ? from : to;
        const target = from.portType === 'input' ? from : to;
        return !source.node.lines.allInputNodes.includes(target.node);
      },
      canDeleteNode: (_ctx, node) => !['start', 'end'].includes(String(node.flowNodeType)),
      canDeleteLine: () => true,
      canResetLine: () => true,
      onDragLineEnd: async (ctx, { fromPort, toPort, mousePos, line, originLine }) => {
        if (originLine || !line || toPort || !fromPort || ctx.playground.config.readonly) return;
        await ctx.get(WorkflowNodePanelService).call({
          panelPosition: mousePos,
          fromPort,
          enableBuildLine: true,
          enableAutoOffset: false,
          enableSelectPosition: false,
          enableDragNode: false,
          afterAddNode: (node) => {
            if (node) studio.select(node.id);
          },
        });
        studio.save(ctx);
      },
      materials: { renderDefaultNode: NodeCard },
      onInit: (ctx) => queueMicrotask(() => onReady(ctx)),
      plugins: (ctx: FreeLayoutPluginContext) => [
        createFreeNodePanelPlugin({ renderer: NodeSelectionPanel }),
        createShortcutsPlugin({
          registerShortcuts(registry) {
            registry.removeHandler(WorkflowCommands.DELETE_NODES);
            registry.addHandlers({
              commandId: 'mivo-delete-nodes',
              shortcuts: ['backspace', 'delete'],
              isEnabled: () =>
                ctx.selection.selection.length > 0 && !ctx.playground.config.readonlyOrDisabled,
              execute: () => {
                const selected = [...ctx.selection.selection];
                ctx.operation.startTransaction();
                try {
                  for (const entity of selected) {
                    if (
                      entity instanceof WorkflowLineEntity &&
                      ctx.document.linesManager.canRemove(entity)
                    ) {
                      entity.dispose();
                    }
                  }
                  deleteNodesAndReconnect(
                    ctx,
                    selected.map((entity) => entity.id),
                  );
                  ctx.selection.selection = ctx.selection.selection.filter(
                    (entity) => !entity.disposed,
                  );
                } finally {
                  ctx.operation.endTransaction();
                }
                studio.save(ctx);
                if (
                  selected.some(
                    (entity) => !(entity instanceof WorkflowLineEntity) && entity.disposed,
                  )
                ) {
                  studio.select(undefined);
                }
              },
            });
          },
        }),
      ],
      lineColor: {
        default: '#aebdd0',
        hovered: '#2563eb',
        selected: '#2563eb',
        drawing: '#2563eb',
        flowing: '#2563eb',
        error: '#d46565',
        hidden: 'transparent',
      },
    }),
    [],
  );
  return (
    <div style={{ height: '100%', visibility: layoutReady ? 'visible' : 'hidden' }}>
      <FreeLayoutEditorProvider {...props}>
        <CanvasDirectionContext.Provider value={direction}>
          <EditorRenderer />
          <AdaptiveCanvas setDirection={setDirection} onLayoutReady={setLayoutReady} />
          <ConnectionStates />
          <LineInsertButtons />
          <CanvasTools container={toolbarContainer} />
        </CanvasDirectionContext.Provider>
      </FreeLayoutEditorProvider>
    </div>
  );
}
