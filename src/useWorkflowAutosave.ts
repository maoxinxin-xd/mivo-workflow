import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workflow } from './model';
import {
  loadSelectedDraftId,
  loadWorkflows,
  saveWorkflow,
  selectWorkflowDraft,
  workflowContent,
  type WorkflowDraft,
} from './storage';

const SAVE_DELAY = 1000;
const SAVE_ERROR = '无法保存工作流，请确认本地服务已启动后再重试';

export function useWorkflowAutosave(workflow: Workflow, notify: (message: string) => void) {
  const [saved, setSaved] = useState(true);
  const [workflows, setWorkflows] = useState(loadWorkflows);
  const [selectedDraftId, setSelectedDraftId] = useState(loadSelectedDraftId);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pending = useRef(0);
  const savedContent = useRef<string | undefined>(
    selectedDraftId ? workflowContent(workflow) : undefined,
  );
  const latest = useRef(workflow);
  latest.current = workflow;

  const persist = useCallback(async (next: Workflow, preserveDraft = false) => {
    clearTimeout(timer.current);
    if (workflowContent(next) === savedContent.current) return;
    pending.current += 1;
    try {
      await saveWorkflow(next, preserveDraft);
      savedContent.current = workflowContent(next);
      setWorkflows(loadWorkflows());
      setSelectedDraftId(loadSelectedDraftId());
      setSaved(workflowContent(latest.current) === savedContent.current);
    } catch (error) {
      setSaved(false);
      throw error;
    } finally {
      pending.current -= 1;
    }
  }, []);

  const selectDraft = useCallback(
    async (draft: WorkflowDraft, displayed: Workflow) => {
      pending.current += 1;
      try {
        await selectWorkflowDraft(draft);
      } catch (error) {
        notify(SAVE_ERROR);
        throw error;
      } finally {
        pending.current -= 1;
      }
      clearTimeout(timer.current);
      savedContent.current = workflowContent(displayed);
      latest.current = displayed;
      setSelectedDraftId(draft.id);
      setWorkflows(loadWorkflows());
      setSaved(true);
    },
    [notify],
  );

  useEffect(() => {
    if (workflowContent(workflow) === savedContent.current) return;
    setSaved(false);
    const save = async () => {
      try {
        await persist(workflow);
      } catch {
        notify(SAVE_ERROR);
      }
    };
    if (savedContent.current === undefined) void save();
    else timer.current = setTimeout(save, SAVE_DELAY);
    return () => clearTimeout(timer.current);
  }, [workflow, persist, notify]);

  useEffect(() => {
    const flush = async () => {
      if (workflowContent(latest.current) === savedContent.current) return;
      try {
        await persist(latest.current);
      } catch {
        notify(SAVE_ERROR);
      }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (pending.current || workflowContent(latest.current) !== savedContent.current) {
        event.preventDefault();
        event.returnValue = '';
        void flush();
      }
    };
    const hide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', hide);
    return () => {
      clearTimeout(timer.current);
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('visibilitychange', hide);
      if (workflowContent(latest.current) !== savedContent.current) {
        void persist(latest.current).catch(() => notify(SAVE_ERROR));
      }
    };
  }, [persist, notify]);

  return {
    saved,
    workflows,
    persist,
    selectDraft,
    selectedDraftId:
      workflowContent(workflow) === savedContent.current ? selectedDraftId : undefined,
  };
}
