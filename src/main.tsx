import { createRoot } from 'react-dom/client';
import { ConfigProvider } from '@douyinfe/semi-ui';
import zhCN from '@douyinfe/semi-ui/lib/es/locale/source/zh_CN';
import { App } from './App';
import { initializeStorage } from './storage';
import { initializeSettings } from './api';
import { runRequest } from './run-client';
import type { Environment } from './model';
import './style.css';

const root = createRoot(document.getElementById('root')!);
async function start() {
  root.render(<p style={{ padding: 24, color: '#475569' }}>正在连接本地工作流服务…</p>);
  try {
    await initializeSettings();
    await initializeStorage();
    const keys = Object.keys(localStorage).filter((key) => key.startsWith('mivo-flowgram:run:'));
    if (keys.length) {
      const snapshots = keys.flatMap((key) => {
        try {
          return [JSON.parse(localStorage.getItem(key)!)];
        } catch {
          return [];
        }
      });
      const { accepted } = await runRequest<{ accepted: string[] }>('/runs/migrate', { snapshots });
      for (const key of keys) {
        try {
          const saved = JSON.parse(localStorage.getItem(key)!);
          const id = ['legacy', saved.workflowId, saved.environment, saved.owner].join('-');
          if (accepted.includes(id)) localStorage.removeItem(key);
        } catch {
          /* Keep data that has not been confirmed by the database. */
        }
      }
    }
    const settings = await runRequest<{ environment: Environment }>('/settings');
    root.render(
      <ConfigProvider locale={zhCN}>
        <App initialEnvironment={settings.environment} />
      </ConfigProvider>,
    );
  } catch (error) {
    root.render(
      <div style={{ padding: 24, color: '#334155' }}>
        <p>{error instanceof Error ? error.message : '无法连接本地工作流服务'}</p>
        <button onClick={() => void start()}>重新连接</button>
      </div>,
    );
  }
}
void start();
