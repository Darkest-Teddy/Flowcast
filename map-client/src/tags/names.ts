// Names on the map's building tags and lists: the building's own name, without the suffixes the
// source data uses to tell its parts apart ("Warren Towers (Tower A)", "Student Village 2 (33 Harry
// Agganis Way)"). A parenthetical that names a building or wing ("School of Law (Law Tower)") stays.

/** Trailing "(Tower A)", "(33 Harry Agganis Way)", "(110 Cummington Mall)": part letters and street addresses. */
const PART_OR_ADDRESS = /\s*\((?:tower\s+[a-z]|wing\s+[a-z]|\d[^)]*)\)\s*$/i;

export function displayName(name: string): string {
  return name.replace(PART_OR_ADDRESS, '').trim() || name;
}

/** The short label; falls back to the cleaned name when the short one is just the long name. */
export function displayShort(short: string, name: string): string {
  const cleaned = displayName(short);
  return cleaned === short && short === name ? displayName(name) : cleaned;
}

/** Places that get their own tag when they share a building with something else. */
export const AMENITY_KINDS = new Set(['dining', 'library', 'gym']);

/**
 * A shared building's places, split into the ones its own tag describes (`rest`) and the amenities
 * that get a dot of their own. When every place is an amenity (Mugar Memorial Library holds the
 * Music and African Studies libraries), the largest one is the building's own place, so the
 * building's tag keeps its name instead of taking the name of whichever small library is busiest.
 */
export function sharedTagParts<T extends { location: { id: string; kind: string; capacity: number } }>(places: readonly T[]): { rest: T[]; amenities: T[] } {
  const amenities = places.filter((o) => AMENITY_KINDS.has(o.location.kind));
  const rest = places.filter((o) => !AMENITY_KINDS.has(o.location.kind));
  if (rest.length || amenities.length < 2) return { rest, amenities };
  const main = amenities.reduce((a, o) => (o.location.capacity > a.location.capacity
    || (o.location.capacity === a.location.capacity && o.location.id < a.location.id) ? o : a));
  return { rest: [main], amenities: amenities.filter((o) => o !== main) };
}
