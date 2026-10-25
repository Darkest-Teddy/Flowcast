import { useEffect, useMemo, useState } from 'react';
import { api, useResource } from '../data/api';
import {
  CATEGORY_ORDER, CATEGORY_LABEL, DEFAULT_APPEARANCE, PART_CATALOG, resolveLayers, statusText,
  type Persona, type PersonaAppearance, type PartCategory,
} from '../lib/personaShared';
import { PersonaViewport, PartThumbnail } from './persona/PersonaCanvas';
import { Button, Loading, SelectField, TextArea, TextField } from '../ui';
import styles from './Join.module.css';

type Draft = Omit<Persona, 'id' | 'createdAt'>;
const DEFAULT_DRAFT: Draft = { name: '', bio: '', appearance: DEFAULT_APPEARANCE, homeLocationId: '' };

function CategoryTabs({ active, disabled, onChange }: { active: PartCategory; disabled: boolean; onChange: (c: PartCategory) => void }) {
  return (
    <div className={styles.tabs} role="tablist" aria-label="Customization category">
      {CATEGORY_ORDER.map((c) => {
        const isCostumeTab = c === 'costume';
        const isDisabled = disabled && !isCostumeTab;
        return (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={active === c}
            aria-disabled={isDisabled}
            disabled={isDisabled}
            className={active === c ? styles.tabOn : styles.tab}
            onClick={() => onChange(c)}
          >
            {CATEGORY_LABEL[c]}
          </button>
        );
      })}
    </div>
  );
}

