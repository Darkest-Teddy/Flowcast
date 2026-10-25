import { Button, EmptyState, Page, PageHeader } from '../../ui';

export default function ClubApply() {
  return (
    <Page>
      <PageHeader title="Register your club" />
      <EmptyState
        title="Club registration is unavailable"
        body="No club application or officer verification service is connected. Applications cannot be submitted, and calendar publishing is unavailable."
        action={<Button to="/clubs">Back to clubs</Button>}
      />
    </Page>
  );
}
