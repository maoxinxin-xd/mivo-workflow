import type { Asset } from './model';

type ObjectValue = Record<string, any>;
export interface Capability extends ObjectValue {
  id: string;
  execution: string;
  request: {
    bodyTemplate: ObjectValue;
    parameters: Record<string, ObjectValue>;
    resources?: ObjectValue[];
    variants?: Record<string, ObjectValue>;
    rules?: ObjectValue[];
    context?: { chatSession?: ObjectValue };
  };
}

const object = (value: any): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const nonempty = (value: any) =>
  value !== undefined &&
  value !== null &&
  value !== false &&
  (typeof value !== 'string' || value.trim().length > 0) &&
  (!Array.isArray(value) || value.length > 0);
const fail = (message: string): never => {
  throw new Error(`能力协议校验失败：${message}`);
};
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function safe(value: any): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (forbidden.has(key)) fail('包含不安全的字段');
    safe(item);
  }
}
function tokens(pointer: string): string[] {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) fail('无效的 JSON Pointer');
  const parts = pointer
    .slice(1)
    .split('/')
    .map((v) => v.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts.some((part) => !part || forbidden.has(part))) fail('不安全的 JSON Pointer');
  return parts;
}
function get(body: any, pointer: string): any {
  return tokens(pointer).reduce(
    (current, key) => (current && Object.hasOwn(current, key) ? current[key] : undefined),
    body,
  );
}
function put(body: ObjectValue, pointer: string, value: any, remove = false): void {
  const parts = tokens(pointer);
  const key = parts.pop()!;
  let parent: any = body;
  for (const part of parts) {
    if (!object(parent[part]) && !Array.isArray(parent[part])) {
      if (remove) return;
      parent[part] = {};
    }
    parent = parent[part];
  }
  if (remove) delete parent[key];
  else parent[key] = structuredClone(value);
}
function merge(body: ObjectValue, patch: ObjectValue): void {
  for (const [key, value] of Object.entries(patch)) {
    if (object(value)) {
      if (!object(body[key])) body[key] = {};
      merge(body[key], value);
    } else body[key] = structuredClone(value);
  }
}
function validate(value: any, spec: ObjectValue, path: string): void {
  if (value === undefined || value === null) {
    if (spec.required === true) fail(`${path} 为必填参数`);
    return;
  }
  const type = spec.type;
  const arrayType = typeof type === 'string' && type.endsWith('[]');
  if (arrayType || type === 'array') {
    if (!Array.isArray(value)) fail(`${path} 必须是数组`);
    const itemSpec = spec.items || (arrayType ? { type: type.slice(0, -2) } : {});
    value.forEach((item: any, i: number) => validate(item, itemSpec, `${path}/${i}`));
    if (typeof spec.minItems === 'number' && value.length < spec.minItems) {
      fail(`${path} 至少需要 ${spec.minItems} 项`);
    }
    if (typeof spec.maxItems === 'number' && value.length > spec.maxItems) {
      fail(`${path} 最多允许 ${spec.maxItems} 项`);
    }
  } else if (type === 'integer') {
    if (!Number.isInteger(value)) fail(`${path} 必须是整数`);
  } else if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} 必须是有限数值`);
  } else if (type === 'object') {
    if (!object(value)) fail(`${path} 必须是对象`);
    for (const [key, child] of Object.entries(spec.properties || {})) {
      validate(
        value[key],
        {
          ...(child as ObjectValue),
          required: Array.isArray(spec.required) && spec.required.includes(key),
        },
        `${path}/${key}`,
      );
    }
  } else if (['string', 'boolean'].includes(type) && typeof value !== type) {
    fail(`${path} 类型应为 ${type}`);
  }
  if (Array.isArray(spec.enum) && !spec.enum.some((item: any) => equal(item, value))) {
    fail(`${path} 不在允许值中`);
  }
  if (typeof value === 'number') {
    if (typeof spec.minimum === 'number' && value < spec.minimum) fail(`${path} 小于最小值`);
    if (typeof spec.maximum === 'number' && value > spec.maximum) fail(`${path} 大于最大值`);
  }
  if (typeof value === 'string') {
    if (spec.required && !value.trim()) fail(`${path} 不能为空`);
    if (typeof spec.minLength === 'number' && value.length < spec.minLength) {
      fail(`${path} 内容过短`);
    }
    if (typeof spec.maxLength === 'number' && value.length > spec.maxLength) {
      fail(`${path} 内容过长`);
    }
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) fail(`${path} 格式不匹配`);
  }
}
function kind(asset: Asset): string {
  const declared = asset.mediaType?.toLowerCase() || '';
  if (['image', 'video', 'audio', 'model3d'].includes(declared)) return declared;
  for (const type of ['image', 'video', 'audio']) if (declared.startsWith(`${type}/`)) return type;
  const extension = asset.name.split('.').pop()?.toLowerCase() || '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'].includes(extension))
    return 'image';
  if (['mp4', 'webm', 'mov', 'mkv'].includes(extension)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(extension)) return 'audio';
  if (['glb', 'gltf', 'obj', 'fbx', 'stl', 'usdz', 'blend'].includes(extension)) return 'model3d';
  return '';
}
function groups(rule: ObjectValue): string[][] {
  if (!Array.isArray(rule.mutuallyExclusive)) return [];
  return rule.mutuallyExclusive.every((item: any) => typeof item === 'string')
    ? rule.mutuallyExclusive.map((item: string) => [item])
    : rule.mutuallyExclusive.filter(Array.isArray);
}

/** Assemble only message.create; host must create the returned session before POST /message. */
export function assembleGeneration(
  capability: Capability,
  plan: any,
  assets: Asset[],
): { body: ObjectValue; chatSessionType?: string; chatSessionPointer?: string } {
  if (capability.execution !== 'message.create') fail('只支持 message.create 生成能力');
  safe(capability.request);
  safe(plan);
  const forbidFileIds = (value: any): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (/file_?ids?$/i.test(key) && nonempty(item)) fail('文件 ID 只能通过资源槽位绑定');
      forbidFileIds(item);
    }
  };
  forbidFileIds(plan.bodyPatch ?? plan.body);
  if (!object(plan)) fail('模型计划必须是对象');
  const request = capability.request;
  const parameters = request.parameters || {};
  const template = request.bodyTemplate;
  if (!object(template)) fail('缺少 bodyTemplate');
  const body = structuredClone(template);
  const resources = request.resources || [];
  const context = request.context?.chatSession;
  if (!context || context.strategy !== 'createOrReuse' || !context.type) {
    fail('生成能力必须声明 createOrReuse 会话策略');
  }
  const sessionPointer = context.target || '/chatSessionId';
  const protectedPaths = [sessionPointer, ...resources.map((item) => item.target)];
  protectedPaths.forEach((path) => put(body, path, undefined, true));
  const patch = plan.bodyPatch ?? plan.body ?? {};
  if (!object(patch)) fail('bodyPatch 必须是对象');
  const patchLeaves = (value: ObjectValue, prefix = '') => {
    for (const [key, item] of Object.entries(value)) {
      const path = `${prefix}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (protectedPaths.some((target) => path === target || path.startsWith(`${target}/`))) {
        if (nonempty(item)) fail(`${path} 只能由宿主绑定`);
        continue;
      }
      if (parameters[path]) {
        for (const target of protectedPaths) {
          if (target.startsWith(`${path}/`) && nonempty(get(item, target.slice(path.length)))) {
            fail(`${target} 只能由宿主绑定`);
          }
        }
        if (parameters[path].source === 'host') {
          if (nonempty(item)) fail(`${path} 只能由宿主填写`);
          continue;
        }
        put(body, path, item);
      } else if (object(item)) patchLeaves(item, path);
      else if (!equal(get(template, path), item)) fail(`${path} 未声明为可修改参数`);
    }
  };
  patchLeaves(patch);
  const variantName = plan.variant || '';
  const variant = variantName ? request.variants?.[variantName] : undefined;
  if (variantName && !variant) fail(`未声明的 variant：${variantName}`);
  const rules = request.rules || [];
  if (variant) {
    for (const path of variant.deny || []) {
      const value = get(body, path);
      if (nonempty(value) && !equal(value, get(template, path))) fail(`该版本不支持 ${path}`);
      put(body, path, undefined, true);
    }
    for (const rule of rules) {
      const options = groups(rule);
      const selected = options.filter((group) =>
        group.some((path) => nonempty(get(variant.bodyPatch, path))),
      );
      if (selected.length !== 1) continue;
      for (const group of options.filter((item) => item !== selected[0])) {
        for (const path of group) {
          if (equal(get(body, path), get(template, path))) put(body, path, undefined, true);
        }
      }
    }
    merge(body, variant.bodyPatch || {});
  }
  // Clear host-only slots after the variant as well: model output never supplies real file IDs.
  protectedPaths.forEach((path) => put(body, path, undefined, true));
  let bindings = plan.references ?? [];
  if (!Array.isArray(bindings)) fail('references 必须是数组');
  if (assets.length && !bindings.length && resources.length === 1) {
    bindings = [{ target: resources[0].target }];
  }
  const used = new Set<number>();
  const targets = new Set<string>();
  for (const binding of bindings) {
    if (!object(binding)) fail('references 每项必须是对象');
    const resource = resources.find((item) => item.target === binding.target);
    if (!resource) fail(`未声明的资源槽位：${binding.target}`);
    if (targets.has(resource.target)) fail(`重复资源槽位：${resource.target}`);
    targets.add(resource.target);
    const mode = resource.mode || 'array';
    if (binding.mode && binding.mode !== mode) fail(`${resource.target} 引用模式不匹配`);
    const indexes =
      binding.attachmentIndexes ?? (bindings.length === 1 ? assets.map((_, i) => i) : undefined);
    if (!Array.isArray(indexes) || !indexes.length) fail('资源绑定必须指定有效索引');
    const selected: Asset[] = indexes.map((index: any) => {
      if (!Number.isInteger(index) || index < 0 || index >= assets.length) fail('资源索引越界');
      used.add(index);
      return assets[index];
    });
    const accepts = Array.isArray(resource.accepts) ? resource.accepts : [resource.accepts];
    for (const asset of selected) {
      if (!asset.fileId || !accepts.includes(kind(asset))) fail('引用资源缺少 fileId 或类型不匹配');
    }
    const ids = [...new Set(selected.map((asset) => asset.fileId))];
    if (mode === 'scalar' && ids.length !== 1) fail('scalar 槽位必须恰好引用一个资源');
    put(body, resource.target, mode === 'scalar' ? ids[0] : ids);
  }
  if (used.size !== assets.length) fail('部分上游资源没有绑定到能力的资源槽位');
  const version = get(body, '/modelFormat/version');
  const scoped = (spec: ObjectValue) => {
    const result = { ...spec };
    for (const key of ['enum', 'maxItems', 'maximum', 'minimum']) {
      if (Object.hasOwn(spec[`${key}ByVersion`] || {}, version)) {
        result[key] = spec[`${key}ByVersion`][version];
      }
    }
    return result;
  };
  for (const resource of resources) {
    const spec = scoped(resource);
    const value = get(body, resource.target);
    const count = Array.isArray(value) ? value.length : nonempty(value) ? 1 : 0;
    if (count < (spec.minItems || 0)) fail(`${resource.target} 缺少必需资源`);
    if (typeof spec.maxItems === 'number' && count > spec.maxItems) fail('引用资源数量超限');
    if (count && spec.enabledForVersions && !spec.enabledForVersions.includes(version)) {
      fail(`${resource.target} 在所选版本不可用`);
    }
  }
  for (const rule of rules) {
    if (
      rule.if &&
      !Object.entries(rule.if).every(([path, value]) =>
        Array.isArray(value)
          ? value.some((candidate) => equal(get(body, path), candidate))
          : equal(get(body, path), value),
      )
    ) {
      continue;
    }
    for (const [path, value] of Object.entries(rule.set || {})) {
      if (
        protectedPaths.some(
          (target) =>
            path === target || path.startsWith(`${target}/`) || target.startsWith(`${path}/`),
        )
      )
        fail('规则不可覆写宿主资源或会话');
      put(body, path, value);
    }
    for (const [path, minimum] of Object.entries(rule.minimum || {})) {
      const value = get(body, path);
      if (typeof value === 'number' && value < Number(minimum)) {
        fail(rule.message || `${path} 小于当前配置的最小值`);
      }
    }
    for (const [path, maximum] of Object.entries(rule.maximum || {})) {
      const value = get(body, path);
      if (typeof value === 'number' && value > Number(maximum)) {
        fail(rule.message || `${path} 大于当前配置的最大值`);
      }
    }
    const active = groups(rule).filter((group) => group.some((path) => nonempty(get(body, path))));
    if (active.length > 1) fail(rule.message || '请求字段互斥');
    if (rule.requireNonEmpty && !nonempty(get(body, rule.requireNonEmpty))) {
      fail(rule.message || `缺少 ${rule.requireNonEmpty}`);
    }
    for (const [path, maximum] of Object.entries(rule.maxItems || {})) {
      const value = get(body, path);
      const count = Array.isArray(value) ? value.length : nonempty(value) ? 1 : 0;
      if (count > Number(maximum)) fail(rule.message || `${path} 数量超限`);
    }
    if (
      rule.ifNonEmpty &&
      nonempty(get(body, rule.ifNonEmpty)) &&
      !(rule.requireAnyNonEmpty || []).some((path: string) => nonempty(get(body, path)))
    ) {
      fail(rule.message || '引用组合缺少必需字段');
    }
  }
  for (const [path, rawSpec] of Object.entries(parameters)) {
    if (path === sessionPointer || rawSpec.source === 'host') continue;
    if (variant?.deny?.includes(path) && get(body, path) === undefined) continue;
    const spec = scoped(rawSpec);
    const value = get(body, path);
    if (nonempty(value) && spec.enabledForVersions && !spec.enabledForVersions.includes(version)) {
      fail(`${path} 在所选版本不可用`);
    }
    validate(value, spec, path);
  }
  return { body, chatSessionType: context.type, chatSessionPointer: sessionPointer };
}
