import { useId, useLayoutEffect, useRef, useState, useEffect } from 'react';
import { Plus, Trash2, Type, Image, Video, AudioLines, Box, Upload } from 'lucide-react';
import { variableTypes, type NodeData, type VariableType } from './model';

type Fields = NonNullable<NodeData['fields']>;

export function InputFields({
  fields,
  onChange,
  onUpload,
  uploading,
}: {
  fields: Fields;
  onChange: (fields: Fields) => void;
  onUpload: (file: File, index: number) => void;
  uploading: boolean;
}) {
  const id = useId();
  const [showTypes, setShowTypes] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const icons = { string: Type, image: Image, video: Video, audio: AudioLines, model3d: Box };
  const accepts = {
    string: '',
    image: 'image/*',
    video: 'video/*',
    audio: 'audio/*',
    model3d: '.glb,.gltf,.fbx,.obj,.usdz,.usd',
  };
  useEffect(() => {
    if (!showTypes) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setShowTypes(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setShowTypes(false);
      addButton.current?.focus();
    };
    document.addEventListener('pointerdown', close);
    menuRef.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    menuRef.current?.addEventListener('keydown', escape);
    const menu = menuRef.current;
    return () => {
      document.removeEventListener('pointerdown', close);
      menu?.removeEventListener('keydown', escape);
    };
  }, [showTypes]);
  function addVariable(type: VariableType) {
    const prefix = variableTypes.find((item) => item.value === type)!.prefix;
    const numbers = fields
      .map((field) => (field.name.startsWith(prefix) ? Number(field.name.slice(prefix.length)) : 0))
      .filter((number) => Number.isSafeInteger(number) && number > 0);
    const name = prefix + (Math.max(0, ...numbers) + 1);
    pendingFocus.current = fields.length;
    onChange([...fields, { name, value: '', type }]);
    setShowTypes(false);
  }
  const names = useRef<Array<HTMLInputElement | null>>([]);
  const contents = useRef<Array<HTMLTextAreaElement | null>>([]);
  const addButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<number>();

  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index === undefined) return;
    pendingFocus.current = undefined;
    if (index < 0) addButton.current?.focus();
    else {
      names.current[index]?.focus();
      names.current[index]?.select();
    }
  }, [fields.length]);

  function remove(index: number) {
    const next = fields.filter((_, i) => i !== index);
    pendingFocus.current = Math.min(index, next.length - 1);
    onChange(next);
  }

  return (
    <section className="form-section input-fields">
      <div className="section-heading">
        <strong>自定义变量</strong>
        <div className="variable-add-menu" ref={menuRef}>
          <button
            className="input-field-add"
            type="button"
            ref={addButton}
            aria-haspopup="menu"
            aria-expanded={showTypes}
            disabled={uploading}
            onClick={() => setShowTypes((open) => !open)}
          >
            <Plus size={16} />
            添加变量
          </button>
          {showTypes && (
            <div className="variable-type-menu" role="menu" aria-label="选择变量类型">
              {variableTypes.map((type) => {
                const Icon = icons[type.value];
                return (
                  <button
                    key={type.value}
                    type="button"
                    role="menuitem"
                    disabled={uploading}
                    onClick={() => addVariable(type.value)}
                  >
                    <Icon size={16} />
                    {type.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {!fields.length && <p className="input-fields-empty">暂无变量，点击“添加变量”开始。</p>}
      <div className="input-fields-list">
        {fields.map((field, index) => {
          const Icon = icons[field.type];
          const typeLabel = variableTypes.find((item) => item.value === field.type)?.label;
          return (
            <div className="input-field-card" key={index}>
              <div className="input-field-header">
                <label htmlFor={`${id}-name-${index}`}>变量名称</label>
                <div className="variable-name-input">
                  <span
                    className="variable-name-icon"
                    title={typeLabel}
                    role="img"
                    aria-label={typeLabel}
                  >
                    <Icon size={16} aria-hidden="true" />
                  </span>
                  <input
                    id={`${id}-name-${index}`}
                    ref={(element) => {
                      names.current[index] = element;
                    }}
                    aria-label={`变量 ${index + 1} 变量名称`}
                    placeholder="如：主题"
                    value={field.name}
                    onChange={(event) =>
                      onChange(
                        fields.map((item, i) =>
                          i === index ? { ...item, name: event.target.value } : item,
                        ),
                      )
                    }
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      requestAnimationFrame(() => contents.current[index]?.focus());
                    }}
                  />
                </div>
                <button
                  className="input-field-remove"
                  type="button"
                  title="删除变量"
                  aria-label={`删除变量 ${index + 1}`}
                  onClick={() => remove(index)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="input-field-body">
                <label htmlFor={`${id}-value-${index}`}>变量内容</label>
                {field.type === 'string' ? (
                  <textarea
                    id={`${id}-value-${index}`}
                    aria-label={`变量 ${index + 1} 变量内容`}
                    ref={(element) => {
                      contents.current[index] = element;
                    }}
                    placeholder="输入变量内容…"
                    rows={2}
                    value={field.value}
                    onChange={(event) =>
                      onChange(
                        fields.map((item, i) =>
                          i === index ? { ...item, value: event.target.value } : item,
                        ),
                      )
                    }
                  />
                ) : (
                  <div className="variable-file-content">
                    {field.asset && <span title={field.asset.name}>{field.asset.name}</span>}
                    <label className="variable-upload">
                      <Upload size={14} />
                      {uploading ? '上传中…' : field.asset ? '替换文件' : '上传文件'}
                      <input
                        id={`${id}-value-${index}`}
                        aria-label={`上传变量 ${index + 1} 内容`}
                        type="file"
                        accept={accepts[field.type]}
                        hidden
                        disabled={uploading}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) onUpload(file, index);
                          event.target.value = '';
                        }}
                      />
                    </label>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
