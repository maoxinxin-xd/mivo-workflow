import { useEffect, useRef, useState } from 'react';
import type { FlowNodeEntity } from '@flowgram.ai/free-layout-editor';
import { Download, Play, Plus, X } from 'lucide-react';
import { MivoClient, getSession } from './api';
import { useStudio } from './context';
import { outputLabel, uniqueNodeTitle, upstreamNodes, type Bundle, type NodeData } from './model';
import { nodeInfo } from './editor';
import { downloadJSON } from './storage';
import { PromptInput } from './PromptInput';
import { useInspectorPosition } from './useInspectorPosition';
import { InputFields } from './InputFields';
import { FieldSelect } from './FieldSelect';
import { AssetView } from './AssetView';

export function BundleView({ bundle, outputName }: { bundle: Bundle; outputName?: string }) {
  return (
    <div className="bundle-view">
      {bundle.text && (
        <div>
          {outputName && <p className="muted">结果文本</p>}
          <pre>{bundle.text}</pre>
        </div>
      )}
      {bundle.assets.map((asset, index) => (
        <AssetView
          key={`${asset.fileId}-${index}`}
          asset={asset}
          label={outputName ? `${outputName} ${index + 1}` : undefined}
        />
      ))}
      {!bundle.text && !bundle.assets.length && <p className="muted">没有输出内容</p>}
    </div>
  );
}

