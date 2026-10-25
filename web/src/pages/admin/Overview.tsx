import { api, useResource } from '../../data/api';
import { Button, Grid, Loading, Page, PageHeader, Panel, StatCard } from '../../ui';

export default function Overview() {
  const sources = useResource(api.getDataSources);
  const apps = useResource(api.getClubApplications);
  const users = useResource(api.getAdminUsers);
  const clubs = useResource(api.getClubs);
  const sim = useResource(api.getSimulation);

  return (
    <Page>
      <PageHeader title="Overview" description="Available Flowcast data. Unavailable records are not counted as zero." actions={<><Button to="/admin/simulation">Simulation settings</Button><Button to="/admin/live">Live demo</Button></>} />
      <Grid columns={4} phoneColumns={2}>
        <StatCard label="Users" value={users.error ? 'Unavailable' : users.data ? String(users.data.length) : 'Loading'} />
        <StatCard label="Calendars connected" value={users.error ? 'Unavailable' : users.data ? String(users.data.filter((u) => u.calendarConnected).length) : 'Loading'} />
        <StatCard label="Verified clubs" value={clubs.error ? 'Unavailable' : clubs.data ? String(clubs.data.filter((c) => c.verified).length) : 'Loading'} />
        <StatCard label="Configured simulation agents" value={sim.error ? 'Unavailable' : sim.data ? sim.data.population.agents.toLocaleString() : 'Loading'} />
      </Grid>
      {[
        { name: 'Users', resource: users },
        { name: 'Clubs', resource: clubs },
        { name: 'Shared simulation', resource: sim },
      ].map(({ name, resource }) => resource.error && <p key={name} role="alert">{name}: {resource.error.message}</p>)}
      <Panel title="Source information">
        {sources.error ? <p role="alert">{sources.error.message}</p> : !sources.data ? <Loading /> : sources.data.length === 0 ? <p>Source information is unavailable.</p> : <p>{sources.data.length} published source records. Live connection health is not tested here. <Button to="/admin/data-sources" variant="ghost">View sources</Button></p>}
      </Panel>
      <Panel title="Club applications">
        {apps.error ? <p role="alert">{apps.error.message}</p> : !apps.data ? <Loading /> : <p>{apps.data.filter((a) => a.status === 'pending').length} applications waiting for review.</p>}
      </Panel>
    </Page>
  );
}
