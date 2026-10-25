/*
 * Analytics, Places: the campus measured, as a list you can actually scan.
 *
 * This replaces a page of prose and a ranking of eight with four things in a
 * fixed order: how many people are moving, which kind of place you care about,
 * whether you want the quietest or the busiest, and three rows. Three, because
 * the question behind this panel is almost always "where should I go", and the
 * fourth-best answer has never changed anyone's mind. "Show all" opens the rest
 * inside the card for the times it does.
 *
 * Presentational: every piece of state is a prop, and the only thing it computes
 * is the display of a level, which comes from the one crowd scale.
 */

import { activityDisplay, ICONS, PERSON_ICONS } from '../BuildingTags';
import type { CampusLocation, LocationKind } from '../sim/playback';
import { displayName } from '../tags/names';

/** One campus place, as the simulation currently sees it. */
export interface PlaceEntry {
  location: CampusLocation;
  count: number;
  share: number;
  modeled?: boolean;
  /** Closed right now by its published hours. */
  closed?: boolean;
  opens?: string;
}

/** Which kinds the category row offers, in the handoff's order. */
export type Category = 'all' | LocationKind;

/*
 * Each category names itself in the plural, because the footer button reads
 * "Show all 14 dining halls" and a label that only works in a heading is no use
 * there. The hue is the icon's, never the label's (styles: §7).
 */
const CATEGORIES: { id: Category; label: string; plural: string; hue: string }[] = [
  { id: 'all', label: 'All', plural: 'places', hue: 'neutral' },
  { id: 'dining', label: 'Dining', plural: 'dining halls', hue: 'green' },
  { id: 'library', label: 'Study', plural: 'study spots', hue: 'violet' },
  { id: 'gym', label: 'Gym', plural: 'gyms', hue: 'orange' },
  { id: 'classroom', label: 'Classes', plural: 'academic buildings', hue: 'teal' },
  { id: 'dorm', label: 'Housing', plural: 'residences', hue: 'pink' },
];

/** The campus glyph stands in for All: the people icons belong to the crowd scale. */
const ALL_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 7z"/><path d="M9 4v13M15 7v12.5"/></svg>';

/** Rows shown closed, and the ceiling when the card is opened. */
export const CLOSED_ROWS = 3;
export const OPEN_ROWS = 8;

export function display(entry: PlaceEntry) {
  return activityDisplay({
    count: entry.count,
    capacity: entry.location.capacity,
    share: entry.share,
    modeled: entry.modeled ?? entry.location.activityModeled,
    capacityBasis: entry.location.capacityBasis,
    kind: entry.location.kind,
    allowZero: entry.location.estimatedProfile?.purpose === 'rowing',
    closed: entry.closed,
    opens: entry.opens,
  });
}

/*
 * Everything in a category, quietest or busiest first. `entries` arrives
 * busiest first, so Busiest is the identity and Quietest is the reverse.
 *
 * Places the model has no figure for go last either way. Reversing the list put
 * them at the top of Quietest, which reads as a recommendation: a building with
 * no modelled occupancy is not the quietest place on campus, it is a building we
 * cannot speak for, and answering "where is quiet" with one is worse than
 * answering with nothing.
 */
export function orderPlaces(entries: PlaceEntry[], category: Category, sort: 'quiet' | 'busy') {
  const inCategory = category === 'all' ? entries : entries.filter((e) => e.location.kind === category);
  const known = inCategory.filter((e) => display(e).hasPercentage);
  const unknown = inCategory.filter((e) => !display(e).hasPercentage);
  return [...(sort === 'busy' ? known : [...known].reverse()), ...unknown];
}

