import { api, useResource } from '../../data/api';
import { Button, CellStack, Grid, HealthBadge, ListRow, Loading, Page, PageHeader, SectionList, StatCard, StatusBadge } from '../../ui';
import { lightingOptions, speedLabel, weatherLabel } from './components/simOptions';
import styles from './Overview.module.css';

export default function Overview() {
  const { data: sources } = useResource(api.getDataSources);
  const { data: apps } = useResource(api.getClubApplications);
  const { data: users } = useResource(api.getAdminUsers);
  const { data: clubs } = useResource(api.getClubs);
  const { data: sim } = useResource(api.getSimulation);

  const loaded = sources && apps && users && clubs && sim;
  const issues = (sources ?? [])
    .filter((s) => s.health === 'failing' || s.health === 'attention')
    .sort((a, b) => (a.health === b.health ? 0 : a.health === 'failing' ? -1 : 1));
  const pending = (apps ?? []).filter((a) => a.status === 'pending');
  const attentionCount = issues.length + pending.length;

  return (
    <Page>
      <PageHeader
        title="Overview"
        description="The state of Flowcast at a glance."
        actions={
          <>
            <Button to="/admin/simulation">Simulation settings</Button>
            <Button to="/admin/live" variant="accent">Open live demo</Button>
          </>
        }
      />

      {!loaded ? (
        <Loading label="Loading overview" />
      ) : (
        <div className={styles.stack}>
          <Grid columns={4} phoneColumns={2}>
            <StatCard label="Users" value={String(users.length)} detail="Signed in at least once" />
            <StatCard label="Calendars connected" value={String(users.filter((u) => u.calendarConnected).length)} detail={`of ${users.length} users`} />
            <StatCard label="Verified clubs" value={String(clubs.filter((c) => c.verified).length)} detail={`${pending.length} waiting for review`} />
            <StatCard label="Agents simulated" value={sim.population.agents.toLocaleString()} detail={sim.population.includeCalendars ? 'Including real calendars' : 'Generated schedules only'} />
          </Grid>

          <SectionList
            title="Needs attention"
            count={attentionCount}
            empty="Nothing needs attention. Every data source is healthy and no clubs are waiting."
          >
            {attentionCount > 0 ? (
              <>
                {issues.map((s) => (
                  <ListRow
                    key={s.id}
                    to="/admin/data-sources"
                    leading={<span className={styles.badge}><HealthBadge health={s.health} text={s.health === 'failing' ? 'Failing' : 'Attention'} /></span>}
                    title={<CellStack primary={s.name} secondary={s.statusText} />}
                  />
                ))}
                {pending.map((a) => (
                  <ListRow
                    key={a.id}
                    to="/admin/clubs"
                    leading={<span className={styles.badge}><StatusBadge tone="accent">Review</StatusBadge></span>}
                    title={<CellStack primary={a.clubName} secondary="Club waiting for verification" />}
                  />
                ))}
              </>
            ) : null}
          </SectionList>

          <SectionList title="The shared map right now" to="/admin/simulation">
            <ListRow title="Playback" detail={sim.paused ? 'Paused' : speedLabel(sim.playbackSpeed)} />
            <ListRow title="Weather" detail={weatherLabel(sim.weather)} />
            <ListRow title="Lighting" detail={lightingOptions.find((l) => l.value === sim.lighting)?.label ?? sim.lighting} />
            <ListRow
              title="Campus events on"
              detail={sim.events.filter((e) => e.enabled).map((e) => e.title).join(', ') || 'None'}
            />
            <ListRow title="Agent decisions" detail={sim.brain.useJev ? 'Rules and Jev' : 'Rules only'} to="/admin/agent-brain" />
          </SectionList>
        </div>
      )}
    </Page>
  );
}
