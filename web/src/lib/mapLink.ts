/** Merge a map handoff into the configured URL without losing its query or fragment. */
export function mapLink(mapUrl: string, values: Record<string, string> | URLSearchParams): string {
  const hashAt = mapUrl.indexOf('#');
  const hash = hashAt < 0 ? '' : mapUrl.slice(hashAt);
  const base = hashAt < 0 ? mapUrl : mapUrl.slice(0, hashAt);
  const queryAt = base.indexOf('?');
  const path = queryAt < 0 ? base : base.slice(0, queryAt);
  const params = new URLSearchParams(queryAt < 0 ? '' : base.slice(queryAt + 1));
  const incoming = values instanceof URLSearchParams ? values : new URLSearchParams(values);
  incoming.forEach((value, key) => params.set(key, value));
  const query = params.toString();
  return `${path}${query ? `?${query}` : ''}${hash}`;
}
