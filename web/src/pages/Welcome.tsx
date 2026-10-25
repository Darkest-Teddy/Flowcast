import { config } from '../config';
import { Button, ListRow, Page, PageHeader, SectionList } from '../ui';

export default function Welcome() {
  return (
    <Page>
      <PageHeader title="Welcome to Flowcast" description="Browse BU campus without an account." />
      <SectionList title="What’s available">
        <ListRow title="Campus places and events" subtitle="Explore published campus data and public events. Crowd projections are model-derived, not live occupancy measurements." />
        <ListRow title="Optional browser-linked profile" subtitle="Flowcast saves the name and preferences you enter for this browser. These do not connect a Google account or control an agent on the shared map." trailing={<Button to="/profile">Edit profile</Button>} />
        <ListRow title="Personal calendars" subtitle="Google sign-in and calendar sync are unavailable. No personal calendar has been read." />
      </SectionList>
      <Button variant="primary" to="/">Browse campus</Button>
      <Button href={config.mapUrl}>Open the map</Button>
    </Page>
  );
}
