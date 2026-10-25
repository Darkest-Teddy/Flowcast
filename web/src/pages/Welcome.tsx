import { config } from '../config';
import { Button, ListRow, Page, PageHeader, SectionList } from '../ui';

export default function Welcome() {
  return (
    <Page>
      <PageHeader title="Welcome to Flowcast" description="Browse BU campus without an account." />
      <SectionList title="What’s available">
        <ListRow title="Campus places and events" subtitle="Explore published campus data and public events. Crowd projections are model-derived, not live occupancy measurements." />
        <ListRow title="Your Flowcast profile" subtitle="You’re signed in with Google. Flowcast saves your profile and preferences; these do not control an agent on the shared map." trailing={<Button to="/profile">Edit profile</Button>} />
        <ListRow title="Personal calendars" subtitle="Google sign-in does not grant calendar access. Calendar sync is unavailable; no personal calendar has been read." />
      </SectionList>
      <Button variant="primary" to="/">Browse campus</Button>
      <Button href={config.mapUrl}>Open the map</Button>
    </Page>
  );
}
