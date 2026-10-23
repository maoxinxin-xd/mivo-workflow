import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createWorkflow, type RunSnapshot, type Workflow } from '../src/model';
import { validateWorkflow, workflowContent, type WorkflowDraft } from '../src/workflow-validation';

export interface Library {
  activeId: string;
  workflows: Workflow[];
  drafts: Record<string, WorkflowDraft[]>;
  selectedDraftId?: string;
}
export interface StoredRun {
  id: string;
  workflowId: string;
  workflow: Workflow;
  inputs: Record<string, unknown>;
  snapshot: RunSnapshot;
  createdAt: number;
  updatedAt: number;
  error?: string;
}
export const dataDirectory =
  process.env.MIVO_WORKFLOW_DATA_DIR ?? join(homedir(), '.mivo-workflow');
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
chmodSync(dataDirectory, 0o700);
const keyPath = join(dataDirectory, 'secret.key');
if (!existsSync(keyPath)) {
  writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
}
chmodSync(keyPath, 0o600);
const secretKey = readFileSync(keyPath);
const dbPath = join(dataDirectory, 'workflow.sqlite');
const db = new DatabaseSync(dbPath);
chmodSync(dbPath, 0o600);
db.exec(
  [
    'PRAGMA journal_mode = WAL',
    'PRAGMA foreign_keys = ON',
    'PRAGMA busy_timeout = 5000',
    'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS workflows ' +
      '(id TEXT PRIMARY KEY, document TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS drafts ' +
      '(workflow_id TEXT PRIMARY KEY REFERENCES workflows(id), document TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, ' +
      'environment TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL, ' +
      'document TEXT NOT NULL, ' +
      'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS runs_lookup ' +
      'ON runs(workflow_id, environment, owner, created_at DESC)',
    'CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(workflow_id, environment, owner) ' +
      "WHERE status = 'running'",
    'CREATE TABLE IF NOT EXISTS capability_catalogs ' +
      '(scope TEXT PRIMARY KEY, document TEXT NOT NULL, synced_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS cache ' +
      '(key TEXT PRIMARY KEY, document TEXT NOT NULL, expires_at INTEGER NOT NULL)',
  ].join(';'),
);

