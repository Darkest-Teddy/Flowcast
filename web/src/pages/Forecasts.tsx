import { useSearchParams } from 'react-router';
import { crowdFor, crowdScale } from '@theme/tokens';
import { api, locationName, useResource } from '../data/api';
import type { HourlyForecast } from '../data/types';
import { formatHour, formatPercent } from '../lib/format';
import { Button, CrowdMeter, EmptyState, ListRow, Loading, Page, PageHeader, SectionList, Segmented } from '../ui';
import { HourlyChart } from './student/HourlyChart';
import styles from './Forecasts.module.css';

const peakOf = (f: HourlyForecast) => f.hours.reduce((a, b) => (b.share > a.share ? b : a));
const quietestOf = (f: HourlyForecast) => f.hours.reduce((a, b) => (b.share < a.share ? b : a));
const describe = (share: number) => `${formatPercent(share)} ${crowdFor(share).label}`;

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
  const [params, setParams] = useSearchParams();

  const forecasts = hourly.data?.filter((f) => f.hours.length) ?? [];
  const requested = params.get('place');
  const selected = forecasts.some((f) => f.locationId === requested) ? requested! : 'all';
  const shown = selected === 'all' ? forecasts : forecasts.filter((f) => f.locationId === selected);
  const name = (id: string) => locationName(locations.data, id);

  const header = <PageHeader title="Forecasts" description="How full each place is likely to be today, hour by hour." />;

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
        <EmptyState title="No forecasts yet" body="Forecasts appear once the crowd model has been trained on the simulated week." />
      </Page>
    );
  }

  return (
    <Page>
      {header}
      <div className={styles.controls}>
        <Segmented
          label="Place"
          value={selected}
          onChange={(v) => setParams(v === 'all' ? {} : { place: v }, { replace: true })}
          options={[{ value: 'all', label: 'All places' }, ...forecasts.map((f) => ({ value: f.locationId, label: name(f.locationId) }))]}
        />
        <Legend />
      </div>

      <div className={styles.places}>
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
              </header>
              <HourlyChart hours={f.hours} label={`Hourly forecast for ${full}`} tall={selected !== 'all'} />
              {selected !== 'all' && (
                <div className={styles.hourList}>
                  <SectionList title="Hour by hour">
                    {f.hours.map((h) => (
                      <ListRow key={h.hour} title={formatHour(h.hour)} trailing={<CrowdMeter share={h.share} />} />
                    ))}
                  </SectionList>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </Page>
  );
}