export function Inspector({ node }: { node: FlowNodeEntity }) {
  const studio = useStudio();
  const position = useInspectorPosition(node.id);
  const [data, setData] = useState<NodeData>(() => node.form?.values ?? node.getExtInfo());
  useEffect(() => {
    const subscription = node.form?.onFormValuesChange(() => setData({ ...node.form!.values }));
    return () => subscription?.dispose();
  }, [node]);
  const [titleDraft, setTitleDraft] = useState(data.title);
  useEffect(() => setTitleDraft(data.title), [node.id, data.title]);
  const type = node.flowNodeType as keyof typeof nodeInfo;
  const info = nodeInfo[type] ?? nodeInfo.generate;
  const Icon = info.icon;
  const [uploading, setUploading] = useState(false);
  const uploadRef = useRef<AbortController>();
  const owner = getSession(studio.environment)?.owner;
  useEffect(() => {
    setUploading(false);
    return () => {
      uploadRef.current?.abort();
      uploadRef.current = undefined;
    };
  }, [node.id, studio.environment, owner]);
  const run = studio.snapshot?.nodes[node.id];
  const candidates = upstreamNodes(studio.workflow.nodes, node.id, studio.workflow.edges).filter(
    (item) => ['start', 'generate', 'condition'].includes(item.type),
  );
  const references = candidates.flatMap((item) =>
    (item.data.fields ?? [])
      .filter((field) => field.type === 'string')
      .map((field) => ({
        value: `${item.id}.fields.${field.name}`,
        label: `${item.data.title} · ${field.name}`,
      })),
  );
  const promptReferences = candidates.flatMap((item) => {
    const assets = studio.snapshot?.nodes[item.id]?.output?.assets ?? [];
    if (item.type === 'generate') {
      return [
        ...references.filter((reference) => reference.value.startsWith(`${item.id}.`)),
        ...Array.from({ length: Math.max(1, assets.length) }, (_, index) => ({
          value: `${item.id}.outputs.${index}`,
          label: `${item.data.title} · ${outputLabel(item.data)} ${index + 1}`,
        })),
      ];
    }
    const resources =
      item.type === 'start'
        ? (item.data.fields ?? [])
            .filter((field) => field.type !== 'string')
            .map((field) => ({
              value: `${item.id}.variables.${field.name.trim()}`,
              label: `${item.data.title} · ${field.name}`,
            }))
        : assets.map((asset) => ({
            value: `${item.id}.assets.${asset.fileId}`,
            label: `${item.data.title} · ${asset.name}`,
          }));
    return [
      ...references.filter((reference) => reference.value.startsWith(`${item.id}.`)),
      ...resources,
    ];
  });
  function update(patch: Partial<NodeData>) {
    const next = { ...data, ...patch };
    if (node.form) node.form.updateFormValues(next);
    else node.updateExtInfo(next, true);
    setData(next);
  }
  async function upload(file: File, index: number) {
    if (uploading || studio.running) return;
    const variable = data.fields?.[index];
    if (!variable || variable.type === 'string') return;
    const matches =
      variable.type === 'model3d'
        ? /\.(glb|gltf|fbx|obj|usdz|usd)$/i.test(file.name)
        : file.type.startsWith(variable.type + '/');
    if (!matches) {
      studio.notify('请选择与变量类型一致的文件');
      return;
    }
    const controller = new AbortController();
    uploadRef.current = controller;
    setUploading(true);
    try {
      const asset = await new MivoClient(studio.environment).upload(
        file,
        AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      );
      if (controller.signal.aborted) return;
      const current = (node.form?.values ?? node.getExtInfo()) as NodeData;
      update({
        fields: (current.fields ?? []).map((field, i) =>
          i === index ? { ...field, asset: { ...asset, mediaType: variable.type } } : field,
        ),
      });
    } catch (reason) {
      if (!controller.signal.aborted) {
        studio.notify(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (uploadRef.current === controller) {
        uploadRef.current = undefined;
        setUploading(false);
      }
    }
  }
  return (
    <aside className="inspector node-inspector" ref={position.ref} style={position.style}>
      <header className="panel-heading">
        <span className={`node-icon ${info.color}`}>
          <Icon size={16} />
        </span>
        <strong>{info.title}</strong>
        <button className="icon-button" title="关闭" onClick={() => studio.select(undefined)}>
          <X size={17} />
        </button>
      </header>
      <div className="inspector-scroll">
        <fieldset disabled={studio.running || uploading}>
          <label>
            节点名称
            <input
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={() => {
                const title = uniqueNodeTitle(
                  titleDraft.trim() || info.title,
                  studio.workflow.nodes
                    .filter((item) => item.id !== node.id)
                    .map((item) => item.data.title),
                );
                setTitleDraft(title);
                if (title !== data.title) update({ title });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
          {type === 'start' && (
            <InputFields
              fields={data.fields ?? []}
              onChange={(fields) => update({ fields })}
              uploading={uploading}
              onUpload={(file, index) => void upload(file, index)}
            />
          )}
          {type === 'generate' && (
            <>
              <div className="my-4 space-y-4">
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-xs font-medium">输出类型</legend>
                  <div className="grid grid-cols-4 gap-1.5">
                    {(
                      [
                        ['image', '图片'],
                        ['video', '视频'],
                        ['model3d', '模型'],
                        ['audio', '音频'],
                      ] as const
                    ).map(([value, label]) => (
                      <label key={value} className="choice-chip">
                        <input
                          type="radio"
                          name="output-type"
                          value={value}
                          checked={(data.outputType ?? 'image') === value}
                          onChange={() => update({ outputType: value })}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-xs font-medium">质量</legend>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(
                      [
                        ['fast', '快速'],
                        ['standard', '标准'],
                        ['high', '高质量'],
                      ] as const
                    ).map(([value, label]) => (
                      <label key={value} className="choice-chip">
                        <input
                          type="radio"
                          name="quality"
                          value={value}
                          checked={(data.quality ?? 'standard') === value}
                          onChange={() => update({ quality: value })}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
              <PromptInput
                disabled={studio.running || uploading}
                value={data.prompt ?? ''}
                labels={data.promptReferenceLabels}
                onChange={(prompt, labels) =>
                  update({
                    prompt,
                    ...(labels ? { promptReferenceLabels: labels } : {}),
                  })
                }
                references={promptReferences}
              />
              <label>
                补充要求
                <textarea
                  rows={2}
                  value={data.additionalRequirements ?? ''}
                  onChange={(e) => update({ additionalRequirements: e.target.value })}
                  placeholder="尺寸、风格、时长等"
                />
              </label>
            </>
          )}
          {type === 'condition' && (
            <section className="form-section">
              <p className="muted">
                满足条件时走「满足」出口，否则走「否则」出口。拖动出口圆点连接下游。
              </p>
              <FieldSelect
                label="判断来源"
                placeholder="选择上游字段或输出"
                value={data.condition?.source ?? ''}
                options={references}
                disabled={studio.running || uploading}
                onChange={(source) =>
                  update({
                    condition: {
                      source,
                      operator: data.condition?.operator ?? 'notEmpty',
                      value: data.condition?.value ?? '',
                    },
                  })
                }
              />
              <FieldSelect
                label="判断方式"
                placeholder="选择判断方式"
                value={data.condition?.operator ?? 'notEmpty'}
                options={[
                  { value: 'notEmpty', label: '不为空' },
                  { value: 'equals', label: '等于' },
                  { value: 'contains', label: '包含' },
                ]}
                disabled={studio.running || uploading}
                onChange={(operator) =>
                  update({
                    condition: {
                      source: data.condition?.source ?? '',
                      operator: operator as 'equals' | 'contains' | 'notEmpty',
                      value: data.condition?.value ?? '',
                    },
                  })
                }
              />
              {data.condition?.operator !== 'notEmpty' && (
                <label>
                  比较内容
                  <input
                    value={data.condition?.value ?? ''}
                    onChange={(e) =>
                      update({ condition: { ...data.condition!, value: e.target.value } })
                    }
                  />
                </label>
              )}
            </section>
          )}
          {type === 'end' && (
            <section className="form-section space-y-3">
              <div className="section-heading">
                <strong>最终产出</strong>
                {data.finalOutputs && (
                  <span className="text-xs text-slate-500">{data.finalOutputs.length} 项</span>
                )}
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="!w-auto accent-blue-600"
                  checked={data.finalOutputs === undefined}
                  onChange={(event) =>
                    update({
                      finalOutputs: event.target.checked
                        ? undefined
                        : [{ id: crypto.randomUUID(), name: '最终产出', source: '' }],
                    })
                  }
                />
                汇总连入节点的内容
              </label>
              {data.finalOutputs === undefined ? (
                <p className="muted">保留连入节点的文本与资源；自定义后只返回所选内容。</p>
              ) : (
                <>
                  {data.finalOutputs.map((output, index, outputs) => (
                    <div
                      className="min-w-0 space-y-3 rounded-xl border border-slate-200 p-3"
                      key={output.id}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-slate-500">产出 {index + 1}</span>
                        <button
                          className="icon-button"
                          title={`移除产出 ${index + 1}`}
                          onClick={() =>
                            update({
                              finalOutputs: outputs.filter((item) => item.id !== output.id),
                            })
                          }
                        >
                          <X size={13} />
                        </button>
                      </div>
                      <label>
                        产出名称
                        <input
                          value={output.name}
                          placeholder="例如：成片、封面、文案"
                          onChange={(event) =>
                            update({
                              finalOutputs: outputs.map((item) =>
                                item.id === output.id
                                  ? { ...item, name: event.target.value }
                                  : item,
                              ),
                            })
                          }
                        />
                      </label>
                      <FieldSelect
                        label="内容来源"
                        placeholder="选择上游产出"
                        value={output.source}
                        disabled={studio.running || uploading}
                        options={[
                          ...(output.source &&
                          !promptReferences.some((item) => item.value === output.source)
                            ? [
                                {
                                  value: output.source,
                                  label: '来源已失效，请重新选择',
                                  disabled: true,
                                },
                              ]
                            : []),
                          ...promptReferences,
                        ]}
                        onChange={(source) =>
                          update({
                            finalOutputs: outputs.map((item) =>
                              item.id === output.id ? { ...item, source } : item,
                            ),
                          })
                        }
                      />
                    </div>
                  ))}
                  {!data.finalOutputs.length && <p className="muted">至少配置 1 项最终产出。</p>}
                  {!promptReferences.length && (
                    <p className="muted">连接上游节点后，即可选择它的产出。</p>
                  )}
                  <button
                    className="text-button"
                    onClick={() =>
                      update({
                        finalOutputs: [
                          ...data.finalOutputs!,
                          { id: crypto.randomUUID(), name: '', source: '' },
                        ],
                      })
                    }
                  >
                    <Plus size={13} /> 添加产出
                  </button>
                </>
              )}
            </section>
          )}
          {type === 'generate' && (
            <section className="form-section space-y-3">
              <div className="section-heading">
                <strong>产出</strong>
                <span className="text-xs text-slate-500">{outputLabel(data)}</span>
              </div>
              <p className="muted">连接下游后，在提示词输入 @ 引用此产出。</p>
              {run?.output?.assets.length ? (
                <>
                  <BundleView bundle={run.output} outputName={outputLabel(data)} />
                  <p className="muted">
                    已产出 {run.output.assets.length} 个资源，下游按名称引用最新运行结果。
                  </p>
                </>
              ) : (
                <>
                  <div className="rounded-lg border border-dashed border-slate-200 p-3">
                    <span className="text-xs font-medium text-slate-600">
                      {outputLabel(data)} 1
                    </span>
                    <p className="muted">
                      {run?.status === 'success'
                        ? '本次运行未返回资源，可调整配置后重新运行。'
                        : '运行后显示预览，现在即可在下游引用。'}
                    </p>
                  </div>
                  {run?.output && <BundleView bundle={run.output} outputName={outputLabel(data)} />}
                </>
              )}
            </section>
          )}
        </fieldset>
        <section className="form-section node-run-section">
          <div className="section-heading">
            <strong>节点运行</strong>
            <button
              className="text-button"
              disabled={studio.running}
              onClick={() => studio.run(node.id)}
            >
              <Play size={13} />
              {run?.status === 'success' ? '重新运行此节点' : '单独运行'}
            </button>
          </div>
          {run?.stage && <p className="muted">{run.stage}</p>}
          {run?.abilityId && <p className="muted">能力：{run.abilityId}</p>}
          {run?.error && <p className="error-text">{run.error}</p>}
          {run?.input && (
            <details>
              <summary>输入</summary>
              <BundleView bundle={run.input} />
            </details>
          )}
          {run?.output ? (
            <>
              {type !== 'generate' && <BundleView bundle={run.output} />}
              <button
                className="text-button"
                onClick={() => {
                  downloadJSON(run.output, `${data.title}-结果.json`);
                }}
              >
                导出结果 JSON
              </button>
            </>
          ) : (
            <p className="muted">
              {type === 'generate'
                ? '运行后在这里查看进度和输入，产出见上方。'
                : '运行后在这里查看输入和输出。'}
            </p>
          )}
        </section>
      </div>
    </aside>
  );
}
