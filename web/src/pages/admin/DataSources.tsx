import { useState } from 'react';
import { api, useResource } from '../../data/api';
import type { DataSource, SourceGroup } from '../../data/types';
import { formatRelative } from '../../lib/format';
import { Button, CellStack, EmptyState, HealthBadge, Loading, Page, PageHeader, SectionHeading, Table, type Column } from '../../ui';
import { SourceDetail } from './components/SourceDetail';
import { useNow } from './components/useNow';
import styles from './DataSources.module.css';

const groups: { id: SourceGroup; title: string }[] = [
  { id: 'prebuilt', title: 'Built ahead of time' },
  { id: 'people', title: 'From users and clubs' },
  { id: 'live', title: 'Live feeds' },
];

export default function DataSources() {
  const { data: sources, error, loading, reload } = useResource(api.getDataSources);
  const [openId, setOpenId] = useState<string | null>(null);
  const now = useNow();
  const columns: Column<DataSource>[] = [
    { key: 'source', header: 'Source', render: (s) => <CellStack primary={s.name} secondary={s.via} />, width: '26%' },
    { key: 'feeds', header: 'Feeds', render: (s) => s.feeds },
    { key: 'status', header: 'Reported status', render: (s) => <HealthBadge health={s.health} text={s.statusText} /> },
    { key: 'fresh', header: 'Last reported update', render: (s) => <span className={styles.quiet}>{s.updatedAt ? formatRelative(s.updatedAt, now) : 'Not reported'}</span> },
    { key: 'size', header: 'Size', render: (s) => s.size || 'Not reported' },
    {
      key: 'action', header: '', align: 'right', render: (s) => (
        <Button size="sm" onClick={() => setOpenId(openId === s.id ? null : s.id)} aria-expanded={openId === s.id}>
          Details
        </Button>
      ),
    },
  ];

  return (
    <Page wide>
      <PageHeader title="Data sources" description="Published source information. This view does not test live connections." actions={<Button onClick={reload} disabled={loading}>Reload source information</Button>} />
      <p>Source configuration, connection tests, refresh jobs and rebuilds are unavailable here. No backend supports these controls.</p>
      {error ? <p role="alert">{error.message}</p> : !sources ? <Loading label="Loading data sources" /> : sources.length === 0 ? (
        <EmptyState title="Source information unavailable" body="No source records were returned. This does not establish source health." />
      ) : groups.map((g) => {
        const rows = sources.filter((s) => s.group === g.id);
        const open = rows.find((s) => s.id === openId);
        if (!rows.length) return null;
        return (
          <section key={g.id} aria-label={g.title}>
            <SectionHeading>{g.title}</SectionHeading>
            <Table caption={g.title} columns={columns} rows={rows} rowKey={(s) => s.id} />
            {open && <SourceDetail source={open} onClose={() => setOpenId(null)} />}
          </section>
        );
      })}
    </Page>
  );
}