export function PlacesPanel({
  entries,
  query,
  category,
  onCategory,
  sort,
  onSort,
  expanded,
  onExpand,
  selected,
  onSelect,
  pulse,
  clock,
}: {
  entries: PlaceEntry[];
  /** The live search, so an empty list can say which kind of empty it is. */
  query: string;
  category: Category;
  onCategory: (c: Category) => void;
  sort: 'quiet' | 'busy';
  onSort: (s: 'quiet' | 'busy') => void;
  expanded: boolean;
  onExpand: (v: boolean) => void;
  /** The building id (`location.building`) currently selected on the map. */
  selected: string | null;
  onSelect: (entry: PlaceEntry) => void;
  /** The three counts above the list: walking, waiting at stops, riding. */
  pulse: { walking: number; stops: number; bikes: number };
  clock: string;
}) {
  const ordered = orderPlaces(entries, category, sort);
  const shown = ordered.slice(0, expanded ? OPEN_ROWS : CLOSED_ROWS);
  const meta = CATEGORIES.find((c) => c.id === category)!;

  return (
    <>
      {/* The pulse: the three numbers that used to be a sentence under the title. */}
      <div className="pn-pulse">
        <Tile icon={PERSON_ICONS.person1} value={pulse.walking} label="walking" />
        <Tile icon={STOP_ICON} value={pulse.stops} label="at stops" />
        <Tile icon={BIKE_ICON} value={pulse.bikes} label="on bikes" />
      </div>

      <div className="pn-cats" role="group" aria-label="Kind of place">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            data-hue={c.hue}
            aria-pressed={category === c.id}
            onClick={() => {
              onCategory(c.id);
              // A new category is a new list; keeping it open would scroll the
              // user into rows they never asked to see.
              onExpand(false);
            }}
          >
            <span className="pn-cat-icon" dangerouslySetInnerHTML={{ __html: c.id === 'all' ? ALL_ICON : ICONS[c.id as LocationKind] }} />
            {c.label}
          </button>
        ))}
      </div>

      <div className="pn-sortrow">
        <div className="pn-sort" role="group" aria-label="Order">
          <button type="button" aria-pressed={sort === 'quiet'} onClick={() => onSort('quiet')}>
            Quietest
          </button>
          <button type="button" aria-pressed={sort === 'busy'} onClick={() => onSort('busy')}>
            Busiest
          </button>
        </div>
        <span className="pn-now">now · {clock}</span>
      </div>

      <div className="pn-card">
        <ol className={expanded ? 'pn-rows is-open' : 'pn-rows'}>
          {shown.map((entry) => (
            <PlaceRow
              key={entry.location.id}
              entry={entry}
              selected={entry.location.building === selected}
              onSelect={() => onSelect(entry)}
            />
          ))}
          {shown.length === 0 && (
            <li className="pn-empty">
              {query ? 'No matches. Try a building code like CAS.' : 'Nothing modelled in this category yet.'}
            </li>
          )}
        </ol>

        {ordered.length > CLOSED_ROWS && (
          <button type="button" className="pn-more" onClick={() => onExpand(!expanded)}>
            {expanded ? `Show top ${CLOSED_ROWS}` : `Show all ${Math.min(ordered.length, OPEN_ROWS)} ${meta.plural}`}
          </button>
        )}
      </div>
    </>
  );
}

/*
 * One place. The grid is tile, name, figure, chevron, with the bar spanning the
 * middle two so it measures the name and the number rather than the whole row.
 */
export function PlaceRow({
  entry,
  selected,
  onSelect,
}: {
  entry: PlaceEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const d = display(entry);
  return (
    <li>
      <button type="button" className="pn-row" aria-pressed={selected} onClick={onSelect} style={d.style}>
        <span className="pn-tile" dangerouslySetInnerHTML={{ __html: d.icon || ICONS[entry.location.kind] || '' }} />
        <span className="pn-name">{displayName(entry.location.name)}</span>
        <span className="pn-value">
          <b>{d.primary}</b>
          {d.secondary && <span> · {d.secondary}</span>}
        </span>
        <span className="pn-chev" aria-hidden="true">
          ›
        </span>
        {d.hasPercentage && (
          <span className="pn-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(3, Math.min(100, d.percent))}%` }} />
          </span>
        )}
      </button>
    </li>
  );
}

function Tile({ icon, value, label }: { icon: string; value: number; label: string }) {
  return (
    <div className="pn-tile-stat">
      <span className="pn-tile-icon" dangerouslySetInnerHTML={{ __html: icon }} />
      <b>{value.toLocaleString()}</b>
      <span>{label}</span>
    </div>
  );
}

const STOP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 11h14M8.5 19.5 7 17M15.5 19.5 17 17"/></svg>';

const BIKE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="6" cy="16.5" r="3.5"/><circle cx="18" cy="16.5" r="3.5"/><path d="m6 16.5 4-8h5l3 8M10 8.5h5.5"/></svg>';
