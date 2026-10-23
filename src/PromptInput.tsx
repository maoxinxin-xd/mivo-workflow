import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownLeft } from 'lucide-react';

interface Reference {
  value: string;
  label: string;
}

function serialize(node: Node): string {
  if (node instanceof HTMLElement && node.dataset.reference) {
    return `{{${node.dataset.reference}}}`;
  }
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeName === 'BR') return '\n';
  return Array.from(node.childNodes)
    .map((child) => {
      const text = serialize(child);
      return ['DIV', 'P'].includes(child.nodeName) && child.nextSibling ? `${text}\n` : text;
    })
    .join('');
}

function point(root: Node, offset: number): [Node, number] {
  for (const child of Array.from(root.childNodes)) {
    const length = serialize(child).length;
    if (offset <= length) {
      if (child instanceof HTMLElement && child.dataset.reference) {
        const index = Array.from(root.childNodes).indexOf(child);
        return [root, index + (offset > 0 ? 1 : 0)];
      }
      if (child.nodeType === Node.TEXT_NODE) return [child, offset];
      return point(child, offset);
    }
    offset -= length;
  }
  return [root, root.childNodes.length];
}

function rangeAt(root: Node, start: number, end = start) {
  const range = document.createRange();
  range.setStart(...point(root, start));
  range.setEnd(...point(root, end));
  return range;
}

function caret(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const start = serialize(before.cloneContents()).length;
  return { start, end: start + serialize(range.cloneContents()).length };
}

