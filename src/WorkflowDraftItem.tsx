import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, Clock3, Workflow as WorkflowIcon } from 'lucide-react';
import type { Workflow } from './model';
import { loadWorkflowDrafts, type WorkflowDraft } from './storage';

function draftLabel(draft: WorkflowDraft, index: number, now: number) {
  if (index === 0) return '最新草稿';
  if (draft.savedAt === null) return '草稿';
  const seconds = Math.max(0, Math.floor((now - draft.savedAt) / 1000));
  if (seconds < 60) return `草稿于 ${seconds} 秒前保存`;
  if (seconds < 3600) return `草稿于 ${Math.floor(seconds / 60)} 分钟前保存`;
  if (seconds < 86400) return `草稿于 ${Math.floor(seconds / 3600)} 小时前保存`;
  return `草稿于 ${Math.floor(seconds / 86400)} 天前保存`;
}

export function WorkflowDraftItem({
  workflow,
  active,
  disabled,
  selectedDraftId,
  onSelect,
  onRestore,
}: {
  workflow: Workflow;
  active: boolean;
  disabled: boolean;
  selectedDraftId?: string;
  onSelect: () => void;
  onRestore: (draft: WorkflowDraft) => void;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<WorkflowDraft[]>([]);
  const [now, setNow] = useState(Date.now);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const menuId = `workflow-drafts-${workflow.id}`;

  function keepOpen() {
    clearTimeout(closeTimer.current);
  }
  function closeSoon() {
    keepOpen();
    closeTimer.current = setTimeout(() => setOpen(false), 220);
  }
  function showDrafts() {
    if (disabled) return;
    keepOpen();
    setDrafts(loadWorkflowDrafts(workflow.id));
    setNow(Date.now());
    setOpen(true);
  }
  function closeParent() {
    setOpen(false);
    anchorRef.current?.closest('details')?.removeAttribute('open');
  }

  useEffect(() => {
    const parent = anchorRef.current?.closest('details');
    const onToggle = () => {
      if (!parent?.open) setOpen(false);
    };
    parent?.addEventListener('toggle', onToggle);
    return () => {
      clearTimeout(closeTimer.current);
      parent?.removeEventListener('toggle', onToggle);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !menuRef.current) return;
    const anchor = anchorRef.current.getBoundingClientRect();
    const width = Math.min(200, window.innerWidth - 24);
    const toolbar = document.querySelector('.canvas-command-bar')?.getBoundingClientRect();
    const top = Math.max(12, (toolbar?.bottom ?? 0) + 12);
    const bottom = window.innerHeight - 12;
    const height = Math.min(menuRef.current.scrollHeight, bottom - top);
    const right = anchor.right + 8;
    const left = right + width <= window.innerWidth - 12 ? right : anchor.left - width - 8;
    setPosition({
      left: Math.max(12, Math.min(left, window.innerWidth - width - 12)),
      top: Math.max(top, Math.min(anchor.top, bottom - height)),
      width,
      maxHeight: Math.max(0, bottom - top),
      visibility: 'visible',
    });
    const close = () => setOpen(false);
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchorRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    const scroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={anchorRef}
        className={`workflow-list-item ${active ? 'is-active' : ''}`}
        aria-current={active ? 'true' : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onMouseEnter={showDrafts}
        onMouseLeave={closeSoon}
        onFocus={showDrafts}
        onBlur={closeSoon}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            showDrafts();
            requestAnimationFrame(() => menuRef.current?.querySelector('button')?.focus());
          }
        }}
        onClick={() => {
          onSelect();
          closeParent();
        }}
      >
        <WorkflowIcon size={16} />
        <span>
          <strong>{workflow.name || '未命名工作流'}</strong>
          <small>{workflow.nodes.length} 个节点</small>
        </span>
        {active && <Check size={14} />}
        <ChevronRight size={14} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className="workflow-draft-menu"
            role="menu"
            aria-label={`${workflow.name || '未命名工作流'}的草稿列表`}
            style={position}
            onMouseEnter={keepOpen}
            onMouseLeave={closeSoon}
            onFocus={keepOpen}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) closeSoon();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                anchorRef.current?.focus();
                setOpen(false);
              }
            }}
          >
            {drafts.map((draft, index) => (
              <button
                key={draft.id}
                className={`draft-menu-item ${draft.id === selectedDraftId ? 'is-active' : ''}`}
                role="menuitemradio"
                aria-checked={draft.id === selectedDraftId}
                disabled={disabled}
                onClick={() => {
                  if (draft.id !== selectedDraftId) onRestore(draft);
                  closeParent();
                }}
              >
                <Clock3 size={16} />
                <span>{draftLabel(draft, index, now)}</span>
                {draft.id === selectedDraftId && <Check size={14} />}
              </button>
            ))}
            {!drafts.length && <p className="draft-menu-empty">暂无保存的草稿</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
