import { config } from '../config';
import { Button, ListRow, Page, PageHeader, SectionList } from '../ui';
import styles from './Welcome.module.css';

export default function Welcome() {
  return (
    <Page>
      <PageHeader title="Welcome to Flowcast" description="Browse BU campus without an account." />
      <SectionList title="What’s available">
        <ListRow title="Campus places and events" subtitle="Explore published campus data and public events. Crowd projections are model-derived, not live occupancy measurements." />
        <ListRow title="Your Flowcast profile" subtitle="You’re signed in with Google. Flowcast saves your profile and preferences; these do not control an agent on the shared map." trailing={<Button to="/profile">Edit profile</Button>} />
        <ListRow title="Your classes" subtitle="Pick your sections from BU’s published schedule, or import them from an .ics file. You can use both." trailing={<Button to="/courses">Pick classes</Button>} />
        <ListRow title="Study spots" subtitle="Find a space for the time you have, with walking time and projected crowding." trailing={<Button to="/study">Find a spot</Button>} />
        <ListRow title="The 3D campus map" subtitle="Watch the simulated day, campus events and live transit. No account needed." />
      </SectionList>
      <div className={styles.actions}>
        <Button variant="primary" to="/">Browse campus</Button>
        <Button href={config.mapUrl}>Open the map</Button>
      </div>
    </Page>
  );
}
