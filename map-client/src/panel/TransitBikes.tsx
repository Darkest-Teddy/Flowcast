/*
 * Analytics, Transit and Bikes: how you get around, three rows at a time.
 *
 * Both replace a table. A table of every stop and every dock answers "show me
 * the data"; standing on a map at 4pm the question is "what is the next train
 * from the stop I am next to", and that is three rows. The rest is reachable
 * through the search above, which is why the full tables could go.
 *
 * Presentational. The arrival figures and dock estimates are computed by the
 * callers that own the feeds; these components only lay them out.
 */

import type { ReactNode } from 'react';

/** One Green Line stop, with the next train each way. */
export interface StopRow {
  id: string;
  name: string;
  /** The branch letter where several stop here (Kenmore is B, C and D). */
  branches: string[];
  /** Minutes until the next train, already formatted, or null for none due. */
  inbound: string | null;
  outbound: string | null;
}

/** One BU Shuttle stop and where the next bus from it is going. */
export interface ShuttleRow {
  id: string;
  stop: string;
  destination: string;
  due: string;
}

/** One Bluebikes dock, as estimated for the shown time. */
export interface DockRow {
  id: string;
  name: string;
  bikes: number;
  ebikes: number;
  empty: number;
  /** True when the figure is an estimate rather than a live count. */
  estimated: boolean;
}

export function TransitPanel({
  stops,
  shuttles,
  note,
  onSelect,
}: {
  stops: StopRow[];
  shuttles: ShuttleRow[];
  /** Whether this is live or a playback timetable, in a few words. */
  note: string;
  onSelect?: (id: string) => void;
}) {
  return (
    <>
      <div className="pn-head">
        <p className="pn-label">Green Line · nearest stops</p>
        <span className="pn-now">{note}</span>
      </div>

      <div className="pn-card">
        {stops.length === 0 && <p className="pn-empty">No Green Line stops on this campus.</p>}
        <ol className="pn-rows">
          {stops.map((s) => (
            <li key={s.id}>
              <Row onSelect={onSelect && (() => onSelect(s.id))}>
                <span className="pn-roundel pn-roundel--t">{s.branches.length === 1 ? s.branches[0] : 'T'}</span>
                <span className="pn-name">{s.name}</span>
                <span className="pn-two">
                  <span>
                    In <b>{s.inbound ?? '—'}</b>
                  </span>
                  <span>
                    Out <b>{s.outbound ?? '—'}</b>
                  </span>
                </span>
              </Row>
            </li>
          ))}
        </ol>
      </div>

      {shuttles.length > 0 && (
        <>
          <p className="pn-label">BU Shuttle</p>
          <div className="pn-card">
            <ol className="pn-rows">
              {shuttles.map((s) => (
                <li key={s.id}>
                  <Row onSelect={onSelect && (() => onSelect(s.id))}>
                    <span className="pn-roundel pn-roundel--bu">BU</span>
                    <span className="pn-name">
                      {s.stop} <span className="pn-to">to {s.destination}</span>
                    </span>
                    <span className="pn-value">
                      <b>{s.due}</b>
                    </span>
                  </Row>
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
    </>
  );
}

export function BikesPanel({
  docks,
  total,
  rate,
  peak,
  onSelect,
}: {
  docks: DockRow[];
  /** How many docks exist in all, so the footnote can say what search reaches. */
  total: number;
  rate: number | null;
  peak: string | null;
  onSelect?: (id: string) => void;
}) {
  return (
    <>
      <div className="pn-head">
        <p className="pn-label">Nearest docks</p>
        {rate !== null && (
          <span className="pn-now">
            {rate}/h{peak && ` · peak ${peak}`}
          </span>
        )}
      </div>

      <div className="pn-card">
        {docks.length === 0 && <p className="pn-empty">No Bluebikes docks near this campus.</p>}
        <ol className="pn-rows">
          {docks.map((d) => (
            <li key={d.id}>
              <Row onSelect={onSelect && (() => onSelect(d.id))}>
                <span className="pn-tile pn-tile--plain" dangerouslySetInnerHTML={{ __html: BIKE }} />
                <span className="pn-name">{d.name}</span>
                <span className="pn-counts">
                  <b>
                    {d.estimated && '≈'}
                    {d.bikes}
                  </b>
                  {d.ebikes > 0 && (
                    <span className="pn-ebike">
                      <span dangerouslySetInnerHTML={{ __html: BOLT }} />
                      {d.ebikes}
                    </span>
                  )}
                  <span className="pn-empty-count">{d.empty} empty</span>
                </span>
              </Row>
            </li>
          ))}
        </ol>
      </div>

      <p className="pn-foot">
        Estimated for the playback time. Search to find any of the {total} docks.
      </p>
    </>
  );
}

/** A row that is a button only when there is somewhere for it to go. */
function Row({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) {
  if (!onSelect) return <span className="pn-row pn-row--static">{children}</span>;
  return (
    <button type="button" className="pn-row" onClick={onSelect}>
      {children}
    </button>
  );
}

const BIKE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="6" cy="16.5" r="3.5"/><circle cx="18" cy="16.5" r="3.5"/><path d="m6 16.5 4-8h5l3 8M10 8.5h5.5"/></svg>';

const BOLT =
  '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>';
