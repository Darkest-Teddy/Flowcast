import { useState } from 'react';
import { api, useResource } from '../../data/api';
import type { AdminUser, Role } from '../../data/types';
import { formatDayTime, formatRelative } from '../../lib/format';
import { Avatar, EmptyState, Loading, Page, PageHeader, StatusBadge, Table, Tag, TextField, type Column } from '../../ui';
import { useNow } from './components/useNow';
import styles from './Users.module.css';

const roleLabel: Record<Role, string> = { student: 'Student', clubOfficer: 'Club officer', admin: 'Admin' };

export default function Users() {
  const { data: users, error } = useResource(api.getAdminUsers);
  const [query, setQuery] = useState('');
  const now = useNow();

  const q = query.trim().toLowerCase();
  const shown = (users ?? []).filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));

  const columns: Column<AdminUser>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (u) => (
        <span className={styles.name}>
          <Avatar name={u.name} size={24} />
          {u.name}
        </span>
      ),
    },
    { key: 'email', header: 'Email', render: (u) => <a href={`mailto:${u.email}`}>{u.email}</a> },
    {
      key: 'roles',
      header: 'Roles',
      render: (u) => (
        <span className={styles.tags}>
          {u.roles.map((r) => (
            <Tag key={r} tone={r === 'admin' ? 'accent' : 'off'}>{roleLabel[r]}</Tag>
          ))}
        </span>
      ),
    },
    {
      key: 'calendar',
      header: 'Calendar',
      render: (u) => (u.calendarConnected ? <StatusBadge tone="ok">Connected</StatusBadge> : <StatusBadge tone="off">Not connected</StatusBadge>),
    },
    { key: 'joined', header: 'Joined', render: (u) => <span title={formatDayTime(u.joinedAt)} className={styles.quiet}>{formatRelative(u.joinedAt, now)}</span> },
  ];

  return (
    <Page wide>
      <PageHeader title="Users" description="Everyone who has signed in to Flowcast." />

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <TextField label="Search users" type="search" placeholder="Name or email" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {users && (
          <p className={styles.count} role="status">
            {q ? `${shown.length} of ${users.length} users` : `${users.length} users`}
          </p>
        )}
      </div>

      {error ? (
        <p role="alert">Couldn't load users: {error.message}</p>
      ) : !users ? (
        <Loading label="Loading users" />
      ) : shown.length === 0 ? (
        <EmptyState title="No users match" body={`Nobody's name or email contains “${query.trim()}”.`} />
      ) : (
        <Table caption="Users" columns={columns} rows={shown} rowKey={(u) => u.id} />
      )}
    </Page>
  );
}
