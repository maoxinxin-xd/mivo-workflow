import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { getSession, login, logout } from './api';
import { getLlmKey, setLlmKey } from './llm';
import { environments, type Environment } from './model';

export function SettingsDialog({
  environment,
  running,
  onEnvironmentChange,
  onClose,
}: {
  environment: Environment;
  running: boolean;
  onEnvironmentChange: (environment: Environment) => void;
  onClose: () => void;
}) {
  const [keys, setKeys] = useState<Record<Environment, string>>({
    local: '',
    test: '',
    production: '',
  });
  const [tapsvcKey, setTapsvcKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveStage, setSaveStage] = useState('验证中');
  const [mivoError, setMivoError] = useState('');
  const [tapsvcError, setTapsvcError] = useState('');
  const [, refresh] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const configured = !!getSession(environment);
  const tapsvcConfigured = !!getLlmKey();
  const disabled = running || saving;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('.settings-environment.is-active')?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!saving) onClose();
      }
      if (event.key !== 'Tab') return;
      const elements = panel.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled)',
      );
      if (!elements?.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keyboard, true);
    return () => document.removeEventListener('keydown', keyboard, true);
  }, [saving, onClose]);

  async function saveTapsvc(value = tapsvcKey) {
    if (disabled || !value.trim()) return;
    setSaving(true);
    setSaveStage('保存中');
    setTapsvcError('');
    try {
      await setLlmKey(value);
      setTapsvcKey('');
      refresh((current) => current + 1);
    } catch (error) {
      setTapsvcError(error instanceof Error ? error.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  async function clearTapsvc() {
    if (disabled) return;
    setSaving(true);
    setSaveStage('清除中');
    setTapsvcError('');
    try {
      await setLlmKey('');
      refresh((current) => current + 1);
    } catch (error) {
      setTapsvcError(error instanceof Error ? error.message : '清除失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  async function clearMivo() {
    if (disabled) return;
    setSaving(true);
    setMivoError('');
    try {
      await logout(environment);
      refresh((value) => value + 1);
    } catch (error) {
      setMivoError(error instanceof Error ? error.message : '清除失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  async function saveMivo() {
    if (disabled || !keys[environment].trim()) return;
    setSaving(true);
    setSaveStage('验证中');
    setMivoError('');
    try {
      await login(environment, keys[environment], () => setSaveStage('同步能力'));
      setKeys((current) => ({ ...current, [environment]: '' }));
    } catch (error) {
      setMivoError(error instanceof Error ? error.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        ref={panel}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-heading"
      >
        <header className="settings-header">
          <h2 id="settings-heading">设置</h2>
          <button className="icon-button" aria-label="关闭设置" disabled={saving} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <fieldset className="settings-field">
          <legend>API 环境</legend>
          <div className="settings-environments">
            {(Object.keys(environments) as Environment[]).map((value) => (
              <button
                key={value}
                type="button"
                className={`settings-environment ${value === environment ? 'is-active' : ''}`}
                aria-pressed={value === environment}
                disabled={disabled}
                onClick={() => {
                  onEnvironmentChange(value);
                  setMivoError('');
                }}
              >
                {environments[value].replace('环境', '')}
                {getSession(value) && <span className="settings-configured-dot" />}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="settings-field">
          <div className="settings-field-heading">
            <label htmlFor="settings-mivo-key">Mivo API Key</label>
            <span
              className={`settings-key-status ${configured ? 'is-configured' : ''}`}
              role="status"
            >
              {configured && <Check size={12} />}
              {configured ? '已配置' : '未配置'}
            </span>
          </div>
          <div className="settings-key-input">
            <input
              id="settings-mivo-key"
              type="password"
              autoComplete="off"
              value={keys[environment]}
              placeholder={configured ? '已配置，输入以替换' : '输入当前环境的 API Key'}
              disabled={disabled}
              onChange={(event) => {
                setKeys((current) => ({ ...current, [environment]: event.target.value }));
                setMivoError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveMivo();
              }}
            />
            {configured && (
              <button
                className="icon-button"
                aria-label="清除当前环境的 Mivo API Key"
                title="清除当前环境的 Key"
                disabled={disabled}
                onClick={() => void clearMivo()}
              >
                <X size={14} />
              </button>
            )}
            <button
              className="settings-save"
              disabled={disabled || !keys[environment].trim()}
              onClick={() => void saveMivo()}
            >
              {saving ? saveStage : '保存'}
            </button>
          </div>
          {mivoError && (
            <p className="settings-error" role="alert">
              {mivoError}
            </p>
          )}
        </div>
        <div className="settings-field">
          <div className="settings-field-heading">
            <label htmlFor="settings-tapsvc-key">Tapsvc API Key</label>
            <span
              className={`settings-key-status ${tapsvcConfigured ? 'is-configured' : ''}`}
              role="status"
            >
              {tapsvcConfigured && <Check size={12} />}
              {tapsvcConfigured ? '已配置' : '未配置'}
            </span>
          </div>
          <div className="settings-key-input">
            <input
              id="settings-tapsvc-key"
              type="password"
              autoComplete="off"
              value={tapsvcKey}
              placeholder={tapsvcConfigured ? '已配置，输入以替换' : '输入 Tapsvc API Key'}
              disabled={disabled}
              onChange={(event) => setTapsvcKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !disabled && tapsvcKey.trim()) {
                  void saveTapsvc();
                }
              }}
            />
            {tapsvcConfigured && (
              <button
                className="icon-button"
                aria-label="清除 Tapsvc API Key"
                title="清除 Tapsvc Key"
                disabled={disabled}
                onClick={() => void clearTapsvc()}
              >
                <X size={14} />
              </button>
            )}
            <button
              className="settings-save"
              disabled={disabled || !tapsvcKey.trim()}
              onClick={() => void saveTapsvc()}
            >
              保存
            </button>
          </div>
          {tapsvcError && (
            <p className="settings-error" role="alert">
              {tapsvcError}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