function OptionGrid({ category, appearance, onPick }: { category: PartCategory; appearance: PersonaAppearance; onPick: (optionId: string) => void }) {
  const options = PART_CATALOG[category];
  const selected = appearance[category];
  return (
    <div className={styles.grid} role="list">
      {options.map((o) => {
        const resolved = o.layers.map((layer, layerIndex) => ({ category, optionId: o.id, layerIndex, layer }));
        const isOn = selected === o.id;
        return (
          <button key={o.id} type="button" className={isOn ? styles.cardOn : styles.card} onClick={() => onPick(o.id)} aria-pressed={isOn} aria-label={o.label}>
            <div className={styles.cardThumb}>{resolved.length ? <PartThumbnail resolved={resolved} size={72} /> : <span className={styles.noneGlyph}>—</span>}</div>
            <span className={styles.cardLabel}>{o.label}</span>
            {isOn && (
              <span className={styles.check} aria-hidden>
                ✓
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function CustomizeStep({ appearance, onChange, onNext }: { appearance: PersonaAppearance; onChange: (a: PersonaAppearance) => void; onNext: () => void }) {
  const [tab, setTab] = useState<PartCategory>('hair');
  const costumeOn = appearance.costume !== 'costume-none';
  const resolvedPreview = useMemo(() => resolveLayers(appearance), [appearance]);

  useEffect(() => {
    if (costumeOn && tab !== 'costume') setTab('costume');
  }, [costumeOn, tab]);

  const pick = (category: PartCategory, optionId: string) => onChange({ ...appearance, [category]: optionId });

  return (
    <div className={styles.screen}>
      <p className={styles.step}>Step 1 of 3 — Customize</p>
      <h1 className={styles.title}>Build your character</h1>
      <div className={styles.previewCard}>
        <PersonaViewport resolved={resolvedPreview} size={190} />
      </div>
      <CategoryTabs active={tab} disabled={costumeOn} onChange={setTab} />
      {costumeOn && tab === 'costume' && <p className={styles.costumeNotice}>A costume replaces your whole outfit. Pick "None" to go back to customizing pieces.</p>}
      <OptionGrid category={tab} appearance={appearance} onPick={(id) => pick(tab, id)} />
      <Button variant="accent" size="lg" onClick={onNext}>
        Next →
      </Button>
    </div>
  );
}

function DetailsStep({
  draft,
  onChange,
  onBack,
  onNext,
}: {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const locations = useResource(api.getLocations);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!draft.homeLocationId && locations.data?.length) onChange({ homeLocationId: locations.data[0].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locations.data]);

  function next() {
    if (!draft.name.trim()) {
      setError('Give your character a name.');
      return;
    }
    if (!draft.homeLocationId) {
      setError('Pick where your character hangs out.');
      return;
    }
    setError(null);
    onNext();
  }

  return (
    <div className={styles.screen}>
      <p className={styles.step}>Step 2 of 3 — Your details</p>
      <h1 className={styles.title}>Who are you?</h1>
      <TextField label="Name" value={draft.name} onChange={(e) => onChange({ name: e.target.value })} maxLength={24} />
      <TextArea label="A little about you" hint="Optional — shown with your character" value={draft.bio} onChange={(e) => onChange({ bio: e.target.value })} maxLength={140} rows={2} />
      {!locations.data ? (
        <Loading label="Loading campus locations" />
      ) : (
        <SelectField label="Where do you hang out?" value={draft.homeLocationId} onChange={(e) => onChange({ homeLocationId: e.target.value })}>
          {locations.data.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </SelectField>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.stepActions}>
        <Button variant="ghost" onClick={onBack}>
          ← Back
        </Button>
        <Button variant="accent" onClick={next}>
          Next →
        </Button>
      </div>
    </div>
  );
}

function ConfirmStep({ draft, onBack, onCreated }: { draft: Draft; onBack: () => void; onCreated: (p: Persona) => void }) {
  const locations = useResource(api.getLocations);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolved = useMemo(() => resolveLayers(draft.appearance), [draft.appearance]);
  const homeName = locations.data?.find((l) => l.id === draft.homeLocationId)?.name ?? '…';

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const persona = await api.createPersona(draft);
      onCreated(persona);
    } catch {
      setError('That didn’t save. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.screen}>
      <p className={styles.step}>Step 3 of 3 — Confirm</p>
      <h1 className={styles.title}>Ready to join?</h1>
      <div className={styles.previewCard}>
        <PersonaViewport resolved={resolved} size={190} />
      </div>
      <p className={styles.name}>{draft.name}</p>
      {draft.bio && <p className={styles.bio}>{draft.bio}</p>}
      <p className={styles.homeLine}>Hangs out at {homeName}</p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.stepActions}>
        <Button variant="ghost" onClick={onBack} disabled={submitting}>
          ← Back
        </Button>
        <Button variant="accent" size="lg" onClick={submit} disabled={submitting}>
          {submitting ? 'Adding you to the map…' : 'Add me to the map'}
        </Button>
      </div>
    </div>
  );
}

function CreateWizard({ onCreated }: { onCreated: (p: Persona) => void }) {
  const [step, setStep] = useState<'customize' | 'details' | 'confirm'>('customize');
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  if (step === 'customize') {
    return <CustomizeStep appearance={draft.appearance} onChange={(appearance) => patch({ appearance })} onNext={() => setStep('details')} />;
  }
  if (step === 'details') {
    return <DetailsStep draft={draft} onChange={patch} onBack={() => setStep('customize')} onNext={() => setStep('confirm')} />;
  }
  return <ConfirmStep draft={draft} onBack={() => setStep('details')} onCreated={onCreated} />;
}

function StatusView({ persona, onRemoved }: { persona: Persona; onRemoved: () => void }) {
  const locations = useResource(api.getLocations);
  const [now, setNow] = useState(() => Date.now());
  const [removing, setRemoving] = useState(false);
  const resolved = useMemo(() => resolveLayers(persona.appearance), [persona.appearance]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, []);

  const text = useMemo(() => (locations.data ? statusText(persona, locations.data, now) : null), [locations.data, persona, now]);

  async function remove() {
    setRemoving(true);
    try {
      await api.deleteMyPersona();
      onRemoved();
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className={styles.screen}>
      <h1 className={styles.title}>You’re on the map</h1>
      <div className={styles.previewCard}>
        <PersonaViewport resolved={resolved} size={190} />
      </div>
      <p className={styles.name}>{persona.name}</p>
      {persona.bio && <p className={styles.bio}>{persona.bio}</p>}

      <div className={styles.statusCard}>
        <span className={styles.statusLabel}>Right now</span>
        <p className={styles.statusText}>{text ?? 'Finding your character…'}</p>
      </div>

      <Button variant="ghost" onClick={remove} disabled={removing}>
        {removing ? 'Removing…' : 'Remove my character'}
      </Button>
    </div>
  );
}

export default function Join() {
  const [persona, setPersona] = useState<Persona | null | 'loading'>('loading');

  useEffect(() => {
    api.getMyPersona().then(setPersona);
  }, []);

  if (persona === 'loading') {
    return (
      <div className={styles.screen}>
        <Loading label="Loading" />
      </div>
    );
  }

  return persona ? <StatusView persona={persona} onRemoved={() => setPersona(null)} /> : <CreateWizard onCreated={setPersona} />;
}