export function transaction<T>(action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function setting<T>(key: string): T | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(String(row.value)) : undefined;
}
export function setSetting(key: string, value: unknown) {
  db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, JSON.stringify(value));
}
export function secret<T>(key: string): T | undefined {
  const row = db.prepare('SELECT value FROM secrets WHERE key = ?').get(key);
  if (!row) return;
  const [iv, tag, encrypted] = String(row.value).split('.');
  const decipher = createDecipheriv('aes-256-gcm', secretKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString(),
  );
}
export function setSecret(key: string, value?: unknown) {
  if (value === undefined) {
    db.prepare('DELETE FROM secrets WHERE key = ?').run(key);
    return;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  const encoded = [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64'));
  db.prepare('INSERT OR REPLACE INTO secrets VALUES (?, ?)').run(key, encoded.join('.'));
}
export function library(): Library {
  const workflows = db
    .prepare('SELECT document FROM workflows ORDER BY updated_at DESC')
    .all()
    .map((row) => JSON.parse(String(row.document)) as Workflow);
  const drafts = Object.fromEntries(
    db
      .prepare('SELECT workflow_id, document FROM drafts')
      .all()
      .map((row) => [String(row.workflow_id), JSON.parse(String(row.document))]),
  );
  const activeId = setting<string>('activeId');
  return {
    activeId: workflows.some((item) => item.id === activeId) ? activeId! : (workflows[0]?.id ?? ''),
    workflows,
    drafts,
    selectedDraftId: setting<string>('selectedDraftId'),
  };
}
function storeWorkflow(workflow: Workflow, history: WorkflowDraft[]) {
  db.prepare(
    'INSERT INTO workflows VALUES (?, ?, ?) ON CONFLICT(id) ' +
      'DO UPDATE SET document=excluded.document, updated_at=excluded.updated_at',
  ).run(workflow.id, JSON.stringify(workflow), Date.now());
  db.prepare('INSERT OR REPLACE INTO drafts VALUES (?, ?)').run(
    workflow.id,
    JSON.stringify(history.slice(0, 30)),
  );
}
export function saveWorkflow(value: unknown, preserveDraft = false): Library {
  const workflow = validateWorkflow(value);
  return transaction(() => {
    const previous = library();
    const history = [...(previous.drafts[workflow.id] ?? [])];
    const latest = history[0];
    if (!latest || workflowContent(latest.workflow) !== workflowContent(workflow)) {
      const draft = {
        id: crypto.randomUUID(),
        savedAt: Date.now(),
        protected: preserveDraft,
        workflow,
      };
      if (
        !preserveDraft &&
        !latest?.protected &&
        history.length > 1 &&
        latest.savedAt &&
        Date.now() - latest.savedAt < 30_000
      )
        history[0] = draft;
      else history.unshift(draft);
    }
    if (preserveDraft && history[0]) history[0] = { ...history[0], protected: true };
    storeWorkflow(workflow, history);
    setSetting('activeId', workflow.id);
    setSetting('selectedDraftId', history[0]?.id ?? null);
    return library();
  });
}
export function ensureLibrary() {
  if (!library().workflows.length) saveWorkflow(createWorkflow());
}
export function migrateLibrary(value: Library) {
  if (!value || !Array.isArray(value.workflows)) throw new Error('工作流迁移数据无效');
  return transaction(() => {
    const existing = library();
    for (const raw of value.workflows) {
      let workflow: Workflow;
      try {
        workflow = validateWorkflow(raw);
      } catch {
        continue;
      }

      const history = (value.drafts?.[workflow.id] ?? []).flatMap((draft) => {
        try {
          if (typeof draft.id !== 'string' || draft.workflow.id !== workflow.id) return [];
          return [{ ...draft, workflow: validateWorkflow(draft.workflow) }];
        } catch {
          return [];
        }
      });
      const storedWorkflow = existing.workflows.find((item) => item.id === workflow.id);
      if (storedWorkflow && workflowContent(storedWorkflow) !== workflowContent(workflow)) {
        history.push({
          id: crypto.randomUUID(),
          savedAt: Date.now(),
          protected: true,
          workflow: storedWorkflow,
        });
      }
      for (const draft of existing.drafts[workflow.id] ?? []) {
        if (!history.some((item) => item.id === draft.id)) history.push(draft);
      }
      storeWorkflow(
        workflow,
        history.length
          ? history
          : [
              {
                id: crypto.randomUUID(),
                savedAt: Date.now(),
                workflow,
              },
            ],
      );
    }
    if (
      value.workflows.some((item) => item.id === value.activeId) &&
      library().workflows.some((item) => item.id === value.activeId)
    ) {
      setSetting('activeId', value.activeId);
      setSetting('selectedDraftId', value.selectedDraftId ?? null);
    }
    return library();
  });
}
export function selectDraft(workflowId: string, draftId: string) {
  return transaction(() => {
    const history = library().drafts[workflowId];
    if (!history?.some((item) => item.id === draftId)) throw new Error('草稿已更新，请重新选择');
    db.prepare('UPDATE drafts SET document = ? WHERE workflow_id = ?').run(
      JSON.stringify(
        history.map((item, index) =>
          index === 0 || item.id === draftId ? { ...item, protected: true } : item,
        ),
      ),
      workflowId,
    );
    setSetting('activeId', workflowId);
    setSetting('selectedDraftId', draftId);
    return library();
  });
}
export function getWorkflow(id: string): Workflow {
  const row = db.prepare('SELECT document FROM workflows WHERE id = ?').get(id);
  if (!row) throw Object.assign(new Error('工作流不存在'), { status: 404 });
  return JSON.parse(String(row.document));
}
export function putRun(run: StoredRun) {
  db.prepare(
    'INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET status=excluded.status, ' +
      'document=excluded.document, updated_at=excluded.updated_at',
  ).run(
    run.id,
    run.workflowId,
    run.snapshot.environment,
    run.snapshot.owner,
    run.snapshot.status,
    JSON.stringify(run),
    run.createdAt,
    run.updatedAt,
  );
}
export function getRun(id: string): StoredRun | undefined {
  const row = db.prepare('SELECT document FROM runs WHERE id = ?').get(id);
  return row ? JSON.parse(String(row.document)) : undefined;
}
export function listRuns(workflowId?: string, environment?: string, owner?: string): StoredRun[] {
  return db
    .prepare(
      'SELECT document FROM runs ' +
        'WHERE (? IS NULL OR workflow_id = ?) AND (? IS NULL OR environment = ?) ' +
        'AND (? IS NULL OR owner = ?) ORDER BY created_at DESC LIMIT 100',
    )
    .all(
      workflowId ?? null,
      workflowId ?? null,
      environment ?? null,
      environment ?? null,
      owner ?? null,
      owner ?? null,
    )
    .map((row) => JSON.parse(String(row.document)));
}
export function interruptedRuns(): StoredRun[] {
  return db
    .prepare("SELECT document FROM runs WHERE status = 'running'")
    .all()
    .map((row) => JSON.parse(String(row.document)));
}
export function readCatalog(scope: string) {
  const row = db.prepare('SELECT document FROM capability_catalogs WHERE scope = ?').get(scope);
  return row ? JSON.parse(String(row.document)) : undefined;
}
export function writeCatalog(scope: string, catalog: { syncedAt: number }) {
  db.prepare('INSERT OR REPLACE INTO capability_catalogs VALUES (?, ?, ?)').run(
    scope,
    JSON.stringify(catalog),
    catalog.syncedAt,
  );
}
export function readCache(key: string) {
  const row = db
    .prepare('SELECT document FROM cache WHERE key = ? AND expires_at > ?')
    .get(key, Date.now());
  return row ? JSON.parse(String(row.document)) : undefined;
}
export function writeCache(key: string, value: unknown, expiresAt: number) {
  db.prepare('DELETE FROM cache WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT OR REPLACE INTO cache VALUES (?, ?, ?)').run(
    key,
    JSON.stringify(value),
    expiresAt,
  );
}
