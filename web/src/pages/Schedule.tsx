import { api, useResource } from '../data/api';
import type { ScheduleItem } from '../data/types';
import { bostonDay, bostonDayLabel, bostonTime } from '../lib/departure';
import { Button, EmptyState, ExportMenu, Loading, Page, PageHeader, SectionList } from '../ui';
import { download, exportName, toCsv, toIcs } from '../lib/exportData';
import { useDepartureClock } from './student/DepartureCard';
import { ScheduleCheckSection } from './student/ScheduleCheck';
import styles from './Schedule.module.css';

export default function Schedule() {
  const locations = useResource(api.getLocations);
  const schedule = useResource(api.getSchedule);
  const now = useDepartureClock();
  const header = <PageHeader title="Schedule" description="Imported classes · all times in Boston."
    actions={<Button to="/calendars">Import or update .ics</Button>} />;
  if (schedule.error) return <Page>{header}<EmptyState title="Your schedule didn't load" body={schedule.error.message}
    action={<Button onClick={schedule.reload}>Try again</Button>} /></Page>;
  if (!schedule.data) return <Page>{header}<Loading label="Loading your schedule" /></Page>;
  const today = bostonDay(now);
  const groups = new Map<string, ScheduleItem[]>([[today, []]]);
  for (const item of [...schedule.data].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    if (!Number.isFinite(Date.parse(item.start))) continue;
    const day = bostonDay(item.start);
    if (day < today) continue;
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(item);
  }
  const placeOf = (item: ScheduleItem) => item.locationText || locations.data?.find((location) => location.id === item.locationId)?.name || '';
  const classes = [...schedule.data].filter((item) => Number.isFinite(Date.parse(item.start))).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const exportOptions = [
    {
      label: 'Classes (CSV)',
      detail: `All ${classes.length} imported classes`,
      run: () => download(exportName('schedule', 'csv'), toCsv(
        ['title', 'start', 'end', 'location', 'campus_place_id'],
        classes.map((c) => [c.title, c.start, c.end, placeOf(c), c.locationId || '']),
      ), 'text/csv'),
    },
    {
      label: 'Classes (calendar)',
      detail: '.ics for Google, Apple or Outlook',
      run: () => download(exportName('schedule', 'ics'), toIcs('Flowcast classes', classes.map((c) => ({
        uid: c.id, title: c.title, start: c.start, end: c.end, location: placeOf(c) || null,
      }))), 'text/calendar'),
    },
  ];
  return <Page><PageHeader title="Schedule" description="Imported classes · all times in Boston."
    actions={<>{classes.length > 0 && <ExportMenu options={exportOptions} />}<Button to="/calendars">Import or update .ics</Button></>} /><div className={styles.days}>
    <ScheduleCheckSection items={schedule.data} locations={locations.data ?? (locations.error ? [] : null)} now={now} />
    {[...groups].map(([day, items]) => <SectionList key={day}
      title={bostonDayLabel(items[0]?.start ?? now, now)} count={items.length} empty="No imported classes for this day.">
      {items.map((item) => <div key={item.id} className={styles.row}>
        <div className={styles.time}><time dateTime={item.start}>{bostonTime(item.start)}</time>
          <time dateTime={item.end}>{bostonTime(item.end)}</time></div>
        <div className={styles.main}><strong>{item.title}</strong>
          <p>{item.locationText || locations.data?.find((location) => location.id === item.locationId)?.name || 'Building not mapped'}</p>
          {Date.parse(item.start) <= now && Date.parse(item.end) > now && <p>In progress</p>}
        </div>
      </div>)}
    </SectionList>)}
  </div></Page>;
}
