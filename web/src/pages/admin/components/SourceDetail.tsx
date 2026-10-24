import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../../../data/api';
import type { DataSource } from '../../../data/types';
import { Button, HealthBadge, TextField } from '../../../ui';
import { StatusLine, useFlash } from './StatusLine';
import styles from './SourceDetail.module.css';

type Setting = DataSource['settings'][number];

/** Inline settings for one data source: editable fields, masked secrets, Save and Test connection. */
export function SourceDetail({
  source,
  onSaved,
  onClose,
}: {
  source: DataSource;
  onSaved: (updated: DataSource) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Setting[]>(source.settings);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const saveMsg = useFlash();
  const testMsg = useFlash();
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();

  useEffect(() => {
    setDraft(source.settings);
    testMsg.clear();
    panel.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id]);

  const changed = JSON.stringify(draft) !== JSON.stringify(source.settings);
  const setValue = (key: string, value: string) => setDraft((d) => d.map((f) => (f.key === key ? { ...f, value } : f)));

  const save = async () => {
    setSaving(true);
    const secrets = draft.filter((f) => f.secret);
    const keyAdded = source.health === 'off' && secrets.length > 0 && secrets.every((f) => f.value.trim());
    const patch: Partial<DataSource> = keyAdded
      ? { settings: draft, health: 'healthy', statusText: 'Healthy', action: 'Configure', updatedAt: new Date().toISOString() }
      : { settings: draft };
    const updated = await api.updateDataSource(source.id, patch);
    setSaving(false);
    onSaved(updated);
    saveMsg.show('Saved');
  };

  const test = async () => {
    setTesting(true);
    testMsg.show('Testing connection', 'accent', true);
    const result = await api.testDataSource(source.id, draft);
    setTesting(false);
    testMsg.show(result.message, result.ok ? 'ok' : 'bad', true);
  };

  return (
    <section
      ref={panel}
      tabIndex={-1}
      className={styles.panel}
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <header className={styles.head}>
        <div>
          <h3 id={titleId} className={styles.title}>Configure {source.name}</h3>
          <p className={styles.sub}>
            <HealthBadge health={source.health} text={source.statusText} />
          </p>
        </div>
        <Button variant="ghost" size="sm" icon={<X aria-hidden />} onClick={onClose} aria-label={`Close ${source.name} settings`}>
          Close
        </Button>
      </header>

      {draft.length === 0 ? (
        <p className={styles.none}>Nothing to set for this source. It works without any settings.</p>
      ) : (
        <form
          className={styles.fields}
          onSubmit={(e) => {
            e.preventDefault();
            if (changed) void save();
          }}
        >
          {draft.map((f) =>
            f.secret ? (
              <SecretField key={f.key} setting={f} saved={source.settings.find((s) => s.key === f.key)?.value ?? ''} onChange={(v) => setValue(f.key, v)} />
            ) : (
              <TextField key={f.key} label={f.label} value={f.value} onChange={(e) => setValue(f.key, e.target.value)} />
            ),
          )}
        </form>
      )}

      <div className={styles.actions}>
        {draft.length > 0 && (
          <Button variant="accent" onClick={save} disabled={!changed || saving}>
            {saving ? 'Saving' : 'Save'}
          </Button>
        )}
        <Button variant="secondary" onClick={test} disabled={testing}>
          Test connection
        </Button>
        <StatusLine flash={saveMsg.flash} />
      </div>
      <StatusLine flash={testMsg.flash} className={styles.result} />
    </section>
  );
}

/** A secret is never shown. You see whether one is set, and can replace it. */
function SecretField({ setting, saved, onChange }: { setting: Setting; saved: string; onChange: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const labelId = useId();

  if (editing) {
    return (
      <div className={styles.secretEdit}>
        <TextField
          label={setting.label}
          type="password"
          autoComplete="off"
          autoFocus
          value={setting.value === saved ? '' : setting.value}
          onChange={(e) => onChange(e.target.value)}
          hint="Stored on the server. It won't be shown again after you save."
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange(saved);
            setEditing(false);
          }}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.secret} role="group" aria-labelledby={labelId}>
      <span id={labelId} className={styles.secretLabel}>{setting.label}</span>
      <div className={styles.secretValue}>
        {saved ? (
          <span className={styles.mask}>
            <span aria-hidden>••••••••••••</span>
            <span className="visually-hidden">Set, hidden</span>
          </span>
        ) : (
          <span className={styles.unset}>Not set</span>
        )}
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          {saved ? 'Replace' : 'Add'}
        </Button>
      </div>
    </div>
  );
}
