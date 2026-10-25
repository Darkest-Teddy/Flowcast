import type { AgentAnswer } from '../../../map-client/src/askClient';
import { mapLink } from './mapLink.ts';

/** Frame the actual result, never replay a follow-up question or personal transcript in a URL. */
export function answerMapLink(mapUrl: string, points: [number, number][]): string | null {
  const valid = points.filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
  if (!valid.length) return null;
  const lngs = valid.map(([lng]) => lng);
  const lats = valid.map(([, lat]) => lat);
  const span = Math.max(Math.max(...lngs) - Math.min(...lngs), Math.max(...lats) - Math.min(...lats));
  const zoom = span < 0.002 ? 17.6 : span < 0.006 ? 16.6 : 15.8;
  const lng = ((Math.min(...lngs) + Math.max(...lngs)) / 2).toFixed(5);
  const lat = ((Math.min(...lats) + Math.max(...lats)) / 2).toFixed(5);
  return mapLink(mapUrl, { lng, lat, zoom: String(zoom), spin: '0' });
}

export function remoteAnswerPoints(answer: AgentAnswer): [number, number][] {
  return [...(answer.show?.route?.path ?? []), ...(answer.show?.points ?? [])];
}
