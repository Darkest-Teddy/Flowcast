// A meteor's toll on venue-event visitors (fans walking to or from a game, and those inside an
// open-air venue such as Fenway Park). Visitors are their own population (sim/visitors.ts), never
// students, so their outcomes are counted separately from the student casualties. The same
// illustrative, uncalibrated meteor rules apply to people in the open (sim/casualties.ts).
import type { CasualtyEvent } from './casualties';
import { CASUALTY_ASSUMPTIONS } from './casualties';
import { DAMAGE_ASSUMPTIONS, damageSeed } from './disasterDamage';
import { eventVisitorsAt, type VisitorPlan } from './visitors';

/** Fans inside a venue stand somewhere within this distance of its centre (Fenway's stands and field). */
const VENUE_SPREAD_METRES = 90;
/** Most fan fatalities kept as ragdolls (nearest the impact); everyone is still counted. */
const MAX_RAGDOLL_EVENTS = 300;

export interface FanCasualties {
  /** Every fan hit, by visitor id: drawn walkers with these ids stop appearing from `at` on. */
  harmed: Map<string, number>;
  /** Fan fatalities nearest the impact, for ragdolls. */
  ragdolls: CasualtyEvent[];
  injured: number;
  fatalities: number;
  /** When the impact front has passed everyone it reaches. */
  settledAt: number;
}

export const NO_FAN_CASUALTIES: FanCasualties = { harmed: new Map(), ragdolls: [], injured: 0, fatalities: 0, settledAt: 0 };

const KX = 111_320 * Math.cos((42.35 * Math.PI) / 180), KY = 111_320;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Fans hit by a meteor striking `impact` at `start` with `radiusMetres`. Deterministic. */
export function fanCasualties(plan: VisitorPlan, impact: [number, number], radiusMetres: number, start: number, key: string): FanCasualties {
  if (!plan.events.length || radiusMetres <= 0) return NO_FAN_CASUALTIES;
  const q = CASUALTY_ASSUMPTIONS.meteor, m = DAMAGE_ASSUMPTIONS.meteor;
  const harmed = new Map<string, number>();
  const killed: { event: CasualtyEvent; distance: number }[] = [];
  let injured = 0, fatalities = 0;
  const expose = (id: string, position: [number, number]) => {
    const distance = Math.hypot((position[0] - impact[0]) * KX, (position[1] - impact[1]) * KY);
    if (distance > radiusMetres) return;
    const u = clamp01(distance / radiusMetres);
    const severity = u < m.innerFraction ? 1 : 0.1 + 0.8 * clamp01(1 - (u - m.innerFraction) / (1 - m.innerFraction));
    const seed = `${id}|meteor|${start}|${key}`;
    if (q.outdoorHarm * severity < damageSeed(seed)) return;
    const at = start + u * m.impactSeconds;
    harmed.set(id, at);
    if (damageSeed(`${seed}|outcome`) < q.fatalityShareBase + q.fatalityShareCollapse * severity) {
      fatalities++;
      killed.push({ event: { agentId: id, outcome: 'fatality', at, position, cause: 'meteor' }, distance });
    } else injured++;
  };
  // Walking to or from a venue at the impact.
  for (const walker of eventVisitorsAt(start, plan).walkers) expose(walker.id, [walker.position[0], walker.position[1]]);
  // Inside a venue near the impact: arrived and not yet left, spread over the stands.
  for (const e of plan.events) {
    const venueDistance = Math.hypot((e.venue[0] - impact[0]) * KX, (e.venue[1] - impact[1]) * KY);
    if (venueDistance > radiusMetres + VENUE_SPREAD_METRES) continue;
    for (let i = 0; i < e.n && e.arrive[i] <= start; i++) {
      if (e.depart[i] <= start) continue;
      const id = `visitor:${e.slot}:${i}`;
      const angle = damageSeed(`${id}|seat-angle`) * 2 * Math.PI, r = Math.sqrt(damageSeed(`${id}|seat-r`)) * VENUE_SPREAD_METRES;
      expose(id, [e.venue[0] + (Math.cos(angle) * r) / KX, e.venue[1] + (Math.sin(angle) * r) / KY]);
    }
  }
  killed.sort((a, b) => a.distance - b.distance || (a.event.agentId < b.event.agentId ? -1 : 1));
  return { harmed, ragdolls: killed.slice(0, MAX_RAGDOLL_EVENTS).map((k) => k.event), injured, fatalities, settledAt: start + m.impactSeconds };
}
