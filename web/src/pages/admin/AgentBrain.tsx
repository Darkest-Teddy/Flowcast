import { useEffect, useState } from 'react';
import { api, useResource } from '../../data/api';
import type { BrainRule, JevQuestion, SimulationSettings } from '../../data/types';
import { Button, Grid, Loading, Page, PageHeader, Panel, SectionHeading, SelectField, StatCard, Table, Tag, Toggle, type Column } from '../../ui';
import { StatusLine, useFlash } from './components/StatusLine';
import styles from './AgentBrain.module.css';

const timeouts = [500, 1000, 1500, 2000, 3000];
const seconds = (ms: number) => `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;

const ruleColumns: Column<BrainRule & { order: number }>[] = [
  { key: 'order', header: 'Order', render: (r) => <span className={styles.quiet}>{r.order}</span>, width: '1%' },
  { key: 'when', header: 'When', render: (r) => r.when },
  { key: 'then', header: 'The agent will', render: (r) => r.then },
];

const questionColumns: Column<JevQuestion>[] = [
  { key: 'question', header: 'Question', render: (q) => <span className={styles.strong}>{q.question}</span> },
  { key: 'answer', header: 'Answer', render: (q) => <Tag tone="accent">{q.answer === 'yesNo' ? 'Yes or no' : 'Multiple choice'}</Tag> },
  { key: 'options', header: 'Choices', render: (q) => <span className={styles.quiet}>{q.options.join(', ')}</span> },
  { key: 'when', header: 'Asked when', render: (q) => q.askedWhen },
];

export default function AgentBrain() {
  const { data: brain } = useResource(api.getAgentBrain);
  const { data: sim, setData: setSim } = useResource(api.getSimulation);
  const { data: sources } = useResource(api.getDataSources);
  const [draft, setDraft] = useState<SimulationSettings['brain'] | null>(null);
  const [saving, setSaving] = useState(false);
  const message = useFlash();

  useEffect(() => {
    if (sim && !draft) setDraft(sim.brain);
  }, [sim, draft]);

  const jev = sources?.find((s) => s.id === 'jev');
  const jevMissing = jev?.health === 'off';
  const changed = Boolean(sim && draft && JSON.stringify(sim.brain) !== JSON.stringify(draft));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const updated = await api.updateSimulation({ brain: draft });
    setSim(updated);
    setDraft(updated.brain);
    setSaving(false);
    message.show('Saved');
  };

  return (
    <Page wide>
      <PageHeader
        title="Agent brain"
        description="How simulated students decide where to go. Rules always run first. Judgment calls go to Jev, TypeSafe's decision model, which answers with a typed yes or no, or one choice from a fixed list, plus a probability for each answer."
      />

      {!brain || !draft ? (
        <Loading label="Loading agent brain" />
      ) : (
        <>
          <Panel title="Decision settings" className={styles.settings}>
            <Toggle
              label="Use Jev for judgment calls"
              description={draft.useJev ? 'Rules first, then Jev when no rule settles it.' : 'Rules only. Judgment calls use the most likely rule.'}
              checked={draft.useJev}
              onChange={(v) => setDraft({ ...draft, useJev: v })}
            />
            {jevMissing && draft.useJev && (
              <p className={styles.warning}>
                Jev has no API key yet, so every judgment call falls back to the rules.{' '}
                <Button to="/admin/data-sources" variant="ghost" size="sm">Add the key in Data sources</Button>
              </p>
            )}
            <div className={styles.select}>
              <SelectField
                label="Fall back to the rules after"
                hint="If Jev hasn't answered by then, the rules decide so agents never stand still."
                value={draft.fallbackMs}
                disabled={!draft.useJev}
                onChange={(e) => setDraft({ ...draft, fallbackMs: Number(e.target.value) })}
              >
                {timeouts.map((ms) => (
                  <option key={ms} value={ms}>{seconds(ms)}</option>
                ))}
              </SelectField>
            </div>
            <div className={styles.actions}>
              <Button variant="accent" onClick={save} disabled={!changed || saving}>
                {saving ? 'Saving' : 'Save'}
              </Button>
              {changed && (
                <Button variant="ghost" onClick={() => sim && setDraft(sim.brain)} disabled={saving}>
                  Discard
                </Button>
              )}
              <StatusLine flash={message.flash} />
            </div>
          </Panel>

          <SectionHeading>Rules</SectionHeading>
          <p className={styles.lead}>Checked in this order on every decision. The first rule that matches wins. Read-only: rules are changed in code.</p>
          <Table caption="Rules" columns={ruleColumns} rows={brain.rules.map((r, i) => ({ ...r, order: i + 1 }))} rowKey={(r) => r.id} />

          <SectionHeading>Questions sent to Jev</SectionHeading>
          <p className={styles.lead}>Asked only when no rule settles the decision. Jev picks from the listed choices, so answers are always valid.</p>
          <Table caption="Questions sent to Jev" columns={questionColumns} rows={brain.questions} rowKey={(q) => q.id} />

          <SectionHeading actions={<Tag tone="warn">Estimates</Tag>}>Cost and usage</SectionHeading>
          <p className={styles.lead}>Placeholder numbers worked out by hand, not measured. They'll be replaced by real counts once Jev is connected.</p>
          <Grid columns={4} phoneColumns={2}>
            {brain.usage.map((u) => (
              <StatCard key={u.id} label={u.label} value={u.value} detail={`Estimate. ${u.detail}`} />
            ))}
          </Grid>
        </>
      )}
    </Page>
  );
}
