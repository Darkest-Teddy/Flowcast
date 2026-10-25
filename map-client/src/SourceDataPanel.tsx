import { useMemo } from 'react';
import { dailyParticipantLimit } from './sim/sourceDay';
import { carriedForwardHours, dateForWeekday, openingHoursForDate, WEEKDAYS, type CampusData, type Evidence, type SourceMeeting } from './data/campusData';
import { formatClock, type CampusLocation } from './sim/playback';
import './source-data.css';

interface Props {
  data: CampusData;
  locations: CampusLocation[];
  selectedBuilding: string | null;
  campus: string;
  weekday: number;
  time: number;
  onSelect: (location: CampusLocation) => void;
}

interface MeetingRow {
  meeting: SourceMeeting;
  location: CampusLocation;
  start: number;
  end: number;
}

function sourceDate(value: string | null): string {
  return value ? value.slice(0, 10) : 'Undated';
}

function displayUnit(unit: string): string {
  return unit.replaceAll('_', ' ').replaceAll('residential-spaces', 'residential spaces').replaceAll('bed-spaces', 'bed spaces');
}

function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  return (
    <ul className="source-evidence">
      {evidence.map((item) => (
        <li key={item.id}>
          <span>{item.label}</span>
          <strong>{item.value.toLocaleString()} {displayUnit(item.unit)}</strong>
          <span className="source-caption">{item.basis.replaceAll('_', ' ')} · {sourceDate(item.publishedAt)}</span>
          {item.note && <details><summary>Details</summary><p>{item.note}</p></details>}
          <a href={item.sourceUrl} target="_blank" rel="noreferrer">Source</a>
        </li>
      ))}
    </ul>
  );
}

const BOSTON_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });

function eventTime(value: string): string {
  return BOSTON_TIME.format(new Date(value));
}

