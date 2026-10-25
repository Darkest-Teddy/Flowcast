import { useSearchParams } from 'react-router';
import { crowdFor, crowdScale } from '@theme/tokens';
import { api, locationName, useResource } from '../data/api';
import type { HourlyForecast } from '../data/types';
import type { HourFigure, PlaceWeek } from '@map/bestTimes';
import { formatHour, formatPercent, formatWeekday } from '../lib/format';
import { Button, CrowdMeter, EmptyState, ExportMenu, ListRow, Loading, Page, PageHeader, SectionHeading, SectionList, SelectField } from '../ui';
import { download, exportName, toCsv } from '../lib/exportData';
import { HourlyChart } from './student/HourlyChart';
import { CrowdReportNow, PRIVACY_NOTE, StudentReports, useCrowdReports } from './student/CrowdReport';
import styles from './Forecasts.module.css';

const peakOf = (f: HourlyForecast) => f.hours.reduce((a, b) => (b.share > a.share ? b : a));
const quietestOf = (f: HourlyForecast) => f.hours.reduce((a, b) => (b.share < a.share ? b : a));
const describe = (share: number) => `${formatPercent(share)} ${crowdFor(share).label}`;

/** "Tue 9 AM", in the reader's locale. */
const when = (h: HourFigure) => `${formatWeekday(`${h.date}T12:00:00`)} ${formatHour(h.hour)}`;
const figure = (week: PlaceWeek, h: HourFigure) => (week.measure === 'share' && h.share !== null ? describe(h.share) : `${h.students} simulated students`);

/**
 * Best times this week: the quietest open hour of each of the next seven days for one place, or
 * every place's quietest hour of the week. Model-derived; only hours open by published hours.
 */
function BestTimes({ weeks, selected, name }: { weeks: PlaceWeek[]; selected: string; name: (id: string) => string }) {
  const week = weeks.find((w) => w.locationId === selected);
  if (selected !== 'all' && !week) return null;
  const basis = week?.basis ?? weeks[0]?.basis;
  return (
    <section className={styles.best} aria-labelledby="best-times">
      <SectionHeading><span id="best-times">Best times this week</span></SectionHeading>
      {week ? (
        <>
          <ol className={styles.strip} aria-label={`Quietest open hour each day at ${name(week.locationId)}`}>
            {week.byDay.map((d) => {
              const unknown = week.daysWithoutHours.includes(d.date);
              const best = week.quietest.some((q) => q.date === d.date && q.hour === d.quietest?.hour);
              return (
                <li key={d.date} className={`${styles.day} ${best ? styles.bestDay : ''}`}>
                  <span className={styles.dayName}>{formatWeekday(`${d.date}T12:00:00`)}</span>
                  {d.quietest ? (
                    <>
                      <strong>{formatHour(d.quietest.hour)}</strong>
                      {week.measure === 'share' && d.quietest.share !== null
                        ? <CrowdMeter share={d.quietest.share} showBar={false} />
                        : <span className={styles.dayNote}>{d.quietest.students} students</span>}
                    </>
                  ) : (
                    <span className={styles.dayNote}>{unknown ? 'Hours not published' : 'No open hours'}</span>
                  )}
                </li>
              );
            })}
          </ol>
          <p className={styles.summary}>
            {week.quietest[0] && <>Quietest <strong>{when(week.quietest[0])}</strong>, {figure(week, week.quietest[0])}</>}
            {week.busiest[0] && <span className={styles.sep}>Busiest {when(week.busiest[0])}, {figure(week, week.busiest[0])}</span>}
          </p>
        </>
      ) : (
        <SectionList title="Quietest open hour this week">
          {weeks.map((w) => w.quietest[0] && (
            <ListRow
              key={w.locationId}
              title={name(w.locationId)}
              subtitle={`Quietest ${when(w.quietest[0])}${w.busiest[0] ? ` · busiest ${when(w.busiest[0])}` : ''}`}
              trailing={w.measure === 'share' && w.quietest[0].share !== null ? <CrowdMeter share={w.quietest[0].share} /> : `${w.quietest[0].students} students`}
            />
          ))}
        </SectionList>
      )}
      {basis && <p className={styles.bestBasis}>{basis} Days without published hours are left blank, never called quiet.</p>}
    </section>
  );
}

function Legend() {
  let from = 0;
  return (
    <ul className={styles.legend} aria-label="Crowd levels">
      {crowdScale.map((s) => {
        const range = Number.isFinite(s.upTo) ? `${formatPercent(from)} to ${formatPercent(s.upTo)}` : `${formatPercent(from)} and up`;
        from = s.upTo;
        return (
          <li key={s.level}>
            <i style={{ background: s.color }} aria-hidden />
            {s.label}
            <span className={styles.range}>{range}</span>
          </li>
        );
      })}
    </ul>
  );
}

