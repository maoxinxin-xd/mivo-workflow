import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FreeLayoutPluginContext } from '@flowgram.ai/free-layout-editor';
import {
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  LoaderCircle,
  Pause,
  SkipForward,
  Copy,
  FileDown,
  FileUp,
  ChevronDown,
  Settings,
  History,
  Play,
  FilePlus2,
  RotateCcw,
  Square,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react';
import { getSession, MivoClient } from './api';
import { StudioContext } from './context';
import { WorkflowEditor } from './editor';
import { WorkflowDraftItem } from './WorkflowDraftItem';
import { useWorkflowAutosave } from './useWorkflowAutosave';
import { BundleView, Inspector } from './inspector';
import {
  captureWorkflow,
  createWorkflow,
  type Environment,
  type RunSnapshot,
  type Workflow,
} from './model';
import { getLlmKey } from './llm';
import { SettingsDialog } from './SettingsDialog';
import { listRuns, runRequest, type RunRecord } from './run-client';
import {
  downloadJSON,
  loadWorkflow,
  loadWorkflowDrafts,
  validateWorkflow,
  type WorkflowDraft,
} from './storage';

const statusNames = {
  idle: '未运行',
  running: '运行中',
  success: '已完成',
  error: '失败',
  paused: '已暂停',
  skipped: '未命中',
};
export function App({ initialEnvironment = 'local' }: { initialEnvironment?: Environment }) {
  const [workflow, setWorkflow] = useState(loadWorkflow);
  const [environment, setEnvironment] = useState<Environment>(initialEnvironment);
  const [selectedId, setSelectedId] = useState<string>();
  const [snapshot, setSnapshot] = useState<RunSnapshot>();
  const [running, setRunning] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  function closeSettings() {
    setShowLogin(false);
  }
  const [sessionVersion, setSessionVersion] = useState(0);
  const [notification, notify] = useState('');
  const { workflows, persist, selectDraft, selectedDraftId } = useWorkflowAutosave(
    workflow,
    notify,
  );
  const [showRuns, setShowRuns] = useState(false);
  const select = useCallback((id: string | undefined) => {
    setSelectedId(id);
    if (id) setShowRuns(false);
  }, []);
  function toggleRuns() {
    if (!showRuns) setSelectedId(undefined);
    setShowRuns(!showRuns);
  }
  const [editorVersion, setEditorVersion] = useState(0);
  const [editorReady, setEditorReady] = useState(false);
  const [toolbarContainer, setToolbarContainer] = useState<HTMLDivElement | null>(null);
  const ctxRef = useRef<FreeLayoutPluginContext>();
  const [activeRun, setActiveRun] = useState<RunRecord>();
  const importRef = useRef<HTMLInputElement>(null);
  const sequenceRef = useRef(0);
  const lastRunError = useRef<string>();
  const submittingRef = useRef(false);
  const workflowRef = useRef(workflow);
  const environmentRef = useRef(environment);
  workflowRef.current = workflow;
  environmentRef.current = environment;
  const session = getSession(environment);
  const owner = session?.owner;

  useEffect(() => {
    const update = () => setSessionVersion((value) => value + 1);
    window.addEventListener('mivo-session', update);
    return () => window.removeEventListener('mivo-session', update);
  }, []);

  useEffect(() => {
    if (!owner) return;
    const controller = new AbortController();
    void new MivoClient(environment).warmCapabilities(controller.signal).catch((error) => {
      if (!controller.signal.aborted) {
        notify(error instanceof Error ? error.message : '能力缓存同步失败，请重新保存 Key');
      }
    });
    return () => controller.abort();
  }, [environment, owner, sessionVersion]);

  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      document.querySelectorAll('details[open][class]').forEach((menu) => {
        if (event.target instanceof Node && !menu.contains(event.target)) {
          menu.removeAttribute('open');
        }
      });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (showLogin) {
        closeSettings();
      } else {
        select(undefined);
        setShowRuns(false);
        document.querySelectorAll('details[open][class]').forEach((menu) => {
          menu.removeAttribute('open');
        });
      }
    };
    document.addEventListener('pointerdown', closeMenus);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', closeMenus);
      document.removeEventListener('keydown', escape);
    };
  }, [showLogin]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setSnapshot(undefined);
    setActiveRun(undefined);
    setRunning(false);
    const refresh = async () => {
      try {
        const records = await listRuns(workflow.id, environment, controller.signal);
        if (controller.signal.aborted || submittingRef.current) return;
        const latest = records[0];
        setActiveRun(latest);
        setSnapshot(latest?.snapshot);
        setRunning(latest?.snapshot.status === 'running');
        if (latest?.error && lastRunError.current !== latest.id + latest.error) {
          lastRunError.current = latest.id + latest.error;
          notify(latest.error);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          notify(error instanceof Error ? error.message : '无法读取运行记录');
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 1000);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
      sequenceRef.current++;
    };
  }, [workflow.id, environment, owner]);

  useEffect(() => {
    if (editorReady && ctxRef.current) ctxRef.current.playground.config.readonly = running;
  }, [running, editorReady]);

  async function stop() {
    if (!activeRun) return;
    try {
      const record = await runRequest<RunRecord>('/runs/' + activeRun.id + '/stop', {});
      setActiveRun(record);
      setSnapshot(record.snapshot);
      setRunning(record.snapshot.status === 'running');
    } catch (error) {
      notify(error instanceof Error ? error.message : '暂停失败');
    }
  }

  const save = useCallback((ctx: FreeLayoutPluginContext) => {
    if (ctx.document.disposed || ctx !== ctxRef.current) return;
    const json = ctx.document.toJSON();
    const nodes = json.nodes as Workflow['nodes'];
    const edges = json.edges as Workflow['edges'];
    setWorkflow((current) => {
      if (
        JSON.stringify({ nodes: current.nodes, edges: current.edges }) ===
        JSON.stringify({ nodes, edges })
      )
        return current;
      const updated = captureWorkflow(current, { nodes, edges });
      return JSON.stringify(updated) === JSON.stringify(current) ? current : updated;
    });
  }, []);

  const onReady = useCallback((ctx: FreeLayoutPluginContext) => {
    ctxRef.current = ctx;
    setEditorReady(true);
  }, []);

  const currentSnapshot = useMemo(
    () =>
      snapshot?.workflowId === workflow.id &&
      snapshot.environment === environment &&
      snapshot.owner === (owner ?? 'local')
        ? snapshot
        : undefined,
    [workflow, snapshot, environment, owner],
  );
  const canContinue = ['paused', 'error'].includes(currentSnapshot?.status ?? '');
  const selectedNode =
    editorReady && selectedId ? ctxRef.current?.document.getNode(selectedId) : null;

  async function run(nodeId?: string, resume = false) {
    if (running || submittingRef.current || !ctxRef.current) return;
    const latest = captureWorkflow(
      workflowRef.current,
      ctxRef.current.document.toJSON() as Workflow,
    );
    const needsGeneration = latest.nodes.some((node) => node.type === 'generate');
    if (needsGeneration && (!getSession(environment) || !getLlmKey())) {
      setShowLogin(true);
      notify('请先配置当前环境的 Mivo API Key 和 Tapsvc API Key');
      return;
    }
    const sequence = ++sequenceRef.current;
    submittingRef.current = true;
    try {
      validateWorkflow(latest);
      await persist(latest);
      setWorkflow(latest);
      setRunning(true);
      notify('');
      const input = {
        workflowId: latest.id,
        workflow: latest,
        environment,
        nodeId,
        resumeRunId: resume ? activeRun?.id : undefined,
      };
      let record: RunRecord;
      try {
        record = await runRequest<RunRecord>('/runs', input);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('confirmRestartRequired' in error) ||
          !error.confirmRestartRequired ||
          !window.confirm('仍有生成任务待确认。重新运行可能重复生成和计费，确认重新运行？')
        ) {
          throw error;
        }
        record = await runRequest<RunRecord>('/runs', { ...input, confirmRestart: true });
      }
      if (sequence !== sequenceRef.current) return;
      setActiveRun(record);
      setSnapshot(record.snapshot);
      setRunning(record.snapshot.status === 'running');
      setSelectedId(undefined);
    } catch (error) {
      if (sequence === sequenceRef.current) {
        setRunning(false);
        notify(error instanceof Error ? error.message : String(error));
      }
    } finally {
      submittingRef.current = false;
    }
  }

  async function replaceWorkflow(next: Workflow, draft?: WorkflowDraft) {
    if (running) return;
    if (draft?.id === selectedDraftId && next.id === workflowRef.current.id) return;
    const ctx = ctxRef.current;
    const current = workflowRef.current;
    try {
      const json = ctx && !ctx.document.disposed ? ctx.document.toJSON() : undefined;
      const before = json ? captureWorkflow(current, json as Workflow) : current;
      await persist(before, true);
      const validated = validateWorkflow(next);
      if (ctx && !ctx.document.disposed && validated.id === current.id) {
        ctx.history.startTransaction();
        try {
          ctx.operation.fromJSON({ nodes: validated.nodes, edges: validated.edges });
        } finally {
          ctx.history.endTransaction();
        }
        const restored = ctx.document.toJSON();
        const updated = captureWorkflow(validated, restored as Workflow);
        workflowRef.current = updated;
        setWorkflow(updated);
        select(undefined);
        setSnapshot(undefined);
        if (draft) await selectDraft(draft, updated);
        else await persist(updated, true);
      } else {
        if (draft) await selectDraft(draft, validated);
        else await persist(validated, true);
        ctxRef.current = undefined;
        setEditorReady(false);
        select(undefined);
        setSnapshot(undefined);
        workflowRef.current = validated;
        setWorkflow(validated);
        setEditorVersion((value) => value + 1);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法保存工作流，请先导出当前内容');
    }
  }

  const nodes = workflow.nodes;
  const runNodes = useMemo(() => {
    const pending = new Map(workflow.nodes.map((node) => [node.id, node]));
    const ordered: Workflow['nodes'] = [];
    while (pending.size) {
      const next = [...pending.values()].find((node) =>
        workflow.edges.every(
          (edge) => edge.targetNodeID !== node.id || !pending.has(edge.sourceNodeID),
        ),
      );
      if (!next) break;
      ordered.push(next);
      pending.delete(next.id);
    }
    return [...ordered, ...pending.values()];
  }, [workflow.nodes, workflow.edges]);
  const runs = runNodes.map((node) => ({
    node,
    value: currentSnapshot?.nodes[node.id] ?? { status: 'idle' as const },
  }));
  const completed = runs.filter(({ value }) => value.status === 'success').length;
  const outputNode = workflow.nodes.find((node) => node.type === 'end');
  const finalOutput = outputNode ? currentSnapshot?.nodes[outputNode.id]?.output : undefined;

  return (
    <StudioContext.Provider
      value={{
        workflow,
        environment,
        selectedId,
        snapshot: currentSnapshot,
        running,
        select,
        run: (id) => {
          void run(id);
        },
        save,
        notify,
      }}
    >
      <main className="relative isolate h-dvh w-screen overflow-hidden bg-slate-50">
        <div className="absolute inset-0">
          <WorkflowEditor
            key={`${workflow.id}:${editorVersion}`}
            onReady={onReady}
            toolbarContainer={toolbarContainer}
          />
        </div>
        <div className="canvas-command-bar floating-panel" aria-label="工作流控制台">
          <button
            className="dock-settings"
            aria-label="设置"
            title="设置"
            onClick={() => setShowLogin(true)}
          >
            <Settings size={15} />
            <span>设置</span>
          </button>
          <details className="workflow-switcher workflow-menu pointer-events-auto">
            <summary className="workflow-trigger" aria-label="工作流菜单" title="工作流菜单">
              <span className="workflow-mark">
                <WorkflowIcon size={16} />
              </span>
              <span className="workflow-identity flex min-w-0 items-center gap-1">
                <span className="workflow-name">{workflow.name || '未命名工作流'}</span>
              </span>
              <ChevronDown className="workflow-menu-chevron" size={16} />
            </summary>
            <div className="workflow-switcher-menu">
              <button
                className="menu-action"
                disabled={running}
                onClick={(e) => {
                  const next = createWorkflow();
                  let suffix = 1;
                  while (workflows.some((item) => item.name === next.name)) {
                    suffix += 1;
                    next.name = `未命名工作流 ${suffix}`;
                  }
                  void replaceWorkflow(next);
                  e.currentTarget.closest('details')?.removeAttribute('open');
                }}
              >
                <FilePlus2 size={16} />
                新建工作流
              </button>
              <button
                className="menu-action"
                disabled={running}
                onClick={(e) => {
                  importRef.current?.click();
                  e.currentTarget.closest('details')?.removeAttribute('open');
                }}
              >
                <FileUp size={16} />
                导入 JSON
              </button>
              <button
                className="menu-action"
                onClick={(e) => {
                  downloadJSON(workflow, `${workflow.name || '工作流'}.json`);
                  e.currentTarget.closest('details')?.removeAttribute('open');
                }}
              >
                <FileDown size={16} />
                导出 JSON
              </button>
              <button
                className="menu-action"
                onClick={(event) => {
                  const details = event.currentTarget.closest('details');
                  void (async () => {
                    try {
                      const currentWorkflow = structuredClone(workflowRef.current);
                      await persist(currentWorkflow, true);
                      const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
                      const command = [
                        'mivo-workflow run --workflow-id ' + quote(currentWorkflow.id),
                        ...(
                          currentWorkflow.nodes.find((node) => node.type === 'start')?.data
                            .fields ?? []
                        ).map(
                          (field) =>
                            '--' +
                            quote(field.name.trim()) +
                            ' ' +
                            quote(
                              field.type === 'string'
                                ? field.value || '请输入内容'
                                : './' +
                                    field.name.trim() +
                                    {
                                      image: '.png',
                                      video: '.mp4',
                                      audio: '.mp3',
                                      model3d: '.glb',
                                    }[field.type],
                            ),
                        ),
                      ].join(' ');
                      await navigator.clipboard.writeText(command);
                      details?.removeAttribute('open');
                      notify('运行命令已复制');
                    } catch (error) {
                      notify(error instanceof Error ? error.message : '复制失败，请重试');
                    }
                  })();
                }}
              >
                <Copy size={16} />
                复制运行命令
              </button>
              <div className="workflow-rename">
                <input
                  aria-label="工作流名称"
                  placeholder="工作流名称"
                  value={workflow.name}
                  disabled={running}
                  onChange={(event) => {
                    const next = { ...workflowRef.current, name: event.target.value };
                    workflowRef.current = next;
                    setWorkflow(next);
                    void persist(next).catch(() => {
                      notify('名称保存失败，请确认本地服务已启动');
                    });
                  }}
                />
              </div>
              <div className="my-1 border-t border-slate-100" />
              <div className="workflow-list" aria-label="已保存的工作流">
                {workflows.map((item) => (
                  <WorkflowDraftItem
                    key={item.id}
                    workflow={item}
                    active={item.id === workflow.id}
                    disabled={running}
                    selectedDraftId={item.id === workflow.id ? selectedDraftId : undefined}
                    onSelect={() => {
                      if (item.id === workflow.id) return;
                      const latest = loadWorkflowDrafts(item.id)[0];
                      if (latest) replaceWorkflow(latest.workflow, latest);
                      else replaceWorkflow(item);
                    }}
                    onRestore={(draft) => replaceWorkflow(draft.workflow, draft)}
                  />
                ))}
              </div>
            </div>
          </details>
          <div className="canvas-tool-slot" ref={setToolbarContainer} />
          <div
            className={[
              'command-actions pointer-events-auto',
              'flex shrink-0 items-center gap-2 p-1.5',
            ].join(' ')}
          >
            <button
              className={[
                'command-history',
                showRuns ? 'is-active' : '',
                running ? 'is-running' : '',
              ].join(' ')}
              title={running ? '运行中 · 查看运行记录' : '运行记录'}
              aria-label="运行记录"
              aria-expanded={showRuns}
              onClick={toggleRuns}
            >
              {running ? <LoaderCircle size={16} /> : <History size={16} />}
              <span className="hidden sm:inline">运行记录</span>
              {currentSnapshot && (
                <span className={`command-run-dot status-${currentSnapshot.status}`} />
              )}
            </button>
            <span className="command-divider" />
            <div className="mx-1 h-5 w-px bg-slate-200" />
            {running ? (
              <button className="primary-button" onClick={() => void stop()}>
                <Square size={13} />
                暂停
              </button>
            ) : (
              <>
                {canContinue && (
                  <button
                    className="icon-button"
                    title="重新运行全部"
                    aria-label="重新运行全部"
                    onClick={() => void run()}
                  >
                    <RotateCcw size={15} />
                  </button>
                )}
                <button
                  className="primary-button"
                  disabled={!editorReady}
                  title={canContinue ? '复用未改变的上游结果，只运行未完成的节点' : undefined}
                  onClick={() => void run(undefined, canContinue)}
                >
                  <Play size={13} />
                  {canContinue
                    ? '继续运行'
                    : currentSnapshot?.status === 'success'
                      ? '重新运行全部'
                      : '运行'}
                </button>
              </>
            )}
          </div>
        </div>
        {selectedNode && <Inspector key={selectedNode.id} node={selectedNode} />}
        {nodes.length === 2 && !selectedNode && !showRuns && (
          <div
            className={[
              'canvas-onboarding pointer-events-none absolute inset-x-4 bottom-24 z-10',
              'text-center text-xs text-slate-500',
            ].join(' ')}
          >
            从节点右侧圆点拖线，连接已有节点或创建新节点
          </div>
        )}
        {showRuns && (
          <section className="run-panel run-panel-top floating-panel" aria-label="运行记录面板">
            <div className="run-heading">
              <History size={16} />
              <strong>运行记录</strong>
              <span className={`run-summary ${currentSnapshot?.status ?? 'idle'}`}>
                {currentSnapshot ? statusNames[currentSnapshot.status] : '尚未运行'}
              </span>
              <span className="run-count">
                {completed} / {nodes.length}
              </span>
              <button
                className="icon-button"
                title="收起运行记录"
                aria-label="收起运行记录"
                onClick={() => setShowRuns(false)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="run-panel-body">
              <div className="run-list">
                {runs.map(({ node, value }) => {
                  const StatusIcon = {
                    idle: Circle,
                    running: LoaderCircle,
                    success: Check,
                    error: CircleAlert,
                    paused: Pause,
                    skipped: SkipForward,
                  }[value.status];
                  return (
                    <button
                      className={`run-row ${value.status}`}
                      key={node.id}
                      onClick={() => select(node.id)}
                    >
                      <span className="run-step-icon">
                        <StatusIcon size={15} />
                      </span>
                      <span className="run-step-content">
                        <strong>{node.data.title}</strong>
                        {value.status === 'running' && value.stage && <small>{value.stage}</small>}
                        {value.error && <small className="error-text">{value.error}</small>}
                      </span>
                      <span className="run-step-status">{statusNames[value.status]}</span>
                      <ChevronRight size={13} className="run-step-arrow" />
                    </button>
                  );
                })}
              </div>
              {finalOutput && (
                <div className="run-output">
                  <strong>运行结果</strong>
                  <BundleView bundle={finalOutput} />
                </div>
              )}
            </div>
          </section>
        )}
        {notification && (
          <div className="notification" role="alert">
            <span>{notification}</span>
            <button className="icon-button" title="关闭提示" onClick={() => notify('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {showLogin && (
          <SettingsDialog
            environment={environment}
            running={running}
            onEnvironmentChange={(next) => {
              setEnvironment(next);
              void fetch('/local-api/settings', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ environment: next }),
              })
                .then((response) => {
                  if (!response.ok) throw new Error('无法保存 API 环境');
                })
                .catch((error) => notify(error.message));
            }}
            onClose={closeSettings}
          />
        )}
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            if (file.size > 5 * 1024 * 1024) {
              notify('工作流文件不能超过 5 MB');
              return;
            }
            void file
              .text()
              .then((text) => replaceWorkflow(validateWorkflow(JSON.parse(text))))
              .catch((error) => notify(error.message));
          }}
        />
      </main>
    </StudioContext.Provider>
  );
}
