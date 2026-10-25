import { useCallback, useMemo, useState } from 'react';
import { api, useResource } from '../../data/api';
import { errorText } from '../../lib/orgs';

/**
 * The signed-in person's organization state (officer of, RSVPs, sharing) and the public officer
 * meetings with RSVP counts, with RSVP and sharing toggles that update both.
 */
export function useOrgState() {
  const me = useResource(api.getOrgMe);
  const meetings = useResource(api.getClubMeetings);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const going = useMemo(() => new Set(me.data?.rsvps ?? []), [me.data]);
  const rsvpCount = useCallback((eventId: string) => meetings.data?.rsvps[eventId] ?? 0, [meetings.data]);

  async function setRsvp(eventId: string, on: boolean) {
    setPending(eventId); setError(null);
    try {
      const r = await api.setRsvp(eventId, on);
      me.setData((d) => d && { ...d, rsvps: on ? [...new Set([...d.rsvps, eventId])] : d.rsvps.filter((x) => x !== eventId) });
      meetings.setData((d) => d && { ...d, rsvps: { ...d.rsvps, [eventId]: r.count } });
    } catch (e) { setError(errorText(e, 'Your RSVP could not be saved.')); }
    finally { setPending(null); }
  }
  async function setSharing(clubId: string, on: boolean) {
    setPending(`share:${clubId}`); setError(null);
    try {
      await api.setSharingFreeTime(clubId, on);
      me.setData((d) => d && { ...d, sharing: on ? [...new Set([...d.sharing, clubId])] : d.sharing.filter((x) => x !== clubId) });
    } catch (e) { setError(errorText(e, 'Your sharing choice could not be saved.')); }
    finally { setPending(null); }
  }
  return { me, meetings, going, rsvpCount, setRsvp, setSharing, pending, error };
}
export type OrgState = ReturnType<typeof useOrgState>;
