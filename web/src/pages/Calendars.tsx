import { Button, EmptyState, Page, PageHeader } from '../ui';

export default function Calendars() {
  return (
    <Page>
      <PageHeader title="Calendars" description="No personal calendar is connected." />
      <EmptyState
        title="Google Calendar connection is unavailable"
        body="This version has no Google sign-in or calendar sync service. Flowcast has not read your calendars. You can still browse campus places and public events."
        action={<Button disabled>Connect Google Calendar — unavailable</Button>}
      />
      <Button to="/events">Browse campus events</Button>
    </Page>
  );
}