export function PromptInput({
  value,
  onChange,
  references,
  labels = {},
  disabled = false,
}: {
  value: string;
  onChange: (value: string, labels?: Record<string, string>) => void;
  references: Reference[];
  labels?: Record<string, string>;
  disabled?: boolean;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 220 });
  const listId = useId();
  const [mention, setMention] = useState<{ start: number; end: number; query: string }>();
  const [active, setActive] = useState(0);
  const matches = references.filter((reference) =>
    `${reference.label} ${reference.value}`
      .toLowerCase()
      .includes(mention?.query.toLowerCase() ?? ''),
  );
  const names = {
    ...labels,
    ...Object.fromEntries(references.map((ref) => [ref.value, ref.label])),
  };

  function paint(text: string, cursor?: number, nextNames = names) {
    const root = editor.current;
    if (!root) return;
    const fragment = document.createDocumentFragment();
    let end = 0;
    for (const match of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      fragment.append(document.createTextNode(text.slice(end, match.index)));
      const tag = document.createElement('span');
      tag.contentEditable = 'false';
      tag.className = 'prompt-reference-tag';
      tag.dataset.reference = match[1];
      tag.textContent = `@ ${nextNames[match[1]] ?? '上游引用'}`;
      fragment.append(tag);
      end = match.index! + match[0].length;
    }
    fragment.append(document.createTextNode(text.slice(end)));
    root.replaceChildren(fragment);
    if (cursor !== undefined) {
      root.focus();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(rangeAt(root, cursor));
    }
  }

  useLayoutEffect(() => {
    if (composing.current || !editor.current) return;
    if (serialize(editor.current) !== value || !editor.current.childNodes.length) paint(value);
    editor.current.querySelectorAll<HTMLElement>('[data-reference]').forEach((tag) => {
      tag.textContent = `@ ${names[tag.dataset.reference!] ?? '上游引用'}`;
    });
  }, [value, JSON.stringify(names)]);

  function detect() {
    const root = editor.current;
    const cursor = root && caret(root);
    const text = root ? serialize(root) : '';
    const match = cursor && text.slice(0, cursor.start).match(/@([^\s@{}]*)$/);
    setMention(
      match && cursor.start === cursor.end
        ? {
            start: cursor.start - match[0].length,
            end: cursor.start,
            query: match[1],
          }
        : undefined,
    );
    setActive(0);
  }

  function publish() {
    if (!editor.current || composing.current) return;
    if (editor.current.childNodes.length === 1 && editor.current.firstChild?.nodeName === 'BR') {
      editor.current.replaceChildren();
    }
    onChange(serialize(editor.current));
    detect();
  }

  function replace(start: number, end: number, text: string) {
    if (!editor.current) return;
    const current = serialize(editor.current);
    const next = current.slice(0, start) + text + current.slice(end);
    paint(next, start + text.length);
    onChange(next);
    detect();
  }

  function insert(reference: Reference) {
    if (!mention || !editor.current) return;
    const current = serialize(editor.current);
    const token = `{{${reference.value}}}`;
    const next = current.slice(0, mention.start) + token + current.slice(mention.end);
    const nextNames = { ...names, [reference.value]: reference.label };
    paint(next, mention.start + token.length, nextNames);
    onChange(next, nextNames);
    setMention(undefined);
  }

  useLayoutEffect(() => {
    if (!mention || !editor.current) return;
    const place = () => {
      const root = editor.current;
      if (!root) return;
      const anchor = rangeAt(root, mention.start, mention.start + 1).getBoundingClientRect();
      const bounds = root.getBoundingClientRect();
      if (anchor.bottom < bounds.top || anchor.top > bounds.bottom) {
        setMention(undefined);
        return;
      }
      const width = Math.min(220, window.innerWidth - 16);
      const height = menu.current?.offsetHeight ?? 200;
      const below = anchor.bottom + 5;
      setPosition({
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
        top: Math.max(8, below + height > window.innerHeight - 8 ? anchor.top - height - 5 : below),
        width,
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    const observer = new ResizeObserver(place);
    observer.observe(editor.current);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      observer.disconnect();
    };
  }, [mention?.start, value, matches.length]);

  return (
    <div className="my-4">
      <label id={`${listId}-label`} className="mb-2 mt-0" onClick={() => editor.current?.focus()}>
        提示词
      </label>
      <div className="relative">
        <div
          ref={editor}
          className="prompt-editor"
          contentEditable={!disabled}
          aria-disabled={disabled}
          suppressContentEditableWarning
          role="combobox"
          aria-labelledby={`${listId}-label`}
          aria-multiline="true"
          aria-autocomplete="list"
          aria-expanded={!!mention}
          aria-controls={mention ? listId : undefined}
          aria-activedescendant={mention && matches.length ? `${listId}-${active}` : undefined}
          data-placeholder="描述你想生成的内容，输入 @ 引用上游变量…"
          onInput={publish}
          onDrop={(event) => event.preventDefault()}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
            publish();
          }}
          onClick={detect}
          onBlur={() => setMention(undefined)}
          onPaste={(event) => {
            event.preventDefault();
            const cursor = editor.current && caret(editor.current);
            if (cursor)
              replace(cursor.start, cursor.end, event.clipboardData.getData('text/plain'));
          }}
          onKeyUp={(event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) detect();
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const root = editor.current;
            const cursor = root && caret(root);
            if (
              root &&
              cursor?.start === cursor?.end &&
              ['Backspace', 'Delete'].includes(event.key)
            ) {
              let offset = 0;
              for (const child of Array.from(root.childNodes)) {
                const length = serialize(child).length;
                const boundary = event.key === 'Backspace' ? offset + length : offset;
                if (
                  child instanceof HTMLElement &&
                  child.dataset.reference &&
                  cursor &&
                  cursor.start === boundary
                ) {
                  event.preventDefault();
                  replace(offset, offset + length, '');
                  return;
                }
                offset += length;
              }
            }
            if (mention && event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setMention(undefined);
            } else if (mention && ['ArrowDown', 'ArrowUp'].includes(event.key) && matches.length) {
              event.preventDefault();
              const direction = event.key === 'ArrowDown' ? 1 : -1;
              const index = (active + direction + matches.length) % matches.length;
              setActive(index);
              document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: 'nearest' });
            } else if (mention && event.key === 'Enter' && matches.length) {
              event.preventDefault();
              insert(matches[Math.min(active, matches.length - 1)]);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const cursor = editor.current && caret(editor.current);
              if (cursor) replace(cursor.start, cursor.end, '\n');
            }
          }}
        />
        {mention &&
          createPortal(
            <div ref={menu} className="mention-menu" style={position}>
              <div
                id={listId}
                role="listbox"
                aria-label="上游变量"
                className="max-h-40 overflow-y-auto"
              >
                {matches.map((reference, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={active === index}
                    id={`${listId}-${index}`}
                    key={reference.value}
                    className={`mention-option ${active === index ? 'active' : ''}`}
                    onPointerDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => insert(reference)}
                  >
                    <span>{reference.label}</span>
                    {active === index && <CornerDownLeft size={12} />}
                  </button>
                ))}
                {!matches.length && (
                  <p className="px-3 py-2 text-xs text-slate-400">
                    {references.length ? '没有匹配的变量' : '连接上游节点后，即可引用其输出'}
                  </p>
                )}
              </div>
            </div>,
            document.body,
          )}
      </div>
    </div>
  );
}
