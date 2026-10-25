import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { api, useResource } from '../data/api';
import { bostonDate } from '../data/realData';
import type { CampusGeo, CampusLocation, HourlyForecast } from '../data/types';
import { bostonClock } from '../lib/askRouting';
import { answerMapLink } from '../lib/askMapLink';
import { config } from '../config';
import { examLibraryAssumption, examSeasonFor, formatExamDate, rankExamLibraries, roomsWithoutPublishedClass, type ExamSeason } from '../lib/examSeason';
import { formatHour, formatPercent } from '../lib/format';
import { Button, ListRow, SectionList } from '../ui';
import styles from './Study.module.css';

const WEEKDAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const HOURS_AHEAD = 3;
const clockText = (sec: number) => {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/**
 * Exam-season mode (Study Period and finals from the Registrar's calendar): a banner, libraries
 * ranked by projected crowd, and classrooms with no published class in the next hours. Outside
 * exam season it renders nothing, or a one-line hint in the two weeks before. `?examDate=YYYY-MM-DD`
 * previews another date's season (the crowd figures stay today's projection).
 */
export function StudyExamSeason({ now, from, locations, geo, forecasts }: {
  now: number;
  from: string;
  locations: CampusLocation[];
  geo: CampusGeo;
  forecasts: HourlyForecast[];
}) {
  const bundle = useResource(api.getCampusBundle);
  const [params] = useSearchParams();
  const preview = /^\d{4}-\d{2}-\d{2}$/.test(params.get('examDate') ?? '') ? params.get('examDate')! : null;
  const today = bostonDate(new Date(now));
  const date = preview ?? today.day;
  const season: ExamSeason = bundle.data ? examSeasonFor(date, bundle.data.academicCalendar) : { mode: 'off' };
  if (season.mode === 'off') return null;
  if (season.mode === 'upcoming') {
    return <p className={styles.examHint} role="note">
      Exam season starts {formatExamDate(season.window.start)}{season.window.studyStart ? ' with the Study Period' : ''}, {season.daysAway === 1 ? 'tomorrow' : `in ${season.daysAway} days`}. This page will rank libraries and list classrooms with no published class then.
    </p>;
  }
  return <ExamSeasonPanel season={season} date={date} preview={!!preview} now={now} from={from} locations={locations} geo={geo} forecasts={forecasts} bundle={bundle.data!} />;
}

function ExamSeasonPanel({ season, date, preview, now, from, locations, geo, forecasts, bundle }: {
  season: Extract<ExamSeason, { mode: 'active' }>;
  date: string;
  preview: boolean;
  now: number;
  from: string;
  locations: CampusLocation[];
  geo: CampusGeo;
  forecasts: HourlyForecast[];
  bundle: NonNullable<Awaited<ReturnType<typeof api.getCampusBundle>>>;
}) {
  const hours = useResource(api.getPlaceHours);
  const behavior = useResource(api.getBehaviorModifiers);
  const today = bostonDate(new Date(now));
  const { time } = bostonClock(new Date(now));
  const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  const assumption = examLibraryAssumption(behavior.data, season.phase);
  const libraries = useMemo(() => rankExamLibraries({ locations, forecasts, hours: hours.data ?? {}, geo, from, now, day: today.day, hour: today.hour, hoursAhead: HOURS_AHEAD }),
    [locations, forecasts, hours.data, geo, from, now, today.day, today.hour]);
  const buildings = useMemo(() => roomsWithoutPublishedClass({ data: bundle, locations, geo, from, date, weekday, seconds: time, hoursAhead: HOURS_AHEAD }),
    [bundle, locations, geo, from, date, weekday, time]);
  const mapLink = (id: string) => { const p = geo.positions[id]; return p ? answerMapLink(config.mapUrl, [p]) : null; };
  const phase = season.phase === 'finals' ? 'final exams' : 'the Study Period';
  const factors = [assumption.visits && `${assumption.visits}× as many library visits`, assumption.stay && `each about ${assumption.stay}× as long`].filter(Boolean).join(', ');
  const until = (sec: number | null) => (sec === null ? 'no published class for the rest of the day' : `no published class until ${clockText(sec)}`);

  return <section className={styles.exam} aria-labelledby="exam-season-title">
    <div className={styles.examBanner}>
      <p className={styles.availability}>{season.label} · {formatExamDate(season.window.start)} to {formatExamDate(season.window.end)}{preview ? ` · preview for ${formatExamDate(date)}` : ''}</p>
      <h2 id="exam-season-title">Exam season: libraries get busier</h2>
      <p>
        {factors ? `During ${phase}, Flowcast’s conditions model assumes ${factors}, than on a class day. ` : `During ${phase}, Flowcast’s conditions model sends more students to libraries than on a class day. `}
        These are stated assumptions, not counts. The hourly crowd figures below are the typical-week projection for a {WEEKDAY[today.weekday]}; finals projections come from the conditions model, so expect libraries to be busier than shown.
      </p>
    </div>
    <SectionList title="Libraries, quietest projected first" count={libraries.length}
      empty={hours.loading ? 'Loading library hours…' : 'No libraries are mapped.'}>
      {libraries.map((l) => {
        const link = mapLink(l.locationId);
        const crowd = l.peak === null ? 'no crowd projection now'
          : `typical week ${l.now === null ? '' : `${formatPercent(l.now)} now, `}up to ${formatPercent(l.peak)}${l.peakHour === null ? '' : ` by ${formatHour(l.peakHour)}`}; rises in exam season`;
        return <ListRow key={l.locationId} title={l.name}
          subtitle={[l.open === true ? 'Open now' : l.open === false ? 'Closed now' : 'Hours unconfirmed', crowd, l.walk === null ? '' : `${l.walk} min walk`].filter(Boolean).join(' · ')}
          trailing={link && <Button href={link} size="sm" variant="ghost">View on map</Button>} />;
      })}
    </SectionList>
    <SectionList title={`Classrooms with no published class, next ${HOURS_AHEAD} hours`} count={buildings.length}
      empty="Every classroom in the published schedule has a class in the next hours.">
      {buildings.slice(0, 6).map((b) => {
        const link = mapLink(b.locationId);
        const sample = b.rooms.slice(0, 3).map((r) => `${r.roomCode} (${r.floor}${r.seats ? `, ${r.seats} seats` : ''}): ${until(r.nextClassAt)}`).join('; ');
        return <ListRow key={b.locationId} title={`${b.buildingCode} · ${b.name}`}
          subtitle={[`${b.rooms.length} ${b.rooms.length === 1 ? 'room' : 'rooms'} with no published class`, b.walk === null ? '' : `${b.walk} min walk`, sample].filter(Boolean).join(' · ')}
          trailing={link && <Button href={link} size="sm" variant="ghost">View on map</Button>} />;
      })}
    </SectionList>
    <p className={styles.muted}>
      “No published class” only means the published class schedule lists nothing there. Final-exam rooms and times aren’t published per room, so a room may still hold an exam, an event or office hours, or be locked. Regular classes end with the last day of classes; floors are read from room numbers.
    </p>
  </section>;
}
