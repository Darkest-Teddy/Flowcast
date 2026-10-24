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
