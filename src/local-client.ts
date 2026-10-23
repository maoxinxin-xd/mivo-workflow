export async function localRequest<T = any>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/local-api' + path, { cache: 'no-store', ...init });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(value.error ?? '本地服务请求失败'), {
      status: response.status,
      ...value,
    });
  return value;
}