export function SourceDataPanel({ data, locations, selectedBuilding, campus, weekday, time, onSelect }: Props) {
  const date = dateForWeekday(data, weekday);
  const groups = useMemo(() => {
    const byBuilding = new Map<string, { location: CampusLocation; locations: CampusLocation[] }>();
    for (const location of locations) {
      if ((location.campus ?? 'charles-river') !== campus) continue;
      const group = byBuilding.get(location.building);
      if (group) group.locations.push(location);
      else byBuilding.set(location.building, { location, locations: [location] });
    }
    return [...byBuilding.values()].sort((a, b) => a.location.name.localeCompare(b.location.name));
  }, [locations, campus]);
  const selected = groups.find((group) => group.location.building === selectedBuilding);
  const selection = useMemo(() => {
    const rows: MeetingRow[] = [];
    const evidence = new Map<string, Evidence>();
    const hours: { location: CampusLocation; entries: typeof data.locations[string]['hours'] }[] = [];
    const codes = new Set<string>();
    const seen = new Set<string>();
    for (const location of selected?.locations ?? []) {
      const source = data.locations[location.id];
      if (!source) continue;
      source.buildingCodes.forEach((code) => codes.add(code));
      source.evidence.forEach((item) => evidence.set(item.id, item));
      const published = openingHoursForDate(source.hours, date, weekday);
      hours.push({ location, entries: published.length || source.hoursStatus === 'restricted' ? published : carriedForwardHours(source.hours, date, weekday) });
      for (const meeting of source.meetings) {
        for (const interval of meeting.intervals) {
          if (interval.weekday !== weekday) continue;
          const key = `${meeting.id}:${interval.startSec}:${interval.endSec}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({ meeting, location, start: interval.startSec - weekday * 86400, end: interval.endSec - weekday * 86400 });
        }
      }
    }
    return { rows, evidence: [...evidence.values()], hours, codes: [...codes] };
  }, [selected, data, date, weekday]);
  const active = selection.rows.filter((row) => !row.meeting.calendarRestricted && row.start <= time && time < row.end);
  const upcoming = selection.rows.filter((row) => !row.meeting.calendarRestricted && row.start > time);
  const ranked = [...selection.rows].sort((a, b) => {
    const rank = (row: MeetingRow) => row.meeting.calendarRestricted ? 3 : row.start <= time && time < row.end ? 0 : row.start > time ? 1 : 2;
    return rank(a) - rank(b) || (rank(a) === 2 ? b.end - a.end : a.start - b.start) || a.meeting.courseCode.localeCompare(b.meeting.courseCode);
  });
  const visibleEvents = useMemo(() => data.events.filter((event) => event.start.slice(0, 10) <= date && (event.end ?? event.start).slice(0, 10) >= date), [data.events, date]);
  const mappedGroups = groups.filter((group) => group.locations.some((location) => {
    const source = data.locations[location.id];
    return location.estimatedProfile || location.estimatedHousingProfile || source && (source.meetings.length > 0 || source.evidence.length > 0 || source.hours.length > 0);
  }));
  const restricted = selection.rows.filter((row) => row.meeting.calendarRestricted).length;

  return (
    <div className="source-data">
      <p className="source-caption">{data.term} · Updated {sourceDate(data.collectedAt)}</p>
      {selected && <label className="source-building-picker">
        Building
        <select aria-label="Inspect source building" value={selected.location.id} onChange={(event) => {
          const group = groups.find((entry) => entry.location.id === event.target.value);
          if (group) onSelect(group.location);
        }}>{groups.map((group) => <option key={group.location.building} value={group.location.id}>{group.location.name}</option>)}</select>
      </label>}
      {selected ? (
        <section aria-label="Selected building source data">
          <h2>{selected.location.name}</h2>
          {selection.codes.length > 0 && <p className="source-caption">Building codes: {selection.codes.join(', ')}</p>}
          <h3>{WEEKDAYS[weekday]} classes</h3>
          <p className="source-caption">{active.length} in progress · {upcoming.length} later · {selection.rows.length} classes today</p>
          {restricted > 0 && <p className="source-caution">{restricted} {restricted === 1 ? 'class has' : 'classes have'} special dates.</p>}
          {ranked.length === 0 ? <p>No classes on {WEEKDAYS[weekday]}.</p> : (
            <ol className="source-meetings">
              {ranked.slice(0, 20).map(({ meeting, location, start, end }) => {
                const status = meeting.calendarRestricted ? 'Special dates' : start <= time && time < end ? 'In progress' : start > time ? 'Upcoming' : 'Ended';
                return (
                  <li key={`${meeting.id}:${start}:${end}`}>
                    <div className="source-meeting-head">
                      <a href={meeting.sourceUrl} target="_blank" rel="noreferrer">{meeting.courseCode} {meeting.section}</a>
                      <span className={status === 'In progress' ? 'source-status is-now' : 'source-status'}>{status}</span>
                    </div>
                    <span>{meeting.title}</span>
                    <span className="source-caption">{formatClock(start)}–{formatClock(end)} · {location.short} {meeting.roomCode}</span>
                    <span className="source-caption">{meeting.roomCapacity === null ? 'Seats not listed' : `${meeting.roomCapacity.toLocaleString()} seats`}</span>
                    {meeting.sharedKey && <span className="source-caption">Shares a room and time with another listing.</span>}
                    {meeting.notes && <details><summary>Schedule notes</summary><p>{meeting.notes}</p></details>}
                  </li>
                );
              })}
            </ol>
          )}
          {ranked.length > 20 && <p className="source-caption">Showing 20 of {ranked.length} listings, with current and upcoming meetings first.</p>}
          {selection.evidence.length > 0 && <><h3>Building details</h3><EvidenceList evidence={selection.evidence} /></>}
          {selected.locations.filter(location => location.estimatedProfile || location.estimatedHousingProfile).map(location => {
            const profile = location.estimatedProfile;
            const housing = location.estimatedHousingProfile;
            const estimate = profile ?? housing!;
            const windows = profile?.weekdayWindows.filter(day => day.weekday === weekday).flatMap(day => day.windows) ?? [];
            return <div className="source-hours" key={`estimate:${location.id}`}>
              <h3>Activity estimate</h3>
              <strong>{location.name}</strong>
              <span>{housing ? `${housing.capacity.toLocaleString()} estimated beds · ${Math.round(housing.occupancyRate * 100)}% occupied` : `${dailyParticipantLimit(profile!, weekday)} daily participant limit · ${profile!.durationMinutes}-minute visits`}</span>
              {profile && <span>{WEEKDAYS[weekday]}: {windows.length ? windows.map(([start, end]) => `${formatClock(start)}–${formatClock(end)}`).join(', ') : 'No estimated activities'}</span>}
              <details><summary>Model assumptions</summary><p>{estimate.note}</p><p>{estimate.proxy}</p><p>Confidence: {estimate.confidence}. These are simulation estimates.</p></details>
            </div>;
          })}
          {selection.hours.some((item) => item.entries.length > 0) && <>
            <h3>Hours</h3>
            {selection.hours.map(({ location, entries }) => entries.map((entry, index) => (
              <div className="source-hours" key={`${location.id}:${entry.date}:${index}`}>
                <strong>{location.name}</strong>
                <span>{entry.text || 'Hours not published'}</span>
                <span className="source-caption">{entry.date ?? `${WEEKDAYS[entry.weekday!]} hours`}</span>
              </div>
            )))}
          </>}
          {selection.hours.filter(({ location, entries }) => !entries.length && ['dining', 'library', 'gym'].includes(location.kind)).map(({ location }) => (
            <p className="source-caption" key={`hours-status:${location.id}`}>{location.name}: {data.locations[location.id]?.hoursStatus === 'restricted' ? 'Event or team access; not open recreation.' : `No verified service hours for ${date}.`}</p>
          ))}
          {selection.evidence.length === 0 && selection.rows.length === 0 && !selection.hours.some((item) => item.entries.length > 0) && !selected.locations.some(location => location.estimatedProfile || location.estimatedHousingProfile) && <p className="source-caption">No building details available.</p>}
        </section>
      ) : (
        <section aria-label="Buildings with saved source data">
          <h2>Buildings</h2>
          <p>Select a building to see classes, hours, and details.</p>
          <ul className="source-building-list">
            {mappedGroups.map((group) => {
              const count = group.locations.reduce((total, location) => total + (data.locations[location.id]?.meetings.length ?? 0), 0);
              return <li key={group.location.building}><button onClick={() => onSelect(group.location)}><span>{group.location.name}</span><span className="source-caption">{count ? `${count} classes` : 'Building details'}</span></button></li>;
            })}
          </ul>
          {mappedGroups.length === 0 && <p>No building details available for this campus.</p>}
        </section>
      )}
      <details className="source-overview">
        <summary>About the data</summary>
        <p>The map simulates student movement using published schedules. Counts and colors show the simulation. Capacity, registration, and historical figures are listed separately.</p>
        <h3>Classes</h3>
        <p>{data.coverage.coursePages.toLocaleString()} course pages · {data.coverage.uniqueCourses.toLocaleString()} unique course codes.</p>
        <p>{data.coverage.mappedMeetings.toLocaleString()} of {data.coverage.sourceMeetings.toLocaleString()} class meetings are mapped. {data.coverage.calendarRestrictedMeetings.toLocaleString()} have special dates.</p>
        {data.coverage.unmappedBuildings.length > 0 && <details><summary>Unmapped buildings ({data.coverage.unmappedBuildings.length})</summary><p>{data.coverage.unmappedBuildings.map((entry) => `${entry.code}: ${entry.meetingCount}`).join(' · ')}</p><p className="source-caption">These buildings are not on the map yet.</p></details>}
        <h3>Events on {date}</h3>
        <p className="source-caption">{data.coverage.eventCount} events; {data.coverage.mappedEvents} are mapped.</p>
        {visibleEvents.length === 0 ? <p>No events on this date.</p> : <ul className="source-events">{visibleEvents.map((event) => {
          const multiday = event.end !== null && event.start.slice(0, 10) !== event.end.slice(0, 10);
          return <li key={event.id}>
            <a href={event.sourceUrl} target="_blank" rel="noreferrer">{event.name}</a>
            <span>{multiday ? `${event.start.slice(0, 10)} to ${event.end!.slice(0, 10)}` : `${eventTime(event.start)}${event.end ? `–${eventTime(event.end)}` : ''} Boston time`}</span>
            {multiday && <span className="source-caption">Multi-day event. See the source for individual dates.</span>}
            <span className="source-caption">{event.locationName ?? 'Location not public'}{event.locationName && !event.locationId ? ' · not mapped' : ''}</span>
            <span className="source-caption">{event.registrationCount === null ? 'Registrations not listed' : `${event.registrationCount.toLocaleString()} registrations`}</span>
            {event.locationId && locations.find((location) => location.id === event.locationId) && <button onClick={() => onSelect(locations.find((location) => location.id === event.locationId)!)}>Show location</button>}
          </li>;
        })}</ul>}
        <h3>Housing and dining</h3>
        <p>{locations.filter((location) => location.kind === 'dorm' && (data.locations[location.id]?.evidence.length ?? 0) > 0).length} residences have capacity data.</p>
        <p>{locations.filter((location) => location.kind === 'dining' && ((data.locations[location.id]?.evidence.length ?? 0) > 0 || (data.locations[location.id]?.hours.length ?? 0) > 0)).length} dining locations have hours or capacity data.</p>
        <h3>Historical library counts</h3>
        <p>{data.libraryHistory.name} · {data.libraryHistory.observationPeriod}</p>
        <p>{data.libraryHistory.patronCounts.length} weekday/time rows · {data.libraryHistory.sectionObservations.toLocaleString()} section observations.</p>
        <p className="source-caption">Counting method: {data.libraryHistory.countingMethod}.</p>
        <a href={data.libraryHistory.sourceUrl} target="_blank" rel="noreferrer">Library data source</a>
        <h3>Walking, fitness, and sports</h3>
        <EvidenceList evidence={data.signals} />
        <details><summary>Model assumptions</summary><ul className="source-assumptions">{data.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></details>
      </details>
    </div>
  );
}
