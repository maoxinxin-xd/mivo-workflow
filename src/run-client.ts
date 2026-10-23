import type { RunSnapshot, Workflow, Environment } from './model';
export interface RunRecord {
  id: string;
  workflowId: string;
  workflow: Workflow;
  snapshot: RunSnapshot;
  createdAt: number;
  updatedAt: number;
  error?: string;
}
export async function runRequest<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch('/local-api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error ?? '本地执行服务请求失败'), value);
  return value;
}
export function listRuns(workflowId: string, environment: Environment, signal?: AbortSignal) {
  const query = new URLSearchParams({ workflowId, environment });
  return runRequest<RunRecord[]>('/runs?' + query, undefined, signal);
}