export default function Forecasts() {
  const locations = useResource(api.getLocations);
  const hourly = useResource(api.getHourlyForecasts);
  const bestTimes = useResource(api.getBestTimes);
  const reports = useCrowdReports();
  const [params, setParams] = useSearchParams();

  const forecasts = hourly.data?.filter((f) => f.hours.length) ?? [];
  const requested = params.get('place');
  const selected = forecasts.some((f) => f.locationId === requested) ? requested! : 'all';
  const shown = selected === 'all' ? forecasts : forecasts.filter((f) => f.locationId === selected);
  const name = (id: string) => locationName(locations.data, id);

  const header = <PageHeader title="Forecasts" description="Modeled crowds, not live occupancy." />;

  if (hourly.error) {
    return (
      <Page>
        {header}
        <EmptyState title="Forecasts didn't load" body={hourly.error.message} action={<Button onClick={hourly.reload}>Try again</Button>} />
      </Page>
    );
  }
  if (!hourly.data) {
    return (
      <Page>
        {header}
        <Loading label="Loading forecasts" />
      </Page>
    );
  }
  if (!forecasts.length) {
    return (
      <Page>
        {header}
        <EmptyState title="No forecasts yet" body="The bundled model has no comparable open-hour projections for today. See Event impact to explore other dates." />
        {!!bestTimes.data?.length && <BestTimes weeks={bestTimes.data} selected="all" name={(id) => locationName(locations.data, id, false)} />}
      </Page>
    );
  }

  const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
  const exportOptions = [
    {
      label: 'Hourly forecasts (CSV)',
      detail: selected === 'all' ? `Every hour at all ${shown.length} places` : `Every hour at ${name(selected)}`,
      run: () => download(exportName(selected === 'all' ? 'forecasts' : `forecast-${selected}`, 'csv'), toCsv(
        ['place', 'place_id', 'date', 'hour_boston', 'projected_share', 'projected_percent', 'level', 'basis'],
        shown.flatMap((f) => f.hours.map((h) => [locationName(locations.data, f.locationId, false), f.locationId, f.day, hourLabel(h.hour),
          Number(h.share.toFixed(4)), Math.round(h.share * 100), crowdFor(h.share).label, f.basis ?? ''])),
      ), 'text/csv'),
    },
    ...(bestTimes.data?.length ? [{
      label: 'Best times this week (CSV)',
      detail: 'Quietest and busiest open hour, each day',
      run: () => download(exportName('best-times', 'csv'), toCsv(
        ['place', 'place_id', 'date', 'quietest_hour_boston', 'quietest_share', 'busiest_hours_this_week', 'measure'],
        bestTimes.data!.filter((w) => selected === 'all' || w.locationId === selected).flatMap((w) => w.byDay.map((d) => [
          locationName(locations.data, w.locationId, false), w.locationId, d.date,
          d.quietest ? hourLabel(d.quietest.hour) : '', d.quietest?.share ?? '',
          w.busiest.map((b) => `${b.date} ${hourLabel(b.hour)}`).join('; '), w.measure,
        ])),
      ), 'text/csv'),
    }] : []),
  ];

  return (
    <Page>
      <PageHeader title="Forecasts" description="Modeled crowds, not live occupancy." actions={<ExportMenu options={exportOptions} />} />
      <div className={styles.controls}>
        <SelectField label="Place" value={selected} onChange={(event) => setParams(event.target.value === 'all' ? {} : { place: event.target.value }, { replace: true })}>
          <option value="all">All places</option>
          {forecasts.map((f) => <option key={f.locationId} value={f.locationId}>{name(f.locationId)}</option>)}
        </SelectField>
        <Legend />
      </div>

      {!!bestTimes.data?.length && <BestTimes weeks={bestTimes.data} selected={selected} name={(id) => locationName(locations.data, id, false)} />}

      {shown.some(f => f.basis) && <details className={styles.basis}>
        <summary>About these projections</summary>
        {[...new Set(shown.map(f => f.basis).filter(Boolean))].map(basis => <p key={basis}>{basis}</p>)}
        <p>“Students reported” lines are separate: anonymous Quiet, OK or Packed answers from students over the last week, shown as they are and never used to change the projections. {PRIVACY_NOTE}</p>
      </details>}

      <div className={`${styles.places} ${selected === 'all' ? styles.grid : ''}`}>
        {shown.map((f) => {
          const peak = peakOf(f);
          const quiet = quietestOf(f);
          const full = locationName(locations.data, f.locationId, false);
          return (
            <section key={f.locationId} className={styles.place}>
              <header className={styles.placeHead}>
                <h2>{full}</h2>
                <p className={styles.summary}>
                  Peak <strong>{describe(peak.share)}</strong> at {formatHour(peak.hour)}
                  <span className={styles.sep}>Quietest {describe(quiet.share)} at {formatHour(quiet.hour)}</span>
                </p>
                <StudentReports summary={reports} locationId={f.locationId} />
              </header>
              <HourlyChart hours={f.hours} label={`Hourly forecast for ${full}`} tall={selected !== 'all'} />
              {selected !== 'all' && (
                <details className={styles.hourList}>
                  <summary>Hour-by-hour values</summary>
                  <SectionList title="Hour by hour">
                    {f.hours.map((h) => (
                      <ListRow key={h.hour} title={formatHour(h.hour)} trailing={<CrowdMeter share={h.share} />} />
                    ))}
                  </SectionList>
                </details>
              )}
              {selected !== 'all' && <CrowdReportNow locationId={f.locationId} name={full} />}
            </section>
          );
        })}
      </div>
    </Page>
  );
}
