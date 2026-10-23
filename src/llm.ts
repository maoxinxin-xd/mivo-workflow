import { getHost } from './host';
import { localRequest } from './local-client';
export const LLM_BASE_URL = 'https://llm-proxy.tapsvc.com/v1';
let configured = false;
export function updateLlmStatus(value: boolean) {
  configured = value;
}
export function getLlmKey(): string {
  return (getHost()?.llmConfigured() ?? configured) ? 'configured' : '';
}
export async function setLlmKey(apiKey: string) {
  const settings = await localRequest('/settings/llm', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: apiKey.trim() }),
  });
  configured = settings.llmConfigured;
}
export async function llmRequest(
  path: 'decisions' | 'chat/completions',
  body: unknown,
  signal: AbortSignal,
): Promise<any> {
  const host = getHost();
  if (host) return host.llmRequest(path, body, signal);
  if (!configured) throw new Error('请先在设置中配置 Tapsvc API Key');
  const response = await fetch('/llm/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? '模型请求失败');
  return value;
}
