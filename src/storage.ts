import { createWorkflow, type Workflow } from './model';
import {
  validateWorkflow,
  workflowContent,
  type WorkflowDraft,
  type WorkflowLibrary,
} from './workflow-validation';

export { validateWorkflow, workflowContent, type WorkflowDraft } from './workflow-validation';

const LIBRARY_KEY = 'mivo-flowgram:workflows:v2';
let library: WorkflowLibrary = { activeId: '', workflows: [] };
let writeQueue: Promise<void> = Promise.resolve();

function normalizeLibrary(value: unknown): WorkflowLibrary {
  const candidate = value as WorkflowLibrary;
  if (!candidate || typeof candidate.activeId !== 'string' || !Array.isArray(candidate.workflows)) {
    throw new Error('工作流列表读取失败');
  }
  const workflows = candidate.workflows.map(validateWorkflow);
  const ids = new Set(workflows.map((workflow) => workflow.id));
  const drafts = Object.fromEntries(
    workflows.map((workflow) => [
      workflow.id,
      (candidate.drafts?.[workflow.id] ?? []).flatMap((draft) => {
        try {
          if (
            typeof draft.id !== 'string' ||
            (draft.savedAt !== null && !Number.isFinite(draft.savedAt)) ||
            draft.workflow?.id !== workflow.id
          ) {
            return [];
          }
          return [{ ...draft, workflow: validateWorkflow(draft.workflow) }];
        } catch {
          return [];
        }
      }),
    ]),
  );
  const activeId = ids.has(candidate.activeId) ? candidate.activeId : (workflows[0]?.id ?? '');
  const selectedDraftId = drafts[activeId]?.some((draft) => draft.id === candidate.selectedDraftId)
    ? candidate.selectedDraftId
    : undefined;
  return { activeId, workflows, drafts, selectedDraftId };
}

async function requestLibrary(path: string, body?: unknown): Promise<WorkflowLibrary> {
  const response = await fetch(`/local-api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `本地存储请求失败（${response.status}）`;
    try {
      const result = await response.json();
      if (typeof result?.error === 'string') message = result.error;
    } catch {
      // Keep the status-based error when the response is not JSON.
    }
    throw new Error(message);
  }
  return normalizeLibrary(await response.json());
}

function enqueueWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(write, write);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function initializeStorage(): Promise<void> {
  await enqueueWrite(async () => {
    const remote = await requestLibrary('library');
    const stored = localStorage.getItem(LIBRARY_KEY);
    if (!stored) {
      library = remote;
      return;
    }

    let legacy: WorkflowLibrary;
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed.workflows)) {
        parsed.workflows = parsed.workflows.flatMap((item: unknown) => {
          try {
            return [validateWorkflow(item)];
          } catch {
            return [];
          }
        });
      }
      legacy = normalizeLibrary(parsed);
    } catch {
      library = remote;
      throw new Error('旧工作流数据无效，请导出备份后再重新加载');
    }
    library = await requestLibrary('library/migrate', { library: legacy });
    localStorage.removeItem(LIBRARY_KEY);
  });
}

export function loadWorkflows(): Workflow[] {
  return library.workflows;
}

export function loadWorkflow(): Workflow {
  const selected = library.drafts?.[library.activeId]?.find(
    (draft) => draft.id === library.selectedDraftId,
  );
  return (
    selected?.workflow ??
    library.workflows.find((item) => item.id === library.activeId) ??
    createWorkflow()
  );
}

export function loadWorkflowDrafts(workflowId: string): WorkflowDraft[] {
  const drafts = library.drafts?.[workflowId];
  if (drafts?.length) return drafts;
  const workflow = library.workflows.find((item) => item.id === workflowId);
  return workflow ? [{ id: `legacy-${workflowId}`, savedAt: null, workflow }] : [];
}

export function loadSelectedDraftId(): string | undefined {
  return library.selectedDraftId ?? loadWorkflowDrafts(library.activeId)[0]?.id;
}

export function selectWorkflowDraft(draft: WorkflowDraft): Promise<void> {
  return enqueueWrite(async () => {
    const next = await requestLibrary('drafts/select', {
      workflowId: draft.workflow.id,
      draftId: draft.id,
    });
    library = next;
  });
}

export function saveWorkflow(workflow: Workflow, preserveDraft = false): Promise<void> {
  return enqueueWrite(async () => {
    const next = await requestLibrary('workflows', { workflow, preserveDraft });
    library = next;
  });
}

export function downloadJSON(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
