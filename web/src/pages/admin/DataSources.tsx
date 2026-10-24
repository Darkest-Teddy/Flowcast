import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, useResource } from '../../data/api';
import type { DataSource, SourceGroup } from '../../data/types';
import { formatRelative, formatTime, isToday, formatDayTime } from '../../lib/format';
import { Button, CellStack, Grid, HealthBadge, Loading, Page, PageHeader, SectionHeading, StatCard, StatusBadge, Table, type Column } from '../../ui';
import { SourceDetail } from './components/SourceDetail';
import { StatusLine, useFlash } from './components/StatusLine';
import { useNow, wait } from './components/useNow';
import styles from './DataSources.module.css';

const groups: { id: SourceGroup; title: string }[] = [
  { id: 'prebuilt', title: 'Built ahead of time' },
  { id: 'people', title: 'From users and clubs' },
  { id: 'live', title: 'Live feeds' },
];

// Actions that run a job; every other action label opens the source's settings.
const jobs: Record<string, { running: string; done: string }> = {
  Refresh: { running: 'Refreshing', done: 'Refreshed' },
  Rebuild: { running: 'Rebuilding', done: 'Rebuilt' },
  Train: { running: 'Training', done: 'Trained' },
};

const JOB_MS = 2000;

export default function DataSources() {
  const { data: sources, setData, error } = useResource(api.getDataSources);
  const [running, setRunning] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const message = useFlash(5000);
  const now = useNow();

  const replace = (updated: DataSource) => setData((list) => list?.map((s) => (s.id === updated.id ? updated : s)) ?? null);
  const markRunning = (ids: string[], label: string | null) =>
    setRunning((r) => {
      const next = { ...r };
      for (const id of ids) {
        if (label) next[id] = label;
        else delete next[id];
      }
      return next;
    });

  const runJob = async (source: DataSource) => {
    const job = jobs[source.action];
    markRunning([source.id], job.running);
    replace(await api.updateDataSource(source.id, { statusText: job.running }));
    await wait(JOB_MS);
    replace(await api.updateDataSource(source.id, { health: 'healthy', statusText: 'Healthy', updatedAt: new Date().toISOString() }));
    markRunning([source.id], null);
    message.show(`${source.name}: ${job.done.toLowerCase()}`);
  };

  const refreshAll = async () => {
    if (!sources) return;
    const targets = sources.filter((s) => s.health !== 'off' && !running[s.id]);
    markRunning(targets.map((s) => s.id), 'Refreshing');
    await wait(JOB_MS);
    const at = new Date().toISOString();
    const updated = await Promise.all(targets.map((s) => api.updateDataSource(s.id, { updatedAt: at })));
    updated.forEach(replace);
    markRunning(targets.map((s) => s.id), null);
    message.show(`Refreshed ${targets.length} sources. Sources that aren't connected were skipped.`);
  };

  if (error) return <Page wide><PageHeader title="Data sources" /><p role="alert">Couldn't load data sources: {error.message}</p></Page>;

  const busy = Object.keys(running).length > 0;
  const count = (fn: (s: DataSource) => boolean) => sources?.filter(fn).length ?? 0;
  const lastRebuild = sources
    ?.filter((s) => s.group === 'prebuilt' && s.updatedAt)
    .map((s) => s.updatedAt!)
    .sort()
    .at(-1);

  const columns: Column<DataSource>[] = [
    { key: 'source', header: 'Source', render: (s) => <CellStack primary={s.name} secondary={s.via} />, width: '26%' },
    { key: 'feeds', header: 'Feeds', render: (s) => s.feeds },
    {
      key: 'status',
      header: 'Status',
      render: (s) => (running[s.id] ? <StatusBadge tone="accent">{running[s.id]}…</StatusBadge> : <HealthBadge health={s.health} text={s.statusText} />),
    },
    {
      key: 'fresh',
      header: 'Freshness',
      render: (s) => (
        <span className={styles.quiet}>
          {s.updatedAt ? formatRelative(s.updatedAt, now) : s.health === 'off' ? 'Never' : 'Not tracked'}
        </span>
      ),
    },
    { key: 'size', header: 'Size', render: (s) => (s.size ? s.size : <None />) },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (s) => {
        const job = jobs[s.action];
        const open = openId === s.id;
        const toggle = () => setOpenId(open ? null : s.id);
        return (
          <div className={styles.rowActions}>
            {job && (
              <Button size="sm" onClick={() => runJob(s)} disabled={Boolean(running[s.id])} aria-label={`${s.action} ${s.name}`}>
                {s.action}
              </Button>
            )}
            <Button
              size="sm"
              variant={job ? 'ghost' : 'secondary'}
              onClick={toggle}
              aria-expanded={open}
              aria-controls={`source-${s.id}`}
              aria-label={`${job ? 'Configure' : s.action} ${s.name}`}
            >
              {job ? 'Configure' : s.action}
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <Page wide>
      <PageHeader
        title="Data sources"
        description="Where every number on the map comes from, how fresh it is, and what needs fixing."
        actions={
          <Button icon={<RefreshCw aria-hidden />} onClick={refreshAll} disabled={!sources || busy}>
            {busy ? 'Refreshing' : 'Refresh all'}
          </Button>
        }
      />

      {!sources ? (
        <Loading label="Loading data sources" />
      ) : (
        <>
          <Grid columns={4}>
            <StatCard label="Healthy" value={String(count((s) => s.health === 'healthy'))} detail={`of ${sources.length} sources`} />
            <StatCard label="Needs attention" value={String(count((s) => s.health === 'attention' || s.health === 'failing'))} detail={`${count((s) => s.health === 'failing')} failing`} />
            <StatCard label="Not connected or off" value={String(count((s) => s.health === 'off'))} detail="Set up when needed" />
            <StatCard
              label="Last full rebuild"
              value={lastRebuild ? formatTime(lastRebuild) : 'Never'}
              detail={lastRebuild ? (isToday(lastRebuild) ? formatRelative(lastRebuild, now) : formatDayTime(lastRebuild)) : 'Nothing built yet'}
            />
          </Grid>

          <StatusLine flash={message.flash} className={styles.message} />

          {groups.map((g) => {
            const rows = sources.filter((s) => s.group === g.id);
            const open = rows.find((s) => s.id === openId);
            return (
              <section key={g.id} aria-label={g.title}>
                <SectionHeading>{g.title}</SectionHeading>
                <Table caption={g.title} columns={columns} rows={rows} rowKey={(s) => s.id} />
                {open && (
                  <div id={`source-${open.id}`}>
                    <SourceDetail source={open} onSaved={replace} onClose={() => setOpenId(null)} />
                  </div>
                )}
              </section>
            );
          })}
        </>
      )}
    </Page>
  );
}

function None() {
  return (
    <span className={`${styles.quiet} ${styles.none}`}>
      <span aria-hidden>–</span>
      <span className="visually-hidden">None</span>
    </span>
  );
}
