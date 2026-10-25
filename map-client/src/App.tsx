import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { PickingInfo } from '@deck.gl/core';
import { campusFromUrl, playbackFromUrl } from './map/deepLink';
import { createBasemap, INITIAL_VIEW, TRAFFIC_LEVELS, VIEW_IN_URL, type Basemap, type LightPreset, type ViewPadding } from './map/basemap';
import { HudAsk, HudBrand, HudDate, HudIcons, HudLegend, HudRail, HudStatus, HudTabs, HudTime, type HudTab, type RailItem } from './hud/Chrome';
import { agentLayers, loadCharacterModels, type Character, type LoadedModels } from './layers/agents';
import { crowdLayers, modelRoofHeights, modelVolumes, type RoofHeights } from './layers/crowd';
import { CROWD_LEVELS } from './layers/crowdLevels';
import { activityDisplay, BuildingTags, type BuildingTagsHandle, type TagMode } from './BuildingTags';
import { orderPlaces, PlacesPanel, type Category } from './panel/Places';
import { BuildingDetail, FIRST_HOUR, LAST_HOUR, type HourSample } from './panel/BuildingDetail';
import { BikesPanel, TransitPanel, type DockRow, type ShuttleRow, type StopRow } from './panel/TransitBikes';
import { EventDetail, EventsList, type EventWhen } from './panel/Events';
import { defaultRadius, gathers, radiusLimits, SCENARIOS, WhatIfForm, type ScenarioKind } from './panel/WhatIf';
import { WhatIfCircle, type WhatIfCircleHandle } from './WhatIfCircle';
import { DISASTER_LIMITATIONS, hazardZone } from './sim/disasters';
import './panel/panel.css';
import { TransitTags, type TagMarker, type TransitTagsHandle } from './TransitTags';
import { PlaceTags, placeHitLayers, placeUnder, type PlaceTagsHandle } from './PlaceTags';
import { createPlacer, type Box } from './layers/placement';
import { cullLayers } from './layers/culling';
import { buildingModelLayers, campusBounds, DEFERRED_CAMPUSES, landmarkClips, loadBuildings, loadCampusModels } from './layers/buildings';
import { daylightAt, daylightLabel } from './map/daylight';
import { loadMonuments, monumentLayers } from './layers/monuments';
import { loadSigns, signLayers, signTooltip } from './layers/signs';
import { fieldBuildingIds, fieldLayers, loadFields } from './layers/fields';
import { loadVehicleModels, transitLayers, transitTooltip, type VehicleModels } from './layers/transit';
import { loadStreet, streetLayers, streetTooltip } from './layers/street';
import { boatLayers, boatTooltip, loadBoats } from './layers/boats';
import { Playback, formatClock, loadDay, occupancyShare, type BuildingFootprint, type BuildingOccupancy, type Campus, type Occupancy, type WalkingAgent } from './sim/playback';
import { MbtaFeed, loadTransit, minutesUntil, type TransitData, type TransitSource } from './transit/mbta';
import { loadShuttles } from './transit/buShuttle';
import { trackCorridors } from './transit/tracks';
import { PublishedTransit, loadPublishedSchedule, scheduleCoversDate } from './transit/publishedSchedule';
import { buildPopulation, loadPopulation, type PopulationBase } from './sim/population';
import { advanceTime } from './sim/clock';
import { dateForWeekday, loadCampusData, WEEKDAYS, type CampusData } from './data/campusData';
import { buildSourceDay, type SourceDay } from './sim/sourceDay';
import { weekdayOf } from './sim/gatherings';
import { EventsPanel } from './EventsPanel';
import { createTransitService, mergeSchedules, type TransitService } from './sim/transitService';
import { loadObservations, type CalibrationObservations } from './data/observations';
import { buildPublicCrowd, isPublicId, type PublicCrowd } from './sim/publicCrowd';
import { waitingCharacters, waitingRiderLayers } from './layers/waitingRiders';
import { SourceDataPanel } from './SourceDataPanel';
import { displayName, displayShort, sharedTagParts } from './tags/names';
import { assignNames, type NameLists } from './sim/names';
import type { CampusLocation } from './sim/playback';
import { CameraControls } from './CameraControls';
import { PerfMonitor, type PerfCounts } from './PerfMonitor';
import { WeatherControls } from './WeatherControls';
import { activeWindFromDegrees } from './weather/weather';
import { type ActiveWeather } from './weather/weather';
import { precipitationLayers, setParticleScale } from './weather/precipitation';
import { atmosphereLayers } from './weather/atmosphere';
import { ragdollLayers, ragdollsAt } from './layers/ragdolls';
import { LANDMARK_TARGETS, withLandmarkTarget } from './sim/landmarks';
import { fanCasualties } from './sim/fanCasualties';
import { quality } from './perf/quality';
import { pacer } from './perf/pacer';
import {
  BikeReplay,
  BluebikesFeed,
  activityCurve,
  estimateDock,
  formatDate,
  loadBikes,
  type BikeData,
  type BikeTrip,
  type DockEstimate,
} from './bikes/bluebikes';
import { bikeLayers, bikeTooltip, loadBikeModels } from './layers/bikes';
import { ActivityChart } from './ActivityChart';
import { IntroScreen, createLoadProgress } from './IntroScreen';
import { IntroSky } from './IntroSky';
import { introSound } from './introSound';
import { INTRO_VIEW, introZoom } from './intro';
import { prefersReducedMotion } from './map/camera';
import { loadMobility, mobilityAt, type MobilityData, type MobilityMode, type MobilityView, type MobilityPoint, type MobilityArc } from './data/mobility';
import { mobilityLayers, mobilityTooltip } from './layers/mobility';
import { MobilityPanel } from './MobilityPanel';
// Conditions engine: conditioned days simulated off the main thread, scenarios, explanation.
import { DayEngine, type EngineInput } from './sim/dayEngine';
import { ConditionsPanel, type EngineStatus } from './ConditionsPanel';
import { baselineInput, LIVE, loadScenarios, scenarioInput, type ScenarioFile } from './sim/scenarios';
import { dayWeather } from './sim/conditions';
import type { DayComparison } from './sim/compare';
import type { DayInfo } from './sim/explain';
import { loadOutdoor, type OutdoorFile } from './sim/outdoor';
import { outdoorCount, outdoorIndex, outdoorPeople, type OutdoorIndex } from './layers/outdoor';
import type { WeatherMode } from './weather/weather';
import { IncidentPanel, type IncidentRun } from './IncidentPanel';
import { applyIncident, type IncidentKind } from './sim/incidents';
import { damageAt } from './sim/disasterDamage';
import { damageExclusionAreas, fallbackDamageLayers } from './layers/damageFallback';
import { incidentLayers } from './layers/incidents';
import { METEOR_APPROACH_SECONDS } from './layers/disasterEffects';
import { impactShake } from './layers/impactShake';
import { planFireResponse as planDisasterFireResponse, fireResponseAt } from './sim/disasterFireResponse';
import { fireResponseLayers } from './layers/fireResponse';
import { AskPanel, type AskShow } from './AskPanel';
import { askRouteLayers, type AskRoute } from './layers/askRoute';
import { askMeetings, type AskContext } from './insights';
import { LiveVoice } from './LiveVoice';
import type { DayData, Stay, WalkRoute } from './sim/playback';
import { fireLayers, fireTooltip, loadFireModels, nearestResponding, type FireModels } from './layers/fireTrucks';
import { loadFireNetwork, planFireResponse, roadsNear, signalOracle, type FireNetwork } from './sim/fireResponse';
import { crowdCharacters } from './layers/fireCrowd';
import { segmentsNear } from './sim/fireEvacuation';
import { registeredSignals } from './sim/signals';
import { FireSiren } from './fireSiren';
import { ParkingTags, type ParkingTagsHandle } from './ParkingTags';
import { ParkingPanel } from './ParkingPanel';
import { PHONE_QUERY, Sheet, usePhone, type Detent, type SheetCover } from './Sheet';
import { Popover } from './Popover';
import { parkingLayers, parkingUnder } from './layers/parking';
import { campusParkingEvents, createParkingModel, loadParking, parkingAt, parkingDayKind, type LotState, type ParkingData, type ParkingEvent, type ParkingModel, type ParkingState } from './sim/parking';
import { loadEventSources, type EventSources } from './data/eventCalendar';
import { eventLoadAt, eventLoadLabel, NO_EVENT_DAY, planEventDay, setCurrentEventDay, type EventDay } from './sim/eventAttendance';
import { NO_VISITORS, planVisitors, setCurrentVisitorPlan, visitorFromId, visitorsAt, type VisitorPlan } from './sim/visitors';
import { GAME_ID, withSimulatedGame, type SimulatedGame } from './sim/simulatedGame';
// Joined students (persona/): a phone builds a character at /join, this display draws it, starred.
import { JoinQrCard } from './persona/JoinQrCard';
import { PersonaDetails } from './persona/PersonaDetails';
import { PERSONA_PICK_LAYER_IDS, personaLayers, personaTooltip } from './persona/layers';
import { personaUnder, placePersonas } from './persona/placement';
import { readPersonas, subscribePersonas } from './persona/store';
import type { Persona } from './persona/model';

// The HUD re-renders the app twice a second; these only need to when their own props change.
const MemoPerfMonitor = memo(PerfMonitor);
const MemoCameraControls = memo(CameraControls);
const MemoWeatherControls = memo(WeatherControls);

const SPEEDS = [1, 30, 120, 600];
const COUNTS_KEY = 'flowcast.trafficCounts';
const params = new URLSearchParams(window.location.search);
const playbackLink = playbackFromUrl(params);
/** ?date=2026-11-18 plays that date's campus events on its weekday (projected onto the representative week). */
const URL_DATE = playbackLink.date;
/** ?events=0 starts with campus events off, showing the no-event baseline. */
const START_EVENTS = params.get('events') !== '0';
// Live by default: the simulated day follows the real clock at 1x, so walkers, trains and buses
// all move at their true relative speeds. ?at=, ?speed= or ?date= start in playback mode instead.
const START_LIVE = playbackLink.live;

const BOSTON_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** Seconds since midnight in Boston. */
function wallClockSeconds(): number {
  const now = new Date();
  const parts = BOSTON_CLOCK.format(now).split(':').map(Number);
  return parts[0] * 3600 + parts[1] * 60 + parts[2] + now.getMilliseconds() / 1000;
}

/** ?at=9:00 (24h clock) starts playback there; default is the run-up to the 9:05 class change. */
function startTimeFromUrl(): number {
  return playbackLink.at ?? 8 * 3600 + 50 * 60;
}

const BOSTON_WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
function wallClockWeekday(): number { return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(BOSTON_WEEKDAY.format(new Date())); }
const START_WEEKDAY = START_LIVE ? wallClockWeekday() : URL_DATE ? weekdayOf(URL_DATE) : 2;
const BOSTON_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
/** Today's calendar date in Boston, "2026-10-24". */
function wallClockDate(): string { return BOSTON_DATE.format(new Date()); }

// Parking is an opt-in estimate layer (Transit tab), off by default and remembered.
const PARKING_KEY = 'flowcast.parking';
function storedParking(): boolean {
  try { return localStorage.getItem(PARKING_KEY) === '1'; } catch { return false; }
}
/*
 * How much of the campus is labelled, remembered between visits.
 *
 * Focus is the default: a full pill for what the open panel is talking about and
 * a level marker for everything else. The campus has enough buildings that
 * labelling all of them at once is the thing that made the old map unreadable.
 */
const TAG_MODE_KEY = 'flowcast.tagMode';
function storedTagMode(): TagMode {
  try {
    const saved = localStorage.getItem(TAG_MODE_KEY);
    if (saved === 'focus' || saved === 'all' || saved === 'off') return saved;
  } catch {
    // Private browsing refuses reads; the default is right anyway.
  }
  return 'focus';
}
/** The map's weather look for a scenario's weather (live weather otherwise). */
const SCENARIO_LOOK: Record<string, WeatherMode> = { clear: 'clear', rain: 'rain', 'heavy-rain': 'rain', drizzle: 'rain', snow: 'snow', thunderstorm: 'thunderstorm', heatwave: 'heatwave', fog: 'fog' };
const START_AT = START_LIVE ? wallClockSeconds() : startTimeFromUrl();
const START_SPEED = START_LIVE ? 1 : playbackLink.speed ?? SPEEDS[1];
const OCCUPANCY_REFRESH_MS = 500;
/** The map opens on the intro still (IntroScreen) and flies in from its camera, unless the URL sets the view. */
const FROM_INTRO = !VIEW_IN_URL;
const NO_PADDING = { top: 0, left: 0, right: 0, bottom: 0 };
/** Each person's character model, looked up by id; built once per day. */
const agentModels = new WeakMap<DayData, (id: string) => number>();
function modelOfAgent(day: DayData): (id: string) => number {
  let lookup = agentModels.get(day);
  if (!lookup) {
    const models = new Map<string, number>(day.agents.map((agent) => [agent.id, agent.model]));
    const found = (id: string) => models.get(id) ?? 0;
    agentModels.set(day, found);
    return found;
  }
  return lookup;
}
/** A venue visitor's character model, from its id `visitor:<slot>:<i>`. */
function visitorModel(plan: VisitorPlan, id: string): number {
  const [, slot, index] = id.split(':');
  return plan.events.find((e) => e.slot === Number(slot))?.model[Number(index)] ?? 0;
}
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nextFrames = (n: number) => new Promise<void>((resolve) => { const step = (left: number) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve()); step(n); });
/** Lets the page paint (a stage label, the bar's next ease) before work that blocks it; timers, not frames, so it also runs in a prerendered page. */
const letPaint = () => new Promise<void>((resolve) => setTimeout(resolve, 40));
/** Waits until `count` frames in a row come under `ms` apart (the app has settled), or `capMs` at most. */
async function steadyFrames(count: number, ms: number, capMs: number) {
  const from = performance.now();
  let last = from;
  let run = 0;
  while (run < count && performance.now() - from < capMs) {
    await nextFrames(1);
    const now = performance.now();
    run = now - last < ms ? run + 1 : 0;
    last = now;
  }
}
/** Waits for the view's tiles, or `capMs` at most. */
async function tilesIn(basemap: Basemap, capMs: number) {
  const from = performance.now();
  await nextFrames(2);
  while (!basemap.tilesLoaded() && performance.now() - from < capMs) await nextFrames(1);
}
/**
 * The intro's camera, like GTA V's character switch: the map opens on the view from the sky (the
 * intro still, under haze and clouds) and loads underneath it at the same camera. When everything
 * is in, the live map takes over unseen, drops in two quick steps while the clouds rush past, and
 * swoops into the opening view, tilting and turning. Zooms are down from the still's, which
 * depends on the window's shape.
 */
const INTRO_DROPS = [
  { zoomDown: 1.1, ms: 420, hold: 150 },
  { zoomDown: 2.2, ms: 420, hold: 150 },
];
const INTRO_SWOOP_MS = 1000;
/* How often the chrome's footprint is re-measured for the label placer. */
const CHROME_REFRESH_MS = 400;

/*
 * Where the chrome is, in map pixels, so labels never land underneath it.
 *
 * The chrome is HTML drawn over the same pixels the tags are placed in, and the
 * clock has no backdrop of its own, so without this a building tag sits on top
 * of the time and neither can be read. Everything in `.hud`, plus the join card
 * and the performance readout, reserves its rectangle.
 *
 * Measured from the DOM rather than from the CSS constants because several of
 * these size to their content: the brand grows with the campus name and the
 * legend with its thresholds. `.app` fills the viewport and the map canvas fills
 * `.app`, so a viewport rect is already a map-pixel rect.
 */
function measureChrome(): Box[] {
  const boxes: Box[] = [];
  for (const el of document.querySelectorAll('.hud > *, .join-slot, .perf')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) boxes.push({ x0: r.left, x1: r.right, y0: r.top, y1: r.bottom });
  }
  return boxes;
}
/** ?ask=least+crowded+library opens the Ask tab with that question answered. */
const START_QUESTION = params.get('ask');

/*
 * The top tabs. Each opens exactly one panel, and clicking the open one closes
 * it, so no tab needs to mean "show me nothing" -- the map uncovered is simply
 * the state with none of them selected.
 *
 *   Log        what has happened and what is happening now
 *   Events     making and scheduling events
 *   Analytics  the campus measured: search, rankings, data
 *
 * Weather is not here. It opens from the chip in the top-right status, next to
 * the temperature it belongs to.
 */
type View = 'log' | 'events' | 'analytics';

/*
 * Analytics first, then Events, then Log: the order runs from what the map is
 * showing right now, through what is scheduled, to what you have asked it to
 * imagine. Each icon carries the tab's hue so the three are tellable apart
 * before the labels are read.
 */
const VIEW_TABS: HudTab<View>[] = [
  { id: 'analytics', label: 'Analytics', icon: <HudIcons.counts />, hue: 'teal' },
  { id: 'events', label: 'Events', icon: <HudIcons.calendar />, hue: 'violet' },
  { id: 'log', label: 'Log', icon: <HudIcons.incidents />, hue: 'orange' },
];

/*
 * The three subjects inside Analytics, and what the search means in each.
 *
 * Places takes the campus glyph rather than a people icon: the people icons are
 * the crowd scale's, and one of them on a tab would read as a level.
 */
const ANALYTICS_SUBS: { id: 'places' | 'transit' | 'bikes'; label: string; hue: string; icon: ReactNode }[] = [
  { id: 'places', label: 'Places', hue: 'teal', icon: <HudIcons.campus /> },
  { id: 'transit', label: 'Transit', hue: 'green', icon: <HudIcons.transit /> },
  { id: 'bikes', label: 'Bikes', hue: 'orange', icon: <HudIcons.bikes /> },
];

/** The pin on a row that would become the what-if's centre. */
const CENTRE_PIN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>';

const SEARCH_PLACEHOLDER: Record<'places' | 'transit' | 'bikes', string> = {
  places: 'Search buildings',
  transit: 'Search stops',
  bikes: 'Search Bluebikes docks',
};

const VIEW_TITLES: Record<View, string> = {
  log: 'Log',
  events: 'Events',
  analytics: 'Analytics',
};

/*
 * Kept as internal routing, not as a tab row any more. The map still sets it --
 * clicking a traffic count opens the traffic reading, a stop opens transit -- and
 * Analytics scrolls to whichever section that is. The user never picks from a
 * list of eight.
 */
type Tab = 'crowds' | 'data' | 'transit' | 'traffic' | 'bikes' | 'weather' | 'incidents';
const LINKED_TAB = params.get('tab');
const START_TAB: Tab = ['crowds', 'data', 'transit', 'traffic', 'bikes', 'weather', 'incidents'].includes(LINKED_TAB ?? '') ? LINKED_TAB as Tab : 'crowds';
const LINKED_ANALYTICS = ['crowds', 'data', 'transit', 'bikes'].includes(LINKED_TAB ?? '');
/** Gap between the floating toolbar and what it sits on (the screen edge, or the phone sheet). */
const TOOLBAR_GAP = 12;

interface Hud {
  time: number;
  walking: number;
  occupancy: Occupancy[];
  /** Bluebikes riders on the map, by the campus of the BU dock they left or are heading to. */
  riding: Map<string, number>;
  /** Students standing at stops for a published departure. */
  waiting: number;
  /** People on BU Beach, the Esplanade and the river path (out of buildings, not walking between places). */
  outdoors?: number;
  /** Public (non-student) walkers on the streets: never counted with the students. */
  public?: number;
}

interface Transit {
  data: TransitData;
  feed: MbtaFeed; // live MBTA + BU feeds (Live mode)
  schedule: PublishedTransit | null; // scheduled service on the sim clock (playback / fast-forward)
  models: VehicleModels;
}

interface Parking {
  data: ParkingData;
  model: ParkingModel;
  /** BU's own events from campus-data.json, as small parking demands (built on first use). */
  campusEvents: ParkingEvent[] | null;
}

interface Bikes {
  data: BikeData;
  replay: BikeReplay;
  feed: BluebikesFeed;
  campusOf: (trip: BikeTrip) => string;
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const basemapRef = useRef<Basemap | null>(null);
  const timeRef = useRef(START_AT);
  const speedRef = useRef(START_SPEED);
  const playingRef = useRef(true);
  const liveRef = useRef(START_LIVE);
  const selectedRef = useRef<string | null>(null);
  /*
   * How much of the campus is labelled. A preference about how the map reads
   * rather than something you re-pick each visit, so it is persisted; the frame
   * loop reads it through a ref because it never re-creates the map.
   */
  const [tagMode, setTagMode] = useState<TagMode>(storedTagMode);
  const tagModeRef = useRef(tagMode);
  tagModeRef.current = tagMode;
  /** The buildings the open panel is listing: they keep a full pill in Focus. */
  const focusRef = useRef<ReadonlySet<string>>(new Set());
  /* Which tab is open, for the handlers the map holds onto across renders. */
  const viewRef = useRef<View | null>(null);
  /* Analytics: which of the three subjects, and how the places list is cut. */
  const [analyticsSub, setAnalyticsSub] = useState<'places' | 'transit' | 'bikes'>(START_TAB === 'transit' || START_TAB === 'bikes' ? START_TAB : 'places');
  const [category, setCategory] = useState<Category>('all');
  const [sort, setSort] = useState<'quiet' | 'busy'>('quiet');
  const [listExpanded, setListExpanded] = useState(false);
  /* Events: which days, which one is open, and whether the list is unfolded. */
  const [eventWhen, setEventWhen] = useState<EventWhen>('today');
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const [eventsExpanded, setEventsExpanded] = useState(false);
  /*
   * The what-if being set up: a scenario, a centre and a radius. The radius is
   * dragged on the map, so the circle overlay reads it through a ref while the
   * panel reads it from state; both are the same number.
   */
  const [whatIfKind, setWhatIfKind] = useState<ScenarioKind>('fire-drill');
  const [whatIfCentreId, setWhatIfCentreId] = useState<string | null>(null);
  const [whatIfRadius, setWhatIfRadius] = useState(defaultRadius('fire-drill'));
  const [whatIfMinutes, setWhatIfMinutes] = useState(30);
  const [whatIfOutside, setWhatIfOutside] = useState(true);
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  /** "Hours & sources" on a building: where the old Data tab's content lives now. */
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const circleRef = useRef<WhatIfCircleHandle>(null);
  const circleFrameRef = useRef<{ centre: [number, number] | null; radius: number; rgb: string; name: string | null }>(
    { centre: null, radius: 0, rgb: '245, 245, 247', name: null },
  );
  const tagsRef = useRef<BuildingTagsHandle>(null);
  const transitTagsRef = useRef<TransitTagsHandle>(null);
  const placeTagsRef = useRef<PlaceTagsHandle>(null);
  const transitRef = useRef<Transit | null>(null);
  const perfRef = useRef<PerfCounts | null>(null); // written each frame, read by PerfMonitor once a second
  const showTransitRef = useRef(true);
  const bikesRef = useRef<Bikes | null>(null);
  const showBikesRef = useRef(true);
  const parkingRef = useRef<Parking | null>(null);
  const parkingTagsRef = useRef<ParkingTagsHandle>(null);
  const [showParking, setShowParking] = useState(storedParking);
  const showParkingRef = useRef(showParking);
  const [parkingView, setParkingView] = useState<ParkingState | null>(null);
  const [parkingError, setParkingError] = useState<string | null>(null);

  // Joined students: the list the /join flow writes, and whichever one's details are open. Both the
  // frame loop and the click handler read these through refs, so neither re-creates the map.
  const [personas, setPersonas] = useState<Persona[]>(readPersonas);
  const personasRef = useRef<Persona[]>(personas);
  const [openPersonaId, setOpenPersonaId] = useState<string | null>(null);
  const openPersonaRef = useRef<string | null>(null);

  const [loadProgress] = useState(createLoadProgress);
  const introRef = useRef(FROM_INTRO); // the intro owns the camera (no panel padding) until it has flown in
  // 'sky': the intro still, hazy and cloudy, covers the loading map (the loading screen); 'drop': the
  // live map dropping down, the clouds rushing past; 'land': swooping into the opening view, clear;
  // 'swoop': landed, the interface coming in.
  const [introPhase, setIntroPhase] = useState<'sky' | 'drop' | 'land' | 'swoop' | 'done'>(FROM_INTRO ? 'sky' : 'done');
  const [mapKind, setMapKind] = useState<Basemap['kind'] | null>(null);
  const [hud, setHud] = useState<Hud | null>(null);
  const [range, setRange] = useState<[number, number]>([0, 86400]);
  const [speed, setSpeed] = useState(START_SPEED);
  const [live, setLive] = useState(START_LIVE);
  const [playing, setPlaying] = useState(true);
  // 'auto' (default) follows the sun at the shown time: real Boston time in Clock mode.
  const [light, setLight] = useState<LightPreset | 'auto'>('auto');
  const [autoPreset, setAutoPreset] = useState<LightPreset>(() => daylightAt(START_AT).preset);
  const shownLight = light === 'auto' ? autoPreset : light;
  const lightRef = useRef<LightPreset>(shownLight); // current preset, read by the frame loop (layer tints)
  const lightModeRef = useRef<LightPreset | 'auto'>('auto');
  const veilRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Never 'ask': that lives in the bar at the bottom of the screen, and a start
  // question is handed to it directly rather than by opening a panel.
  const [tab, setTab] = useState<Tab>(START_TAB);
  // Which top tab is lit, or null for the map with nothing over it.
  const [view, setView] = useState<View | null>(LINKED_ANALYTICS ? 'analytics' : null);
  // Narrows the campus list. Empty shows the full ranking.
  const [search, setSearch] = useState('');
  // The sheet: open on wide screens, a peek on phones (half height when ?ask= has an answer to show).
  const phone = usePhone();
  const phoneRef = useRef(phone);
  phoneRef.current = phone; // read by the sheet's layout callbacks, which run before this render's effects
  // Opens on Live, so the panel starts out of the way and the map is uncovered.
  const [detent, setDetent] = useState<Detent>(() => (LINKED_ANALYTICS ? (window.matchMedia(PHONE_QUERY).matches ? 'half' : 'full') : window.matchMedia(PHONE_QUERY).matches && START_QUESTION ? 'half' : 'peek'));
  // Crossing the breakpoint (a rotated tablet, a resized window): each layout's own default.
  const wasPhone = useRef(phone);
  useEffect(() => {
    if (wasPhone.current === phone) return;
    wasPhone.current = phone;
    setDetent(phone ? 'peek' : 'full');
  }, [phone]);
  /** Bring the sheet up (if it's down) so a tab the map just switched to can be seen. */
  const expandSheet = useCallback(() => setDetent((d) => (d === 'peek' ? (phoneRef.current ? 'half' : 'full') : d)), []);
  // The camera keeps the campus centred in the map the sheet and toolbar leave uncovered.
  const coverRef = useRef<SheetCover>({ right: 0, bottom: 0 });
  const [toolbarEl, setToolbarEl] = useState<HTMLElement | null>(null);
  const toolbarHeightRef = useRef(0);
  const paddingRef = useRef<ViewPadding>({ top: 0, bottom: 0, left: 0, right: 0 });
  const updatePadding = useCallback(() => {
    const cover = coverRef.current;
    const toolbar = toolbarHeightRef.current ? toolbarHeightRef.current + 2 * TOOLBAR_GAP : 0;
    // The clean view (H) hides the sheet and toolbar, so the whole screen is map.
    const next = cleanRef.current ? { top: 0, left: 0, right: 0, bottom: 0 }
      : phoneRef.current
        ? { top: 0, left: 0, right: 0, bottom: cover.bottom + toolbar }
        : { top: 0, left: 0, right: cover.right, bottom: toolbar };
    const p = paddingRef.current;
    if (next.top === p.top && next.bottom === p.bottom && next.left === p.left && next.right === p.right) return;
    paddingRef.current = next;
    // Under the intro the map stays framed like the still (no padding); the fly-in brings it in.
    if (!introRef.current) basemapRef.current?.setViewPadding(next);
  }, []);
  const onSheetCover = useCallback((cover: SheetCover) => {
    coverRef.current = cover;
    updatePadding();
  }, [updatePadding]);
  useEffect(() => {
    if (!toolbarEl) return;
    const observer = new ResizeObserver(() => {
      toolbarHeightRef.current = toolbarEl.offsetHeight;
      toolbarEl.parentElement?.style.setProperty('--toolbar-h', `${toolbarEl.offsetHeight}px`);
      updatePadding();
    });
    observer.observe(toolbarEl);
    return () => observer.disconnect();
  }, [toolbarEl, updatePadding]);
  // Where WeatherControls draws its readout (the Weather tab) and its header chip.
  const [weatherPanel, setWeatherPanel] = useState<HTMLElement | null>(null);
  const [weatherChip, setWeatherChip] = useState<HTMLElement | null>(null);
  const [incidentRun, setIncidentRun] = useState<IncidentRun | null>(null);
  const incidentRunRef = useRef<IncidentRun | null>(null);
  const baselinePlaybackRef = useRef<Playback | null>(null);
  const askRouteRef = useRef<AskRoute | null>(null); // the walk an Ask answer draws, read by the frame loop
  const walkRoutesRef = useRef<Record<string, WalkRoute>>({});
  // Boston Fire apparatus for fire alarms: street graph and models, loaded after the map starts.
  const fireRef = useRef<Promise<{ network: FireNetwork; models: FireModels } | null> | null>(null);
  const fireModelsRef = useRef<FireModels>({});
  const fireNetworkRef = useRef<FireNetwork | null>(null);
  const [responsePending, setResponsePending] = useState(false);
  const [siren, setSiren] = useState(false);
  const sirenRef = useRef<FireSiren | null>(null);
  const [weekday, setWeekday] = useState(START_WEEKDAY);
  const weekdayRef = useRef(START_WEEKDAY); // 0 = Monday (the day picker's index), read by the frame loop
  const [sourceData, setSourceData] = useState<CampusData | null>(null);
  const [scheduleError, setScheduleError] = useState('');
  const baseDayRef = useRef<PopulationBase | null>(null);
  // Published MBTA service the students ride (null: timetable unavailable, gateways are walk-only).
  const transitServiceRef = useRef<TransitService | undefined>(undefined);
  const loadDeferredRef = useRef<((campus: string) => void) | null>(null);
  // First names for hover text (sim/names.ts), one per student, matching the character's gender.
  const namesRef = useRef<Map<string, string> | null>(null);
  // Clean view (H): no panels, tags or data overlays, just the map, buildings, people and transit.
  const [clean, setClean] = useState(false);
  const cleanRef = useRef(false);
  const playbackRef = useRef<Playback | null>(null);
  // Observed MBTA and pedestrian counts (null: file missing, public crowd off) and the non-student
  // crowd built from them for the shown day. Students alone fill university buildings.
  const observationsRef = useRef<CalibrationObservations | null>(null);
  const publicCrowdRef = useRef<PublicCrowd | null>(null);
  const publicBuildRef = useRef(0);
  // Campus events: on by default. Which date's events play is decided by eventDateFor().
  const [eventsOn, setEventsOn] = useState(START_EVENTS);
  const eventsOnRef = useRef(START_EVENTS);
  const pinnedDateRef = useRef<string | null>(URL_DATE);
  // Only the two fields the Events panel reads. Holding the whole day here (trips, stays, source
  // stats) made React's development build diff and log megabytes of props on every day swap: a
  // multi-second freeze when the conditions engine's day arrived.
  const [simDay, setSimDayState] = useState<Pick<SourceDay, 'eventDate' | 'gatherings'> | null>(null);
  const setSimDay = (day: Pick<SourceDay, 'eventDate' | 'gatherings'>) => setSimDayState({ eventDate: day.eventDate, gatherings: day.gatherings });
  // Venue events (Agganis, Fenway...): calendar, Trends popularity and visitor walks, loaded once.
  // Visitors are their own population, drawn with the walkers but never counted as students.
  const eventSourcesRef = useRef<EventSources>({ calendar: null, popularity: null, routes: null });
  const eventDayRef = useRef<EventDay>(NO_EVENT_DAY);
  const visitorPlanRef = useRef<VisitorPlan>(NO_VISITORS);
  const [eventDay, setEventDay] = useState<EventDay>(NO_EVENT_DAY);
  // A simulated Red Sox game (Incidents tab): planned with the day's venue events, on the shown day.
  const simulatedGameRef = useRef<SimulatedGame | null>(null);
  const [simulatedGame, setSimulatedGame] = useState<SimulatedGame | null>(null);
  /** Plan the venue events (and their visitors) for the date whose events are playing. */
  const planVenueEvents = (date: string | null) => {
    const planned = planEventDay(withSimulatedGame(eventSourcesRef.current, date, simulatedGameRef.current), date);
    eventDayRef.current = planned;
    visitorPlanRef.current = planVisitors(planned);
    // Other features read these by time alone (currentEventLoadAt, eventVisitorsAt).
    setCurrentEventDay(planned);
    setCurrentVisitorPlan(visitorPlanRef.current);
    setEventDay(planned);
  };
  /**
   * The Boston date whose events run on this weekday: a date picked in the URL or panel when it
   * falls on this weekday, today's date in Clock mode, else that weekday of the representative week.
   */
  const eventDateFor = (data: CampusData, day: number): string | null => {
    if (!eventsOnRef.current) return null;
    const pinned = pinnedDateRef.current;
    if (pinned && weekdayOf(pinned) === day) return pinned;
    if (liveRef.current && wallClockWeekday() === day) return wallClockDate();
    return dateForWeekday(data, day);
  };
  /** Build (or fetch from cache) one simulated day with its campus events, and make it current. */
  const playDay = (base: PopulationBase, data: CampusData, day: number): Playback => {
    // Conditions engine: once its worker is ready, days are simulated there (see the effect on
    // conditionsInput below) and the current day stays on screen until the new one is ready.
    if (engineActiveRef.current && playbackRef.current) { setDayRequest((n) => n + 1); return playbackRef.current; }
    const built = buildSourceDay(base, data, day, transitServiceRef.current, { eventDate: eventDateFor(data, day) });
    setSimDay(built);
    planVenueEvents(built.eventDate);
    // The public crowd (about a second to build) follows on the next task, so the day starts at once;
    // a newer day cancels it.
    const observations = observationsRef.current;
    const build = ++publicBuildRef.current;
    publicCrowdRef.current = null;
    if (observations) {
      setTimeout(() => {
        if (build !== publicBuildRef.current) return;
        try {
          publicCrowdRef.current = buildPublicCrowd({ observations, day: built, weekday: day, transit: transitServiceRef.current });
        } catch {
          publicCrowdRef.current = null; // the students' day plays on without the public crowd
        }
      }, 0);
    }
    return new Playback(built);
  };
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [campus, setCampus] = useState('charles-river');
  const campusRef = useRef('charles-river');
  const [mobilityData, setMobilityData] = useState<MobilityData | null>(null);
  const [mobilityView, setMobilityView] = useState<MobilityView | null>(null);
  const [mobilityMode, setMobilityMode] = useState<MobilityMode>('roads');
  const mobilityModeRef = useRef<MobilityMode>('roads');
  const [mobilityError, setMobilityError] = useState<string | null>(null);
  const [selectedMobility, setSelectedMobility] = useState<string | null>(null);
  const selectedMobilityRef = useRef<string | null>(null);
  const [showTransit, setShowTransit] = useState(true);
  // Car traffic is off by default: most students walk, bike or take the T. Still available in the Transit tab.
  const [showTraffic, setShowTraffic] = useState(false);
  // Traffic count sites ("1,313 vehicles/h · 29 bikes/h"): off by default, remembered.
  const [showCounts, setShowCounts] = useState(() => { try { return localStorage.getItem(COUNTS_KEY) === '1'; } catch { return false; } });
  const showCountsRef = useRef(showCounts);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [feedUpdatedAt, setFeedUpdatedAt] = useState<number | null>(null);
  const weatherRef = useRef<ActiveWeather | null>(null);
  // Conditions engine (sim/dayEngine.ts): see ConditionsPanel.
  const engineRef = useRef<DayEngine | null>(null);
  const engineActiveRef = useRef(false);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>('starting');
  const [engineError, setEngineError] = useState<string | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [dayRequest, setDayRequest] = useState(0);
  const [scenarioFile, setScenarioFile] = useState<ScenarioFile | null>(null);
  const [scenario, setScenario] = useState(LIVE);
  const [dayInfo, setDayInfo] = useState<DayInfo | null>(null);
  const [comparison, setComparison] = useState<DayComparison | 'loading' | null>(null);
  const [weatherKey, setWeatherKey] = useState('');
  const outdoorRef = useRef<{ file: OutdoorFile | null; index: OutdoorIndex | null; of: Playback | null }>({ file: null, index: null, of: null });
  // Each conditioned day's outdoor stays, found while it was prepared (the unconditioned model has none).
  const outdoorStaysRef = useRef(new WeakMap<Playback, Stay[]>());
  const [showBikes, setShowBikes] = useState(true);
  const [bikeFeedError, setBikeFeedError] = useState<string | null>(null);
  const [bikeFeedUpdatedAt, setBikeFeedUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    let overlay: MapboxOverlay | null = null;

    // A fresh element per mount: in dev, StrictMode mounts twice, and the first map is still
    // being torn down when the second is created.
    const mapElement = document.createElement('div');
    mapElement.className = 'map';
    containerRef.current!.appendChild(mapElement);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    (async () => {
      loadProgress.reset();
      const track = loadProgress.track;
      // BU Shuttle timetable (recorded TransLoc schedules + BU's GTFS baseline); MBTA-only without it.
      const shuttleTimetable = loadPublishedSchedule('/data/shuttle-schedule.json').catch(() => null);
      // Venue events are an extra: fetched alongside, never holding up the map.
      const venueEvents = loadEventSources();
      // Observed counts for the public crowd; without them the map shows students only.
      const observationsLoad = loadObservations().catch(() => null);
      let introStopped = false; // a drag or wheel during the intro hands the camera to the user
      // From the intro: the base map starts under the still at its exact camera, above the Boston limits.
      const basemapLoad = track('Drawing the map', FROM_INTRO
        ? createBasemap(mapElement, shownLight, { ...INTRO_VIEW, zoom: introZoom(mapElement.clientWidth, mapElement.clientHeight) }, false)
        : createBasemap(mapElement, shownLight));
      const [basemap, day, models, transitData, vehicleModels, detailedBuildings, street, snapshot, monuments, bikeData, boats, population, mbtaTimetable, mobilitySnapshot, fields, , signs] = await Promise.all([
        basemapLoad,
        track('Loading the day’s schedules', loadDay('/data/demo-day.json')),
        track('Dressing the students', loadCharacterModels() as Promise<LoadedModels>),
        // Transit and bikes are extras: the campus view must still start if they can't load.
        track('Mapping MBTA routes', loadTransit('/data/transit.json')).catch(() => null),
        track('Rolling out trains and buses', loadVehicleModels()).catch(() => ({})),
        // Detailed BU building models; the map still works with Mapbox's plain boxes without them.
        track('Raising campus buildings', loadBuildings()).catch(() => null),
        track('Lining the streets', loadStreet()).catch(() => null),
        track('Reading campus data', loadCampusData()),
        track('Placing landmarks', loadMonuments()).catch(() => null),
        track('Docking Bluebikes', loadBikes('/data/bikes.json')).catch(() => null),
        track('Launching sailboats', loadBoats()).catch(() => null), // sailboats on the Charles (river polygon + models)
        track('Enrolling students', loadPopulation()),
        track('Loading transit timetables', loadPublishedSchedule()).catch((error: Error) => { setScheduleError(error.message); return null; }),
        track('Counting traffic', loadMobility()).catch((error: Error) => { setMobilityError(error.message); return null; }),
        track('Marking the fields', loadFields()).catch(() => null),
        track('Saddling up riders', loadBikeModels()).catch(() => null), // Bluebikes riders; plain blocks without them
        // WHOOP's letters and the restaurants' shop signs in Kenmore Square and on Comm Ave: extras.
        track('Hanging shop signs', loadSigns()).catch(() => null),
      ]);
      if (cancelled) return basemap.remove();
      // The downloads are in; what follows is computing, which blocks the page: name each part and
      // give the bar its rough length, so it keeps moving through it.
      loadProgress.stage('Placing students', 0.62, 4500);
      await letPaint();
      if (cancelled) return basemap.remove();
      const shuttleSchedule = await shuttleTimetable;
      observationsRef.current = await observationsLoad;
      const candidateTimetable = mbtaTimetable ? mergeSchedules(mbtaTimetable, shuttleSchedule) : shuttleSchedule;
      const timetable = candidateTimetable && Array.from({ length: 7 }, (_, weekday) => dateForWeekday(snapshot, weekday))
        .every(date => scheduleCoversDate(candidateTimetable, date)) ? candidateTimetable : null;
      basemapRef.current = basemap;
      // The panels were laid out while the map loaded: start centred in what they leave.
      if (!introRef.current) basemap.setViewPadding(paddingRef.current, false);
      setMapKind(basemap.kind);
      const modelled = new Set(detailedBuildings?.manifest.campuses.flatMap((c) => c.buildings.map((b) => b.osm)) ?? []);
      // Draw the city's buildings, leaving out the ones we have detailed models for (always called:
      // Standard's own 3D buildings are off).
      const baselineExcludedBuildings = [...modelled].map((ref) => Number(ref.split('/')[1])).concat(fields ? fieldBuildingIds(fields) : []);
      basemap.excludeBuildings(baselineExcludedBuildings);
      let damageExclusionKey = '';
      // And by geometry: base-map buildings, labels and trees wherever our models stand.
      fetch('/data/building-footprints.json').then((r) => (r.ok ? r.json() : null)).then((fp) => fp && basemap.hideUnderModels(fp)).catch(() => {});
      // The base map's own 3D models hidden under ours (Standard's Fenway Park), plus, once the
      // transit data is in, the Green Line trackbed (no trees on it). One clip layer for both.
      const clips = landmarkClips(detailedBuildings?.manifest);
      if (clips.length) basemap.clipModels(clips);

      if (transitData) {
        // BU's own shuttles join the MBTA data: same tracks, snapping and panels.
        const shuttle = await loadShuttles(transitData.areas).catch(() => undefined);
        if (shuttle) {
          transitData.routes.push(...shuttle.routes);
          transitData.stops.push(...shuttle.stops);
        }
        const feed = new MbtaFeed(
          transitData,
          (state) => {
            setFeedError(state.error);
            setFeedUpdatedAt(state.updatedAt);
          },
          shuttle,
        );
        feed.start();
        transitRef.current = { data: transitData, feed, schedule: timetable ? new PublishedTransit(transitData, feed.tracks, timetable) : null, models: vehicleModels };
        // Keep the base map's trees off the Green Line trackbed.
        basemap.clipModels([...clips, ...trackCorridors(feed.tracks.filter((t) => t.route.startsWith('Green-')), 3.2)]);
      }

      if (bikeData) {
        const feed = new BluebikesFeed(bikeData.stations, (state) => {
          setBikeFeedError(state.error);
          setBikeFeedUpdatedAt(state.updatedAt);
        });
        feed.start();
        const dockCampus = new Map(bikeData.stations.map((s) => [s.id, s.campus]));
        // Every replayed ride has at least one BU dock; it belongs to that dock's campus.
        const campusOf = (trip: BikeTrip) => dockCampus.get(trip.from ?? '') ?? dockCampus.get(trip.to ?? '') ?? 'charles-river';
        bikesRef.current = { data: bikeData, replay: new BikeReplay(bikeData), feed, campusOf };
      }

      walkRoutesRef.current = (day as { walkRoutes?: Record<string, WalkRoute> }).walkRoutes ?? {};
      const populationBase = buildPopulation(day, snapshot, population);
      // Names for hover text: dealt once over the whole roster (the same people every day).
      fetch('/data/names.json').then((r) => (r.ok ? r.json() : null))
        .then((lists: NameLists | null) => { if (lists) namesRef.current = assignNames(populationBase.agents, lists); })
        .catch(() => {});
      baseDayRef.current = populationBase;
      setSourceData(snapshot);
      setMobilityData(mobilitySnapshot);
      transitServiceRef.current = timetable ? createTransitService(timetable) : undefined;
      const playback = playDay(populationBase, snapshot, weekdayRef.current);
      loadProgress.stage('Starting the simulation', 0.84, 3000);
      await letPaint();
      if (cancelled) return basemap.remove();
      playbackRef.current = playback;
      // Conditions engine: the day above (the unconditioned model) shows until the worker's
      // conditioned day for the live conditions is ready.
      try {
        const engine = new DayEngine(populationBase, snapshot.academicCalendar);
        engineRef.current = engine;
        engine.ready.then(() => { if (!cancelled) { engineActiveRef.current = true; setEngineReady(true); } },
          (error: Error) => { if (!cancelled) { engineActiveRef.current = false; setEngineStatus('unavailable'); setEngineError(error.message); } });
      } catch (error) { setEngineStatus('unavailable'); setEngineError((error as Error).message); }
      void loadScenarios().then((file) => { if (!cancelled) setScenarioFile(file ?? null); });
      void loadOutdoor().then((file) => { outdoorRef.current = { file: file ?? null, index: null, of: null }; });
      void venueEvents.then((sources) => {
        if (cancelled) return;
        eventSourcesRef.current = sources;
        planVenueEvents(eventDayRef.current.date ?? (playbackRef.current?.data as SourceDay | undefined)?.eventDate ?? null);
      });
      setRange([0, 86400]);
      setCampuses(day.campuses ?? []);
      const linkedCampus = campusFromUrl(params, day.locations);
      campusRef.current = linkedCampus;
      setCampus(linkedCampus);

      // What a map pointer is over, for the tags that expand on hover (and on tap, for touch).
      const buildingUnder = (object: unknown) =>
        object && typeof object === 'object' && ('polygon' in object || 'share' in object) ? (object as unknown as { id: string }).id : null;
      const markerUnder = (object: unknown): TagMarker =>
        !object || typeof object !== 'object' ? null
        : 'platforms' in object ? { kind: 'stop', id: (object as unknown as { id: string }).id }
        : 'gbfsId' in object ? { kind: 'dock', id: (object as unknown as { id: string }).id }
        : null;
      overlay = new MapboxOverlay({
        interleaved: new URLSearchParams(window.location.search).get('interleaved') !== '0',
        _animate: true, // keeps the walk cycles ticking between data updates
        // Skips drawing models that are wholly off-screen (see layers/culling.ts).
        layerFilter: cullLayers,
        // Hovering a building or a stop/dock dot expands its tag.
        onHover: ({ object }: PickingInfo) => {
          tagsRef.current?.hoverBuilding(buildingUnder(object));
          transitTagsRef.current?.hoverMarker(markerUnder(object));
          placeTagsRef.current?.hoverPlace(placeUnder(object));
          if (showParkingRef.current) {
            const lot = parkingUnder(object);
            parkingTagsRef.current?.hoverLot(lot === null ? null : parkingRef.current?.data.lots[lot]?.id ?? null);
          }
        },
        // Building footprints and labels both carry the building id; anything else clears.
        onClick: (info: PickingInfo) => {
          const { object } = info;
          /*
           * A joined student opens their own card in the corner slot, and nothing else: they are not
           * a building, and selecting one must not disturb whichever panel is open.
           *
           * The second pick is what makes the character itself clickable. Someone standing at a
           * building stands at its centroid, inside it, so the invisible building pick-target is in
           * front of them and the first pick returns the building; re-picking against only the
           * persona layers ignores every other layer's depth.
           */
          const joined = personaUnder(object) ?? personaUnder(overlay?.pickObject({ x: info.x, y: info.y, radius: 10, layerIds: PERSONA_PICK_LAYER_IDS })?.object);
          if (joined) {
            setOpenPersonaId(joined.personaId);
            return;
          }
          if (object && 'mobilityKind' in object) {
            selectedMobilityRef.current = object.id;
            setSelectedMobility(object.id);
            setTab('traffic');
            expandSheet();
            return;
          }
          // A vehicle pins its tag; anything else unpins it.
          transitTagsRef.current?.pinVehicle(object && 'receivedAt' in object ? (object as { id: string }).id : null);
          // Touch has no hover: a tap opens the stop's or dock's tag (a tapped building's tag opens
          // because it's selected).
          transitTagsRef.current?.hoverMarker(markerUnder(object));
          placeTagsRef.current?.hoverPlace(placeUnder(object));
          const isBuilding = object && ('polygon' in object || 'share' in object);
          const id = isBuilding ? (object as { id: string }).id : null;
          selectedRef.current = id;
          setSelected(id);
          if (id) {
            setTab('data');
            expandSheet();
          }
        },
        getTooltip: ({ object }: PickingInfo) => {
          // First: a joined student carries a bearing like any walker, so without this they would
          // fall through to the "Student" tooltip at the bottom of this chain.
          const joined = personaUnder(object);
          if (joined) return personaTooltip(joined);
          const countTooltip = mobilityTooltip(object);
          if (countTooltip) return countTooltip;
          const fireText = fireTooltip(object);
          if (fireText) return fireText;
          // Vehicles get a floating glass tag (TransitTags) instead of the tooltip.
          const vehicleId = object && 'receivedAt' in object ? (object as { id: string }).id : null;
          transitTagsRef.current?.hoverVehicle(vehicleId);
          if (vehicleId) return null;
          // Stops and docks with a tag expand it instead of showing a tooltip.
          const marker = markerUnder(object);
          if (marker && transitTagsRef.current?.hasTag(marker)) return null;
          // Places (monuments, open spaces, fields) and parking lots open their tag instead.
          if (placeUnder(object) || parkingUnder(object) !== null) return null;
          const bikes = bikesRef.current;
          const bikeText = bikes ? bikeTooltip(object, bikes.data, bikes.feed, timeRef.current) : null;
          if (bikeText) return bikeText;
          const transit = transitRef.current;
          const streetText = streetTooltip(object, transit);
          if (streetText) return streetText;
          const boatText = boatTooltip(object);
          if (boatText) return boatText;
          const signText = signTooltip(object);
          if (signText) return signText;
          const source = transit && (liveRef.current ? transit.feed : transit.schedule);
          const text = transit && source ? transitTooltip(object, transit.data, source) : null;
          if (text) return text;
          if (!object || !('bearing' in object) || 'receivedAt' in object) return null;
          const agent = object as WalkingAgent;
          const visitor = visitorFromId(visitorPlanRef.current, agent.id);
          if (visitor) {
            const { estimate, origin } = visitor;
            return agent.to === estimate.venue.id
              ? `Event visitor → ${estimate.venue.name} (${estimate.event.name}) from ${origin.name}`
              : `Event visitor leaving ${estimate.venue.name} → ${origin.name}`;
          }
          // Riders walking to a stop are headed for a transit stop, not a building.
          if (isPublicId(agent.id)) return agent.to === 'street' ? 'Public pedestrian (not a student)' : `Public rider (not a student) · ${transit?.data.stops.find((s) => s.id === agent.to)?.short ?? 'MBTA stop'}`;
          const where = playbackRef.current?.locations.find((l) => l.id === agent.to)?.name ?? transit?.data.stops.find((s) => s.id === agent.to)?.short;
          const who = namesRef.current?.get(agent.id) ?? 'Student';
          return where ? `${who} → ${displayName(where)}` : who;
        },
      });
      basemap.addControl(overlay);
      // Fire response data is only needed once someone sounds a fire alarm: fetch it in the background.
      fireRef.current = Promise.all([loadFireNetwork(), loadFireModels()])
        .then(([network, models]) => { fireModelsRef.current = models; fireNetworkRef.current = network; return { network, models }; })
        .catch(() => null);
      // Dev-only handle for poking at layers from the browser console.
      if (import.meta.env.DEV || params.has('debug')) Object.assign(window, { __flowcast: { overlay, basemap, get playback() { return playbackRef.current; }, get time() { return timeRef.current; }, get incident() { return incidentRunRef.current; }, transitRef, bikesRef, populationBase, quality } });
      // Lift the intro once the first frames are drawn and the view's tiles are in (or after 4 s
      // regardless). From the intro still: the live map takes over at the still's exact camera (no
      // fade: the two are the same picture) and drops in (INTRO_DROPS). With a view from the URL:
      // sweep in from a wider, turned view.
      const dropIn = async () => {
        const width = mapElement.clientWidth;
        const height = mapElement.clientHeight;
        const sky = { ...INTRO_VIEW, zoom: introZoom(width, height), padding: NO_PADDING };
        if (prefersReducedMotion()) {
          // Reduced motion: from the still straight to the opening view.
          basemap.jumpTo({ ...INITIAL_VIEW, padding: paddingRef.current });
          await nextFrames(2);
          loadProgress.finish();
        } else {
          loadProgress.stage('Lining up the view', 0.97, 2000);
          introSound.prepare();
          // Still under the still: fetch the tiles of the views the camera will pass through (it would
          // otherwise fetch them on the way, in stutters), then back to the sky. The first frames after
          // loading also build layers and shaders: let them settle so the drops run smoothly.
          for (const view of [...INTRO_DROPS.map((step) => ({ ...sky, zoom: sky.zoom + step.zoomDown })), { ...INITIAL_VIEW, padding: NO_PADDING }, sky]) {
            if (cancelled) return;
            basemap.jumpTo(view);
            await tilesIn(basemap, 1200);
          }
          await steadyFrames(6, 45, 2500);
          if (cancelled) return;
          const unwatch = basemap.onUserInteraction(() => { introStopped = true; });
          loadProgress.finish(); // the still goes: the live map is under it at the same camera
          setIntroPhase('drop');
          introSound.clouds(900);
          for (const [i, step] of INTRO_DROPS.entries()) {
            if (cancelled || introStopped) break;
            introSound.drop(step.ms, i > 0); // the clouds' whoosh carries the first drop
            basemap.easeTo({ zoom: sky.zoom + step.zoomDown, duration: step.ms, easing: easeInOutCubic });
            await sleep(step.ms + step.hold);
          }
          setIntroPhase('land');
          if (!cancelled && !introStopped) {
            introSound.swoop(INTRO_SWOOP_MS);
            basemap.easeTo({ ...INITIAL_VIEW, padding: paddingRef.current, duration: INTRO_SWOOP_MS, easing: easeInOutCubic });
            await sleep(INTRO_SWOOP_MS);
          }
          // The interface comes in once the camera has landed (moving it with the camera costs frames).
          setIntroPhase('swoop');
          await sleep(600);
          unwatch();
        }
        if (cancelled) return;
        introRef.current = false;
        basemap.setLimits(true);
        if (introStopped) basemap.setViewPadding(paddingRef.current);
        setIntroPhase('done');
      };
      const revealFrom = performance.now();
      const reveal = () => {
        if (cancelled) return;
        if (!basemap.tilesLoaded() && performance.now() - revealFrom < 4000) return void requestAnimationFrame(reveal);
        if (FROM_INTRO) return void dropIn();
        const camera = basemap.getCamera();
        basemap.jumpTo({ zoom: camera.zoom - 0.9, bearing: camera.bearing - 25, pitch: Math.max(0, camera.pitch - 15) });
        basemap.easeTo({ ...camera, duration: 2200 });
        loadProgress.finish();
      };
      requestAnimationFrame(() => requestAnimationFrame(reveal));

      // The crowd glow and tags stand on the detailed models' roofs, not the shorter footprints.
      // Deferred campuses (buildings.ts): load their models once the view comes near them.
      const deferred = detailedBuildings
        ? DEFERRED_CAMPUSES.flatMap((id) => { const b = campusBounds(detailedBuildings.manifest, id, 0); return b ? [{ id, bounds: b }] : []; })
        : [];
      loadDeferredRef.current = (id: string) => { if (detailedBuildings) void loadCampusModels(detailedBuildings.manifest, detailedBuildings.models, id); };
      const roofHeights = modelRoofHeights(detailedBuildings?.manifest);
      const volumes = modelVolumes(detailedBuildings?.manifest);
      const damageFootprints = day.buildings.map(footprint => ({ ...footprint, height: roofHeights.get(footprint.id) ?? footprint.height }));
      let last = performance.now();
      let lastOccupancy = 0;
      let lastChrome = 0;
      let chromeBoxes: Box[] = [];
      let occupancy = playback.occupancyAt(timeRef.current);
      let mobilityKey = '';
      let currentMobility: MobilityView | null = null;
      let buildings: BuildingOccupancy[] = [];
      let buildingOccupancy: BuildingOccupancy[] = [];
      let buildingsFrom: Occupancy[] | null = null;
      let buildingsPlayback: Playback | null = null;
      let dockStatus = new Map<string, DockEstimate>(); // Bluebikes at the shown time, refreshed with occupancy
      let parkingState: ParkingState | null = null; // only while the Parking toggle is on
      let lastParking = 0;
      let runnersFor: IncidentRun | null = null;
      let meteorRunners = new Map<string, IncidentRun['participants'][number]>();
      const tick = (now: number) => {
        // Off-beat display frames (perf/pacer.ts) do nothing: the map doesn't draw on them either.
        if (!pacer.shouldRender(now)) {
          frame = requestAnimationFrame(tick);
          return;
        }
        const elapsed = now - last;
        last = now;
        let nextDay = weekdayRef.current;
        if (liveRef.current) {
          nextDay = wallClockWeekday();
          timeRef.current = wallClockSeconds();
        } else if (playingRef.current) {
          const passedDays = Math.floor((timeRef.current + Math.max(0, elapsed) * speedRef.current / 1000) / 86400);
          nextDay = (nextDay + passedDays) % 7;
          timeRef.current = advanceTime(timeRef.current, elapsed, speedRef.current);
        }
        if (nextDay !== weekdayRef.current) {
          weekdayRef.current = nextDay;
          setWeekday(nextDay);
          playbackRef.current = playDay(populationBase, snapshot, nextDay);
          baselinePlaybackRef.current = null;
          incidentRunRef.current = null;
          setIncidentRun(null);
          lastOccupancy = 0;
        }
        const playback = playbackRef.current!;
        const t = timeRef.current;
        const impact = incidentRunRef.current;
        const [shakeX, shakeY] = impact?.incident.kind === 'meteor' && playingRef.current
          ? impactShake(t - impact.incident.start, impact.hazard?.radiusMetres ?? 100, reducedMotion.matches)
          : [0, 0];
        mapElement.style.transform = shakeX || shakeY
          ? `translate(${shakeX}px, ${shakeY}px) scale(1.025)` : '';
        if (lightModeRef.current === 'auto') {
          // Mapbox Standard has four presets: pick one by the sun (cached per sim half-minute) and set
          // the veil in the same frame, so the switch itself doesn't flash.
          const { preset, veil } = daylightAt(t);
          if (veilRef.current) veilRef.current.style.opacity = String(veil);
          if (preset !== lightRef.current) {
            lightRef.current = preset;
            basemap.setLightPreset(preset);
            setAutoPreset(preset);
          }
        }
        const nextMobilityKey = `${mobilityModeRef.current}:${campusRef.current}:${weekdayRef.current}:${Math.floor(t / 3600)}`;
        if (mobilitySnapshot && nextMobilityKey !== mobilityKey) {
          currentMobility = mobilityAt(mobilitySnapshot, mobilityModeRef.current, campusRef.current, weekdayRef.current, t);
          mobilityKey = nextMobilityKey;
          setMobilityView(currentMobility);
        }
        // Performance setting (perf/quality.ts): Auto watches these frame times.
        quality.frame(now);
        const q = quality.settings;
        setParticleScale(q.particles);
        const walking = playback.walkingAt(t);
        if (runnersFor !== impact) {
          runnersFor = impact;
          meteorRunners = new Map(impact?.incident.kind === 'meteor'
            ? impact.participants.map(p => [p.agentId, p]) : []);
        }
        const runningIds = new Set<string>();
        for (const person of walking) {
          const p = meteorRunners.get(person.id);
          if (p && t >= p.departAt && t < p.resumedAt && person.to === p.decision?.destinationId) runningIds.add(person.id);
        }
        const publicWalking = publicCrowdRef.current?.walkingAt(t) ?? [];
        const waitingRiders = playback.waitingAt(t);
        // The public waiting at stops (MBTA boardings beyond BU riders): drawn with them, not in the BU-rider stop counts.
        const publicWaiting = publicCrowdRef.current?.waitingAt(t) ?? [];
        const allWaiting = publicWaiting.length ? [...waitingRiders, ...publicWaiting] : waitingRiders;
        // Outdoor free time by the river (layers/outdoor.ts): indexed once per day, drawn near the camera.
        const outdoor = outdoorRef.current;
        if (outdoor.of !== playback) { outdoor.index = outdoorIndex(outdoorStaysRef.current.get(playback), playback.data.agents, outdoor.file); outdoor.of = playback; }
        const outside = outdoor.index ? outdoorPeople(outdoor.index, t, basemap.getCamera().center, q.walkerRadius) : null;
        // People sitting by the river join the waiting riders' idle layers (same models, same idle
        // clip): no layers of their own, so no extra draws, and nothing to build when the first one
        // sits down. They stay unpickable there, as before.
        const sitters: Character[] = outside?.sitting.length ? outside.sitting.map((agent) => ({ ...agent, unpickable: true })) : [];
        const bikes = bikesRef.current;
        const riding = bikes ? bikes.replay.ridingAt(t) : [];
        if (now - lastOccupancy > OCCUPANCY_REFRESH_MS) {
          occupancy = playback.occupancyAt(t);
          lastOccupancy = now;
          if (bikesRef.current) dockStatus = dockStatusAt(bikesRef.current, liveRef.current ? wallClockSeconds() : t, !liveRef.current);
          const ridingByCampus = new Map<string, number>();
          for (const r of riding) ridingByCampus.set(bikes!.campusOf(r.trip), (ridingByCampus.get(bikes!.campusOf(r.trip)) ?? 0) + 1);
          setHud({ time: t, walking: walking.length, occupancy, riding: ridingByCampus, waiting: waitingRiders.length,
            outdoors: outdoor.index ? outdoorCount(outdoor.index, t) : undefined, public: publicWalking.length });
        }
        // Reserve the chrome, then the active assembly label, before placing building and transit tags.
        const placer = createPlacer(basemap.project);
        if (now - lastChrome > CHROME_REFRESH_MS) {
          chromeBoxes = measureChrome();
          lastChrome = now;
        }
        for (const box of chromeBoxes) placer.block(box);
        const damage = damageAt(incidentRunRef.current, t, damageFootprints);
        const damagedIds = new Set(damage.map(building => building.id));
        const damageKey = damage.map(building => building.id).join(',');
        if (damageKey !== damageExclusionKey) {
          basemap.excludeBuildings([...baselineExcludedBuildings, ...damage.map(building => Number(building.id.split('/')[1])).filter(Number.isFinite)], damageExclusionAreas(damage, detailedBuildings?.manifest));
          damageExclusionKey = damageKey;
        }
        // A fire's evacuees standing outside (nothing without an outdoor crowd).
        const crowd = incidentRunRef.current?.crowd;
        const standing = crowd ? crowdCharacters(playback.outdoorAt(t), crowd) : [];
        const response = incidentRunRef.current?.fireResponse;
        const fireTrucks = response ? fireResponseAt(response, t) : [];
        const incidentFrameLayers = incidentLayers(incidentRunRef.current, t, occupancy, day.buildings, placer, damage);
        // Meteor fatalities thrown from the impact, then lying where they land.
        const run = incidentRunRef.current;
        if (run?.incident.kind === 'meteor' && (run.casualties?.length || run.fans?.ragdolls.length) && models) {
          const thrown = run.fans?.ragdolls.length ? [...(run.casualties ?? []), ...run.fans.ragdolls] : run.casualties!;
          const modelOf = modelOfAgent(day), plan = visitorPlanRef.current;
          incidentFrameLayers.push(...ragdollLayers(ragdollsAt(thrown, run.location.position, run.hazard?.radiusMetres ?? 100, t,
            (id) => (id.startsWith('visitor:') ? visitorModel(plan, id) : modelOf(id))), models, t, basemap.getZoom()));
        }
        // Rolled up per building only when occupancy is refreshed (or the day changes), not every frame.
        if (occupancy !== buildingsFrom || playback !== buildingsPlayback) {
          buildingOccupancy = playback.byBuilding(occupancy);
          buildings = withVenueEvents(splitSharedTags(buildingOccupancy, occupancy, day.buildings, roofHeights), eventDayRef.current, t, populationBase.locations);
          buildingsFrom = occupancy;
          buildingsPlayback = playback;
        }
        if (!cleanRef.current) tagsRef.current?.update({
          buildings: buildings.filter(building => !damagedIds.has(building.id.split('#')[0])),
          footprints: day.buildings,
          locations: populationBase.locations,
          selectedId: selectedRef.current,
          placer,
          project: basemap.project,
          camera: basemap.getCamera(),
          roofHeights,
          tagMode: tagModeRef.current,
          focusIds: focusRef.current,
        });
        // The what-if's area, re-projected every frame: its shape depends on the
        // camera, and a circle that lagged the map would be describing a different
        // piece of ground from the one the engine is using.
        circleRef.current?.update({
          centre: circleFrameRef.current.centre,
          radiusMetres: circleFrameRef.current.radius,
          rgb: circleFrameRef.current.rgb,
          centreName: circleFrameRef.current.name,
          project: basemap.project,
        });
        // Parking (toggle on only): the estimate is refreshed at most twice a second, then its tags
        // (with the toggle on, lots are what the user asked to see: placed before the transit tags).
        const parking = showParkingRef.current ? parkingRef.current : null;
        if (parking) {
          if (!parkingState || now - lastParking > OCCUPANCY_REFRESH_MS) {
            lastParking = now;
            parking.campusEvents ??= campusParkingEvents(snapshot.events);
            parkingState = parkingAt(parking.model, parkingDay(snapshot, liveRef.current, weekdayRef.current), liveRef.current ? wallClockSeconds() : t, parking.campusEvents);
            setParkingView(parkingState);
          }
          if (!cleanRef.current) parkingTagsRef.current?.update({ placer, project: basemap.project, camera: basemap.getCamera(), state: parkingState });
        } else parkingState = null;
        const transit = transitRef.current;
        // Live feeds and published playback share the rendering interface.
        const source = transit ? transitSourceAt(transit, t, liveRef.current, weekdayRef.current, dateForWeekday(snapshot, weekdayRef.current)) : null;
        const showBikesNow = bikes && showBikesRef.current;
        // Shown time and day (0 = Sunday), for BU shuttle service hours.
        const serviceTime = liveRef.current ? wallClockSeconds() : t;
        const serviceDay = liveRef.current ? new Date().getDay() : (weekdayRef.current + 1) % 7;
        // Then station, stop and dock tags, through the same placer.
        if (!cleanRef.current) transitTagsRef.current?.update({
          placer,
          project: basemap.project,
          zoom: basemap.getZoom(),
          transit: transit && source && showTransitRef.current ? { data: transit.data, source, now, time: serviceTime, weekday: serviceDay,
            // Modeled BU students on a published trip; live vehicles have no matching trip id.
            aboard: (vehicleId: string) => aboardPublished(vehicleId, t, playback),
            waiting: waitingByStop(waitingRiders) } : null,
          bikes: showBikesNow ? { stations: bikes.data.stations, dockStatus } : null,
        });
        // Then monuments, artworks, open spaces and fields.
        if (!cleanRef.current) placeTagsRef.current?.update({
          placer,
          project: basemap.project,
          camera: basemap.getCamera(),
          monuments: monuments?.monuments ?? null,
          fields: fields?.fields ?? null,
        });
        // What's in view (with a margin): walkers outside it aren't drawn, and a deferred campus
        // starts loading when the view approaches it.
        const view = expandBounds(basemap.visibleBounds(), 0.25);
        // A tilted view's bounds reach to the horizon, so nearness is judged from the camera's centre.
        const camera = basemap.getCamera();
        for (const d of deferred) {
          if (!detailedBuildings!.models[d.id] && (camera.zoom < 14.5 || metresToBox(camera.center, d.bounds) < DEFERRED_LOAD_METRES)) loadDeferredRef.current?.(d.id);
        }
        // Event visitors near the camera (none, at no cost, when no venue event is on).
        const visitorFrame = visitorsAt(visitorPlanRef.current, t, camera.center, q.walkerRadius, ([x, y]) => x >= view[0] && x <= view[2] && y >= view[1] && y <= view[3]);
        // Fans a meteor hit stop walking from that moment (the dead are drawn as ragdolls).
        const harmedFans = incidentRunRef.current?.fans?.harmed;
        if (harmedFans?.size) visitorFrame.drawn = visitorFrame.drawn.filter((fan) => !((harmedFans.get(fan.id) ?? Infinity) <= t));
        const frameLayers = [
          ...fallbackDamageLayers(damage, new Set(detailedBuildings?.manifest.campuses
            .filter(campus => detailedBuildings.models[campus.id])
            .flatMap(campus => campus.buildings.map(building => building.osm)) ?? [])),
          ...fireResponseLayers(fireTrucks, t, basemap.getZoom()),
          ...(detailedBuildings
            ? buildingModelLayers(detailedBuildings.manifest, detailedBuildings.models, { lightPreset: lightRef.current, clock: t, auto: lightModeRef.current === 'auto', litWindows: q.litWindows, damage, footprints: damageFootprints })
            : []),
          ...(cleanRef.current ? [] : crowdLayers({
            footprints: day.buildings,
            buildings: buildingOccupancy.filter((building) => building.modeled !== false && !damagedIds.has(building.id)),
            trips: playback.trailsAt(t, Math.min(600, Math.max(20, speedRef.current * 3))),
            time: t,
            speed: speedRef.current,
            selectedId: selectedRef.current,
            zoom: basemap.getZoom(),
            roofHeights,
            volumes,
          })),
          ...(street ? streetLayers({ street, transit, time: t, zoom: basemap.getZoom() }) : []),
          ...(transit && source && showTransitRef.current ? transitLayers({ data: transit.data, feed: source, now, zoom: basemap.getZoom(), models: transit.models, time: serviceTime, weekday: serviceDay }) : []),
          ...(monuments ? monumentLayers(monuments, { zoom: basemap.getZoom(), lightPreset: lightRef.current, time: serviceTime }) : []),
          ...(signs ? signLayers(signs, { zoom: basemap.getZoom(), lightPreset: lightRef.current, time: serviceTime }) : []),
          ...(fields ? fieldLayers(fields, { zoom: basemap.getZoom(), lightPreset: lightRef.current, clock: t, auto: lightModeRef.current === 'auto' }) : []),
          ...(cleanRef.current ? [] : [...(parking && parkingState ? parkingLayers(parking.data, parkingState) : [])]),
          ...placeHitLayers(monuments?.monuments ?? null, fields?.fields ?? null, basemap.getZoom()),
          ...(boats && sailingWeather(weatherRef.current, lightRef.current) ? boatLayers({ boats, time: t, zoom: basemap.getZoom(), speed: liveRef.current ? 1 : speedRef.current, lightPreset: lightRef.current, windFromDegrees: boatWind() }) : []),
          ...(showBikesNow
            ? bikeLayers({ data: bikes.data, trips: bikes.replay.trips, riding, time: t, speed: speedRef.current, zoom: basemap.getZoom(), dockStatus })
            : []),
          // Students walking, plus river walkers/runners (conditions engine), plus event visitors; then the
          // public (non-student) crowd, thinned on its own (data/observations.ts, sim/publicCrowd.ts).
          ...agentLayers(withPublic(thinForZoom(withVisitors(inView(nearView(walking, camera.center, q.walkerRadius).concat(nearView(outside?.moving ?? [], camera.center, q.walkerRadius)), view), visitorFrame.drawn), basemap.getZoom()),
            thinForZoom(inView(nearView(publicWalking, camera.center, q.walkerRadius), view), basemap.getZoom())), models, t, { zoom: basemap.getZoom(), runningIds }),
          // Students who joined from a phone. Drawn with the same character layers as everyone else
          // so they walk identically, but starred with their name so they read as real people in the
          // simulated crowd. On the simulation clock (t), not wall time, so they keep pace with it.
          ...personaLayers(placePersonas(personasRef.current, playback.locations, t * 1000), models, t, {
            zoom: basemap.getZoom(),
            selectedId: openPersonaRef.current,
            showLabels: !cleanRef.current,
          }),
          ...incidentFrameLayers,
          // Fire apparatus: no layers unless a fire alarm's response is under way.
          ...fireLayers(incidentRunRef.current?.response ?? null, { time: t, now, zoom: basemap.getZoom(), night: lightRef.current !== 'day', models: fireModelsRef.current }),
          // People standing about: riders waiting at stops, a fire's evacuees in their crowds, and
          // people sitting by the river (all in the same idle layers).
          ...(transit || standing.length || sitters.length ? waitingRiderLayers(withSitters(transit || standing.length ? nearView(standing.length
            ? [...(transit ? waitingCharacters(allWaiting, transit.feed.tracks) : []), ...standing]
            : waitingCharacters(allWaiting, transit!.feed.tracks), basemap.getCamera().center, q.walkerRadius) : [], sitters), models, t, basemap.getZoom()) : []),
          ...(cleanRef.current ? [] : askRouteLayers(askRouteRef.current)),
          ...(currentMobility && showCountsRef.current && !cleanRef.current ? mobilityLayers(currentMobility, { selectedId: selectedMobilityRef.current, placer }) : []),
          ...atmosphereLayers(weatherRef.current, basemap.getCamera(), now, lightRef.current),
          ...precipitationLayers(weatherRef.current?.effect.precipitation, basemap.getCamera(), now, lightRef.current),
        ];
        overlay!.setProps({ layers: frameLayers });
        // Siren (off unless switched on): only while apparatus run lights-and-siren and the clock runs.
        sirenRef.current?.set(playingRef.current ? FireSiren.levelAt(nearestResponding(incidentRunRef.current?.response ?? null, basemap.getCamera().center)) : 0);
        perfRef.current = {
          walkers: walking.length + visitorFrame.drawn.length + publicWalking.length,
          vehicles: source ? source.positionsAt(now).length : 0,
          layers: frameLayers.length,
        };
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    })().catch((err: Error) => { if (!cancelled) loadProgress.fail(err.message); });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      transitRef.current?.feed.stop();
      transitRef.current = null;
      bikesRef.current?.feed.stop();
      bikesRef.current = null;
      basemapRef.current?.remove();
      basemapRef.current = null;
      mapElement.remove();
    };
    // The map is created once; light changes go through setLightPreset below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (e.metaKey || e.ctrlKey || e.altKey || target?.closest('input, select, textarea, [contenteditable="true"]')) return;
      if (e.key !== 'h' && e.key !== 'H') return;
      cleanRef.current = !cleanRef.current;
      setClean(cleanRef.current);
      updatePadding();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [updatePadding]);

  /*
   * Joined students arrive from somewhere else: the /join flow runs in the dashboard, in another tab
   * on this same origin, and writes through persona/store.ts. This picks a new character up the
   * moment it lands, and drops an open details card if that character has been removed.
   */
  useEffect(() => {
    const apply = (list: Persona[]) => {
      personasRef.current = list;
      setPersonas(list);
    };
    apply(readPersonas());
    return subscribePersonas(apply);
  }, []);

  // The frame loop highlights the open character; it reads the id from a ref so opening a card
  // never restarts the map.
  useEffect(() => {
    openPersonaRef.current = openPersonaId;
  }, [openPersonaId]);

  useEffect(() => {
    lightModeRef.current = light;
    const preset = light === 'auto' ? daylightAt(timeRef.current).preset : light;
    basemapRef.current?.setLightPreset(preset);
    lightRef.current = preset;
    if (light === 'auto') setAutoPreset(preset);
  }, [light]);

  useEffect(() => {
    basemapRef.current?.setTrafficVisible(showTraffic);
  }, [showTraffic, mapKind]);

  useEffect(() => { campusRef.current = campus; }, [campus]);

  // The parking lots and events load the first time the toggle is on (never while it's off).
  useEffect(() => {
    if (!showParking || parkingRef.current) return;
    let stale = false;
    loadParking()
      .then((data) => { if (!stale) parkingRef.current = { data, model: createParkingModel(data), campusEvents: null }; setParkingError(null); })
      .catch((error: Error) => setParkingError(error.message));
    return () => { stale = true; };
  }, [showParking]);

  const goToCampus = (c: Campus) => {
    setCampus(c.id);
    loadDeferredRef.current?.(c.id);
    // The Charles River Campus is long and thin and needs the wide default shot; the others fit closer in.
    if (c.id === 'charles-river') basemapRef.current?.flyTo(INITIAL_VIEW.center, INITIAL_VIEW.zoom);
    else basemapRef.current?.flyTo(c.center, 16.4);
  };

  const getPerfCounts = useCallback(() => perfRef.current, []);
  const onWeather = useCallback((w: ActiveWeather) => {
    weatherRef.current = w;
    // The conditions engine only rebuilds when the weather's behaviour family or temperature band changes.
    const shown = dayWeather({ condition: w.condition, temperatureF: w.temperatureF });
    setWeatherKey(`${w.source}|${w.reading?.observedAt.slice(0, 10) ?? ""}|${shown.kind}|${shown.band}`);
  }, []);
  const openWeather = useCallback(() => {
    setTab('weather');
    expandSheet();
  }, [expandSheet]);

  const toggleTransit = () => {
    showTransitRef.current = !showTransitRef.current;
    setShowTransit(showTransitRef.current);
  };

  const toggleCounts = () => {
    showCountsRef.current = !showCountsRef.current;
    setShowCounts(showCountsRef.current);
    try { localStorage.setItem(COUNTS_KEY, showCountsRef.current ? '1' : '0'); } catch { /* storage blocked: this session only */ }
  };
  const toggleParking = () => {
    showParkingRef.current = !showParkingRef.current;
    setShowParking(showParkingRef.current);
    if (!showParkingRef.current) setParkingView(null);
    try { localStorage.setItem(PARKING_KEY, showParkingRef.current ? '1' : '0'); } catch { /* private mode */ }
  };
  const selectLot = (s: LotState) => basemapRef.current?.flyTo(s.lot.position, 17);

  const toggleBikes = () => {
    showBikesRef.current = !showBikesRef.current;
    setShowBikes(showBikesRef.current);
  };

  const leaveLive = () => {
    liveRef.current = false;
    setLive(false);
  };
  const goLive = () => {
    resetIncident();
    liveRef.current = true;
    setLive(true);
    speedRef.current = 1;
    setSpeed(1);
    playingRef.current = true;
    setPlaying(true);
    // Clock mode shows today's events, not a date picked earlier.
    pinnedDateRef.current = null;
    if (baseDayRef.current && sourceData) {
      weekdayRef.current = wallClockWeekday();
      setWeekday(weekdayRef.current);
      playbackRef.current = playDay(baseDayRef.current, sourceData, weekdayRef.current);
    }
  };
  const changeSpeed = (s: number) => {
    leaveLive();
    speedRef.current = s;
    setSpeed(s);
  };
  const togglePlaying = () => {
    leaveLive();
    playingRef.current = !playingRef.current;
    setPlaying(playingRef.current);
  };
  const scrub = (t: number) => {
    leaveLive();
    timeRef.current = t;
    refreshIncidentHud();
  };
  const selectBuilding = (id: string | null) => {
    selectedRef.current = id;
    setSelected(id);
    /*
     * While the Log tab is open, tapping a building is picking the what-if's
     * centre: the form says "search above or tap the map", and this is the tap.
     * Clearing the searched id is what makes the tap win, since a centre chosen
     * by search otherwise outranks the selection for the rest of the session.
     */
    if (id && viewRef.current === 'log') setWhatIfCentreId(null);
  };
  const select = (o: Occupancy) => {
    selectedRef.current = o.location.building;
    setSelected(o.location.building);
    basemapRef.current?.flyTo(o.location.position);
  };

  const changeDay = (value: number) => {
    if (!baseDayRef.current || !sourceData) return;
    leaveLive();
    playbackRef.current = playDay(baseDayRef.current, sourceData, value);
    baselinePlaybackRef.current = null;
    incidentRunRef.current = null;
    setIncidentRun(null);
    setWeekday(value);
    weekdayRef.current = value;
    setHud((prev) => ({
      time: timeRef.current,
      walking: playbackRef.current!.walkingAt(timeRef.current).length,
      occupancy: playbackRef.current!.occupancyAt(timeRef.current),
      riding: prev?.riding ?? new Map(),
      waiting: playbackRef.current!.waitingAt(timeRef.current).length,
    }));
  };
  /** Turn campus events on or off for the shown day. */
  const toggleEvents = (on: boolean) => {
    eventsOnRef.current = on;
    setEventsOn(on);
    changeDay(weekdayRef.current);
  };
  /** Start (or, with null, end) a simulated Red Sox game at Fenway on the shown day. */
  const playSimulatedGame = (game: SimulatedGame | null) => {
    simulatedGameRef.current = game;
    setSimulatedGame(game);
    const data = sourceData;
    const date = eventDayRef.current.date ?? (data ? eventDateFor(data, weekdayRef.current) : null)
      ?? (liveRef.current ? wallClockDate() : data ? dateForWeekday(data, weekdayRef.current) : null);
    planVenueEvents(date);
  };
  /** Play a specific date's events: switches to that date's weekday. */
  const pickEventDate = (date: string) => {
    pinnedDateRef.current = date;
    eventsOnRef.current = true;
    setEventsOn(true);
    changeDay(weekdayOf(date));
  };
  // ── Conditions engine: today's date and live weather in Clock mode, the picked weekday and shown
  // weather in playback, either overridden by a scenario. Days are simulated in a worker.
  const activeScenario = scenarioFile?.scenarios.find((row) => row.id === scenario);
  const conditionsInput = useMemo((): EngineInput | null => {
    if (!sourceData) return null;
    const w = weatherRef.current;
    const weather = w && w.source !== 'none' ? { condition: w.condition, temperatureF: w.temperatureF, precipitationMmPerHour: w.reading?.precipMmPerHour ?? null,
      windMph: w.wind.mph, source: w.source } : null;
    const shown = live ? { date: wallClockDate(), weekday: wallClockWeekday(), weather } : { date: dateForWeekday(sourceData, weekday), weekday, weather };
    const input = scenarioInput(shown, activeScenario);
    const day = input.weekday ?? weekday;
    // A scenario's own date plays that date's campus events; otherwise the usual event date.
    const scenarioDate = activeScenario?.overrides.date && weekdayOf(activeScenario.overrides.date) === day ? activeScenario.overrides.date : null;
    return { ...input, eventDate: eventsOnRef.current ? scenarioDate ?? eventDateFor(sourceData, day) : null };
    // weatherKey stands in for weatherRef, dayRequest for the event refs (eventsOn, pinned date).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceData, activeScenario, live, weekday, weatherKey, eventsOn, dayRequest]);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engineReady || !engine || engine.failed || !conditionsInput) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      setEngineStatus('building');
      engine.requestDay(conditionsInput.weekday ?? weekdayRef.current, conditionsInput).then((prepared) => {
        if (stale || !prepared) return;
        // A new day ends any incident scenario that was running on the old one (as a day change does).
        if (baselinePlaybackRef.current) { baselinePlaybackRef.current = null; incidentRunRef.current = null; setIncidentRun(null); }
        outdoorStaysRef.current.set(prepared.playback, prepared.outdoorStays);
        playbackRef.current = prepared.playback;
        setSimDay(prepared.day);
        setDayInfo(prepared.info);
        setEngineStatus('ready');
      }, (error: Error) => { if (!stale) { engineActiveRef.current = false; setEngineStatus('unavailable'); setEngineError(error.message); } });
    }, 300);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [engineReady, conditionsInput]);
  const chooseScenario = (id: string) => {
    setScenario(id);
    setComparison(null);
    const pinned = scenarioFile?.scenarios.find((row) => row.id === id)?.overrides.weekday;
    if (pinned !== undefined && pinned !== weekdayRef.current) {
      leaveLive();
      weekdayRef.current = pinned;
      setWeekday(pinned);
    }
  };
  const compareWithBaseline = () => {
    const engine = engineRef.current;
    if (!engine || !conditionsInput || !sourceData) return;
    const day = conditionsInput.weekday ?? weekdayRef.current;
    setComparison('loading');
    const baseline = { ...baselineInput(conditionsInput, scenarioFile ?? undefined, dateForWeekday(sourceData, day)), eventDate: conditionsInput.eventDate };
    engine.compare(day, conditionsInput, baseline).then(setComparison, () => setComparison(null));
  };
  const scenarioLook = activeScenario?.overrides.weather ? SCENARIO_LOOK[activeScenario.overrides.weather.condition] ?? null : null;

  /** Play a venue event's date from an hour before it starts, and fly to the venue. */
  const jumpToVenueEvent = (date: string, startSec: number) => {
    pickEventDate(date);
    scrub(Math.max(0, startSec - 3600));
    const venue = eventDayRef.current.events.find((e) => e.startSec === startSec)?.venue;
    if (venue) basemapRef.current?.flyTo(venue.position, 16.6);
  };
  const selectSource = (location: CampusLocation) => {
    setCampus(location.campus ?? 'charles-river');
    selectedRef.current = location.kind === 'outdoor' ? null : location.building;
    setSelected(selectedRef.current);
    basemapRef.current?.flyTo(location.position);
  };
  const refreshIncidentHud = () => {
    const playback = playbackRef.current;
    if (!playback) return;
    setHud((previous) => ({
      time: timeRef.current,
      walking: playback.walkingAt(timeRef.current).length,
      occupancy: playback.occupancyAt(timeRef.current),
      riding: previous?.riding ?? new Map(),
      waiting: playback.waitingAt(timeRef.current).length,
    }));
  };
  const startIncident = (kind: IncidentKind, locationId: string, duration: number, radiusMetres?: number, outdoorCrowd?: boolean) => {
    const baseline = playbackRef.current;
    if (!baseline || baselinePlaybackRef.current) throw new Error('Reset the current scenario before starting another incident.');
    const start = timeRef.current + (kind === 'meteor' ? METEOR_APPROACH_SECONDS : 0);
    if (start + duration > 86400) throw new Error('This incident would extend past midnight. Choose a shorter duration or an earlier simulation time.');
    const incident = { id: `incident-${weekdayRef.current}-${timeRef.current}`, kind, locationId, start, duration, radiusMetres,
      ...(kind === 'fire' && outdoorCrowd ? { outdoorCrowd: true } : {}) };
    // An area disaster can also be aimed at a landmark off the simulated campus (Fenway Park).
    const target = kind === 'meteor' || kind === 'earthquake' ? withLandmarkTarget(baseline.data, locationId) : baseline.data;
    const location = target.locations.find((entry) => entry.id === locationId)!;
    // The trucks depend only on the fire's active period, so they are planned first: the outdoor crowd keeps clear of where they park.
    const responsePlan = kind === 'fire' ? (transitRef.current
      ? planDisasterFireResponse({ incident, location, hazard: { activeUntil: incident.start + duration } }, transitRef.current.data, baseline.data.buildings)
      : { plan: null, reason: 'no-road-data' as const }) : null;
    const fireResponse = responsePlan?.plan ?? null;
    const fireScene = incident.outdoorCrowd ? {
      // Streets (Boston Fire's network, once loaded) and the surface Green Line trackbed and platforms in the median.
      roads: [...(fireNetworkRef.current ? roadsNear(fireNetworkRef.current, location.position, 600) : []),
        ...segmentsNear((transitRef.current?.feed.tracks ?? []).filter((track) => track.route.startsWith('Green-')).map((track) => track.points), location.position, 600, 5.5)],
      apparatus: (fireResponse?.trucks ?? []).flatMap((truck) => fireResponseAt(fireResponse, truck.fightStart).filter((frame) => frame.id === truck.id).map((frame) => frame.position)),
    } : undefined;
    const result = applyIncident(target, incident, sourceData
      ? { sourceData, weekday: weekdayRef.current, transit: transitServiceRef.current, ...(fireScene ? { fireScene } : {}) } : undefined);
    const playback = new Playback(result.day);
    baselinePlaybackRef.current = baseline;
    playbackRef.current = playback;
    leaveLive();
    // A meteor also hits venue-event visitors (fans) in the open or in an open-air venue: counted apart from students.
    const fans = kind === 'meteor' ? fanCasualties(visitorPlanRef.current, location.position, result.hazard?.radiusMetres ?? radiusMetres ?? 0, incident.start, incident.id) : undefined;
    const run = { incident, location, fans, fireResponse, fireResponseUnavailable: responsePlan?.reason,
      hazard: result.hazard, casualties: result.casualties, assemblyLocation: result.assemblyLocation, assemblyClearanceMetres: result.assemblyClearanceMetres ?? null, affectedAgents: result.affectedAgents, endsAt: result.endsAt, participants: result.participants, crowd: result.crowd };
    incidentRunRef.current = run;
    setIncidentRun(run);
    refreshIncidentHud();
    if (kind === 'fire-alarm') dispatchFire(run, baseline.data.buildings.find((b) => b.id === run.location.building)?.polygon);
  };
  // Boston Fire's first alarm: planned once (routes, speeds, timeline), then drawn from sim time.
  const dispatchFire = (run: IncidentRun, polygon: [number, number][] | undefined) => {
    setResponsePending(true);
    void (fireRef.current ?? Promise.resolve(null)).then((fire) => {
      setResponsePending(false);
      if (!fire || incidentRunRef.current?.incident.id !== run.incident.id) return;
      const response = planFireResponse(fire.network, {
        id: run.incident.id, start: run.incident.start, endsAt: run.endsAt, targetName: run.location.name,
        position: run.location.position, polygon,
      }, { signals: signalOracle(registeredSignals().approaches) });
      const next = { ...run, response };
      incidentRunRef.current = next;
      setIncidentRun(next);
    });
  };
  const toggleSiren = (on: boolean) => {
    setSiren(on);
    if (on) { sirenRef.current ??= new FireSiren(); sirenRef.current.enable(); }
    else sirenRef.current?.disable();
  };
  const resetIncident = () => {
    if (baselinePlaybackRef.current) playbackRef.current = baselinePlaybackRef.current;
    baselinePlaybackRef.current = null;
    incidentRunRef.current = null;
    setIncidentRun(null);
    refreshIncidentHud();
  };
  const changeMobilityMode = (mode: MobilityMode) => {
    mobilityModeRef.current = mode;
    setMobilityMode(mode);
    selectedMobilityRef.current = null;
    setSelectedMobility(null);
  };
  const selectMobility = (item: MobilityPoint | MobilityArc) => {
    if (!showCountsRef.current) toggleCounts(); // picking a site from the list shows it on the map
    selectedMobilityRef.current = item.id;
    setSelectedMobility(item.id);
    const position: [number, number] = item.mobilityKind === 'flow'
      ? [(item.from[0] + item.to[0]) / 2, (item.from[1] + item.to[1]) / 2]
      : item.position;
    basemapRef.current?.flyTo(position, 16);
  };
  // Ask tab: answers come from the same simulation, routes and published classes the map shows.
  const meetings = useMemo(
    () => (sourceData ? askMeetings(sourceData) : []),
    [sourceData],
  );
  const askPlayback = playbackRef.current;
  const askContext: AskContext | null = hud && askPlayback
    ? {
        locations: askPlayback.locations.filter((l) => l.kind !== 'off-campus'),
        walkRoutes: walkRoutesRef.current,
        meetings,
        occupancyAt: (t) => askPlayback.occupancyAt(t),
        time: Math.floor(hud.time / 60) * 60,
        weekday,
        campus,
        data: sourceData ?? undefined,
      }
    : null;
  const showAsk = (show: AskShow | null) => {
    askRouteRef.current = show?.route ?? null;
    if (!show) {
      selectedRef.current = null;
      setSelected(null);
      return;
    }
    if (show.select) {
      if (show.select.campus) setCampus(show.select.campus);
      selectedRef.current = show.select.building;
      setSelected(show.select.building);
    } else {
      selectedRef.current = null;
      setSelected(null);
    }
    const pts = [...show.points, ...(show.route?.path ?? [])];
    if (!pts.length) return;
    const lngs = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    const span = Math.max(Math.max(...lngs) - Math.min(...lngs), Math.max(...lats) - Math.min(...lats));
    const zoom = span < 0.0015 ? 17.4 : span < 0.004 ? 16.8 : span < 0.008 ? 16.1 : 15.5;
    basemapRef.current?.flyTo([(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2], zoom);
  };

  const currentCampus = campuses.find((c) => c.id === campus);
  const ranked = hud
    ? hud.occupancy.filter((o) => o.location.kind !== 'outdoor' && (o.location.campus ?? 'charles-river') === campus).sort((a, b) => b.share - a.share)
    : [];
  // The camera tour only cares which places are in the campus (it re-picks when that set changes),
  // so it gets a new list only then, not on every HUD refresh.
  const tourKey = ranked.map((o) => o.location.id).sort().join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tourLocations = useMemo(() => ranked.map((o) => o.location), [tourKey]);
  // Re-read every render (the HUD re-renders twice a second), so "N min" counts down live.
  const transit = transitRef.current;
  const stations = transit?.data.stops.filter((s) => s.kind === 'station' && s.area === campus) ?? [];
  // The panel follows the same source as the map: live feeds, or the schedule when playing back.
  const source: TransitSource | null = transit ? (live ? transit.feed : transit.schedule) : null;
  const busArrivals = transit && source ? nextBuses(transit.data, source, campus) : [];
  const shuttleArrivals = transit && source ? nextBuses(transit.data, source, campus, 'shuttle') : [];
  const bikes = bikesRef.current;
  const docks = bikes?.data.stations.filter((s) => s.campus === campus) ?? [];
  const ridingHere = hud?.riding.get(campus) ?? 0;

  /*
   * The top tabs drive the panel. Picking one selects the tab it owns and opens
   * the sheet; Live closes it, so the map is never covered unless you asked for
   * something to read.
   */
  /*
   * The places the panel works from.
   *
   * The search narrows this list rather than replacing it: the category, the
   * order and "Show all" all still apply to what you have typed, so a search is
   * a filter on the question you were already asking and not a different screen.
   * The list itself stays at its top three (panel/Places.tsx).
   */
  const searchedPlaces = (() => {
    const q = search.trim().toLowerCase();
    if (!q) return ranked;
    return ranked.filter((o) => `${o.location.name} ${o.location.short}`.toLowerCase().includes(q));
  })();

  /*
   * The what-if's centre, radius and catchment.
   *
   * Fenway is fixed for the Red Sox game, because a sell-out crowd arrives at one
   * place; everything else centres on whatever is selected, falling back to the
   * busiest building so the circle is never nowhere. hazardZone is the engine's
   * own test, so the chips below the form name exactly the buildings the run
   * will act on rather than an approximation of them.
   */
  const fenway = eventSourcesRef.current.calendar?.venues.find((v) => /fenway/i.test(v.name)) ?? null;
  const whatIfCentre = (() => {
    if (whatIfKind === 'red-sox') return fenway ? { id: fenway.id, name: fenway.name, position: fenway.position as [number, number] } : null;
    const byId = whatIfCentreId ? ranked.find((o) => o.location.id === whatIfCentreId)?.location : undefined;
    const bySelection = selected ? ranked.find((o) => o.location.building === selected)?.location : undefined;
    const pick = byId ?? bySelection ?? ranked.find((o) => o.location.kind !== 'outdoor')?.location;
    return pick ? { id: pick.id, name: pick.name, position: pick.position } : null;
  })();

  const whatIfHue = SCENARIOS.find((sc) => sc.id === whatIfKind)?.hue ?? 'neutral';
  const HUE_RGB: Record<string, string> = {
    teal: '95, 211, 195', green: '134, 211, 154', violet: '183, 174, 247',
    orange: '244, 172, 131', pink: '241, 167, 198', neutral: '245, 245, 247',
  };

  /*
   * The buildings the circle catches, as chips in their own crowd colours.
   *
   * Memoised on the centre and the radius, and nothing else. hazardZone walks
   * every building ring on the campus with a point-to-polygon distance for each,
   * and this panel re-renders twice a second as the clock ticks: recomputing it
   * per render froze the tab outright at a 500 m radius. The crowd figures inside
   * the chips go stale between recomputes, which is the right trade; the chips
   * answer "which buildings", and the list only changes when the circle does.
   */
  const whatIfZoneKey = `${view}|${whatIfCentre?.id ?? ''}|${Math.round(whatIfRadius)}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const whatIfZone = useMemo(() => {
    const day = baseDayRef.current;
    if (!day || !whatIfCentre || view !== 'log') return { chips: [], count: 0 };
    const target = day.locations.find((l) => l.id === whatIfCentre.id)
      ?? ({ ...whatIfCentre, kind: 'classroom', capacity: 0, building: '', short: whatIfCentre.name } as unknown as CampusLocation);
    const zone = hazardZone(day, target, whatIfRadius);
    const found = zone.locationIds
      .map((id) => ranked.find((o) => o.location.id === id))
      .filter((o): o is NonNullable<typeof o> => Boolean(o));
    const chips = found
      .slice(0, 12)
      .map((o) => {
        const d = activityDisplay({
          count: o.count, capacity: o.location.capacity, share: o.share,
          modeled: o.modeled ?? o.location.activityModeled,
          capacityBasis: o.location.capacityBasis, kind: o.location.kind,
        });
        return { id: o.location.id, name: o.location.short || o.location.name, icon: d.icon, style: d.style as Record<string, string> };
      });
    return { chips, count: found.length };
  }, [whatIfZoneKey]);

  // Read by the frame loop, which owns the projection and runs whether or not
  // React has re-rendered.
  circleFrameRef.current = {
    centre: view === 'log' && whatIfCentre ? whatIfCentre.position : null,
    radius: whatIfRadius,
    rgb: HUE_RGB[whatIfHue],
    name: whatIfCentre?.name ?? null,
  };

  const pickScenario = (next: ScenarioKind) => {
    setWhatIfKind(next);
    setWhatIfRadius(defaultRadius(next));
    setWhatIfMinutes(next === 'fire-drill' || next === 'fire-alarm' ? 30 : 120);
    setWhatIfOutside(gathers(next));
  };

  /** Clamp a dragged radius to the scenario's own limits, in 10 m steps. */
  const setRadiusClamped = (metres: number) => {
    const { min, max, step } = radiusLimits(whatIfKind);
    setWhatIfRadius(Math.min(max, Math.max(min, Math.round(metres / step) * step)));
  };

  /*
   * Starting a what-if. Six of the seven are incidents the engine runs directly.
   * The Red Sox game is not an incident at all: it is a crowd, and the engine
   * already models Fenway's games through the venue calendar, so it plays the
   * next real game rather than inventing one.
   */
  const nextFenwayGame = (() => {
    const calendar = eventSourcesRef.current.calendar;
    if (!calendar || !fenway) return null;
    return calendar.events
      .filter((e) => e.venueId === fenway.id && /red sox|baseball|mlb/i.test(`${e.name} ${e.kind}`))
      .sort((a, b) => a.start.localeCompare(b.start))[0] ?? null;
  })();

  const startWhatIf = () => {
    if (whatIfKind === 'red-sox') {
      if (!nextFenwayGame) return;
      const start = new Date(nextFenwayGame.start);
      jumpToVenueEvent(nextFenwayGame.start.slice(0, 10), start.getHours() * 3600 + start.getMinutes() * 60);
      return;
    }
    if (!whatIfCentre) return;
    startIncident(whatIfKind, whatIfCentre.id, whatIfMinutes * 60, whatIfRadius, whatIfOutside);
  };

  /*
   * The selected building's day, hour by hour.
   *
   * occupancyAt() computes every location at a given second, so fifteen hours is
   * fifteen of those: affordable once, ruinous per render, which is why this is
   * memoised on the building and the simulated day rather than on the clock. The
   * bars answer "when should I go", and that shape does not change minute to
   * minute.
   */
  const detailLocation = view === 'analytics' && analyticsSub === 'places' && selected
    ? ranked.find((o) => o.location.building === selected)?.location ?? null
    : null;
  const detailKey = `${detailLocation?.id ?? ''}|${weekday}|${dayRequest}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const detailHours = useMemo<HourSample[]>(() => {
    const playback = playbackRef.current;
    if (!detailLocation || !playback) return [];
    const out: HourSample[] = [];
    for (let hour = FIRST_HOUR; hour <= LAST_HOUR; hour++) {
      const sec = hour * 3600;
      const here = playback.occupancyAt(sec).find((o) => o.location.id === detailLocation.id);
      const d = activityDisplay({
        count: here?.count ?? 0,
        capacity: detailLocation.capacity,
        share: here?.share ?? 0,
        modeled: here?.modeled ?? detailLocation.activityModeled,
        capacityBasis: detailLocation.capacityBasis,
        kind: detailLocation.kind,
      });
      out.push({
        sec,
        label: formatClock(sec).replace(':00', ''),
        percent: d.percent,
        icon: d.icon,
        style: d.style as Record<string, string>,
        known: d.hasPercentage,
        word: d.secondary,
      });
    }
    return out;
  }, [detailKey]);

  /*
   * The detail header's own reading, which is the live one rather than an hourly
   * sample: the bars are the day, this is right now.
   */
  const detailEntry = detailLocation ? ranked.find((o) => o.location.id === detailLocation.id) ?? null : null;
  const detailDisplay = activityDisplay({
    count: detailEntry?.count ?? 0,
    capacity: detailLocation?.capacity ?? 0,
    share: detailEntry?.share ?? 0,
    modeled: detailEntry?.modeled ?? detailLocation?.activityModeled,
    capacityBasis: detailLocation?.capacityBasis,
    kind: detailLocation?.kind,
  });

  /** An event in this building today, so the detail can point at it. */
  const detailEvent = (() => {
    if (!detailLocation || !sourceData) return null;
    const today = simDay?.eventDate;
    const found = sourceData.events.find((e) => e.locationId === detailLocation.id && (!today || e.start.slice(0, 10) === today));
    if (!found) return null;
    return {
      id: found.id,
      name: found.name,
      when: new Date(found.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      place: found.roomCode || found.locationName || detailLocation.short,
      imageUrl: found.imageUrl,
    };
  })();

  /*
   * One search, read by every list in the panel. Declared here because the
   * events list below is the first to use it and `const` has no hoisting: with
   * it further down, opening the Events tab threw before the panel rendered.
   */
  const matchesQuery = (text: string) => !search.trim() || text.toLowerCase().includes(search.trim().toLowerCase());

  /*
   * What the Events tab is showing.
   *
   * Today, tomorrow or the rest of the week from the simulated date, in starting
   * order, narrowed by the search. The dates are compared as the leading yyyy-mm-dd
   * of the event's own ISO start, which is already local to Boston in the data, so
   * no timezone conversion can shift one into the wrong day.
   */
  const eventBaseDate = simDay?.eventDate ?? null;
  const shownEvents = (() => {
    if (!sourceData || !eventBaseDate) return [];
    const base = new Date(`${eventBaseDate}T12:00:00`);
    const iso = (offset: number) => {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, 12);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const inRange = (date: string) =>
      eventWhen === 'today' ? date === eventBaseDate
      : eventWhen === 'tomorrow' ? date === iso(1)
      : date >= eventBaseDate && date <= iso(6);
    return sourceData.events
      .filter((event) => inRange(event.start.slice(0, 10)))
      .filter((event) => matchesQuery(`${event.name} ${event.locationName ?? ''} ${event.roomCode ?? ''}`))
      .sort((a, b) => a.start.localeCompare(b.start));
  })();
  const openEvent = openEventId ? shownEvents.find((event) => event.id === openEventId) ?? null : null;
  /** The mapped building an event sits in, if its venue is one the model knows. */
  const eventLocation = (event: { locationId: string | null }) =>
    (event.locationId && baseDayRef.current?.locations.find((l) => l.id === event.locationId)) || null;

  /*
   * The mobility lists, each cut to three.
   *
   * A table of every stop and every dock answered "show me the data". Standing
   * on the map the question is "what is the next train from the stop I am beside,
   * and is there a bike at the dock on the corner", which is three rows; the
   * search above reaches the rest, which is what let the tables go.
   */
  const stopRows: StopRow[] = stations
    .map((stop): StopRow => {
      // Trains only: Kenmore is also a stop for the 57 and other buses.
      const next: Partial<Record<0 | 1, { route: string; time: number }>> = {};
      for (const a of source?.nextArrivals(stop.id) ?? []) {
        if (a.route.startsWith('Green-') && (!next[a.direction] || a.time < next[a.direction]!.time)) next[a.direction] = a;
      }
      return {
        id: stop.id,
        name: stop.short || stop.name,
        branches: stop.routes.filter((r) => r.startsWith('Green-')).map((r) => r.replace('Green-', '')),
        inbound: next[1] ? minutesUntil(next[1]!.time) : null,
        outbound: next[0] ? minutesUntil(next[0]!.time) : null,
      };
    })
    .filter((stop) => matchesQuery(stop.name))
    .slice(0, 3);

  const shuttleRows: ShuttleRow[] = shuttleArrivals
    .map((bus): ShuttleRow => ({ id: bus.route, stop: bus.stop, destination: bus.longName, due: minutesUntil(bus.time) }))
    .filter((bus) => matchesQuery(`${bus.stop} ${bus.destination}`))
    .slice(0, 2);

  const dockRows: DockRow[] = (bikes && hud
    ? docks.flatMap((dock): DockRow[] => {
        // "Now" is the shown time: the live count in Live mode, else an estimate.
        // A dock the feed has never reported gets no estimate at all, and a row
        // of dashes is worse than one fewer row, so it drops out.
        const estimate = estimateDock(dock, bikes.feed.status(dock), bikes.data.binSeconds, wallClockSeconds(), live ? wallClockSeconds() : hud.time);
        if (!estimate) return [];
        return [{
          id: dock.id,
          name: dock.short,
          bikes: estimate.bikes,
          // Null where the feed does not break e-bikes out; the row then shows none.
          ebikes: estimate.ebikes ?? 0,
          empty: estimate.docks,
          estimated: estimate.estimated,
        }];
      })
    : []
  )
    .filter((dock) => matchesQuery(dock.name))
    .slice(0, 3);

  /*
   * What Focus mode keeps a pill on: the rows the panel is showing.
   *
   * Tag ids are `location.building`, the same key the rows compare against
   * `selected`, so a row and its tag always mean the same building. With no
   * panel open this is empty and BuildingTags falls back to the busiest few.
   */
  const listedPlaces = view === 'analytics' && analyticsSub === 'places'
    ? orderPlaces(searchedPlaces, category, sort).slice(0, listExpanded ? 8 : 3)
    : [];
  /*
   * What keeps a full pill in Focus mode: whatever the open panel is talking
   * about. For Analytics that is the rows on screen; for Log it is every
   * building the circle catches, so the radius you are dragging and the
   * buildings it will act on are the same thing on the map.
   */
  const focusIds = view === 'log'
    ? whatIfZone.chips.map((b) => ranked.find((o) => o.location.id === b.id)?.location.building)
    : listedPlaces.map((o) => o.location.building);
  const focusKey = focusIds.join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  focusRef.current = useMemo(
    () => new Set(focusIds.filter((id): id is string => Boolean(id))),
    [focusKey],
  );

  const pickTagMode = (mode: TagMode) => {
    setTagMode(mode);
    try {
      localStorage.setItem(TAG_MODE_KEY, mode);
    } catch {
      // Private browsing refuses writes; the choice still holds for this session.
    }
  };

  viewRef.current = view;

  /** Picking the open tab closes it, so the map uncovered needs no tab of its own. */
  const selectView = (next: View) => {
    const closing = view === next;
    setView(closing ? null : next);
    setDetent(closing ? 'peek' : 'full');
  };

  /* What the left rail shows: the layers drawn on the map, each a toggle. */
  /*
   * Each layer carries its own hue so that six lit toggles still read as six
   * different things. The hues are deliberately not the crowd colours: a layer
   * being on is not a measurement. Campus events take the calendar rather than
   * the people glyph, which now belongs to the crowd scale alone.
   */
  const railItems: RailItem[] = [
    { id: 'transit', label: showTransit ? 'Hide MBTA' : 'Show MBTA', icon: <HudIcons.transit />, on: showTransit, hue: 'green', onSelect: toggleTransit },
    ...(bikes ? [{ id: 'bikes', label: showBikes ? 'Hide Bluebikes' : 'Show Bluebikes', icon: <HudIcons.bikes />, on: showBikes, hue: 'orange' as const, onSelect: toggleBikes }] : []),
    ...(mapKind === 'mapbox'
      ? [{ id: 'traffic', label: showTraffic ? 'Hide traffic' : 'Show traffic', icon: <HudIcons.traffic />, on: showTraffic, hue: 'pink' as const, onSelect: () => setShowTraffic((v) => !v) }]
      : []),
    { id: 'parking', label: showParking ? 'Hide parking' : 'Show parking', icon: <HudIcons.parking />, on: showParking, hue: 'teal', onSelect: toggleParking },
    { id: 'counts', label: showCounts ? 'Hide traffic counts' : 'Show traffic counts', icon: <HudIcons.counts />, on: showCounts, hue: 'neutral', onSelect: toggleCounts },
    ...(sourceData
      ? [{ id: 'events', label: eventsOn ? 'Hide campus events' : 'Show campus events', icon: <HudIcons.calendar />, on: eventsOn, hue: 'violet' as const, onSelect: () => toggleEvents(!eventsOn) }]
      : []),
  ];

  /*
   * The legend, built from the scale rather than written out: the ranges come
   * from each level's own `min`, so a threshold changed in theme/crowd.ts can
   * never leave a stale number on the map.
   */
  const legendLevels = CROWD_LEVELS.map((level, i) => {
    const next = CROWD_LEVELS[i + 1];
    const from = Math.round(level.min * 100);
    const Icon = HudIcons[level.icon];
    return {
      key: level.key,
      label: level.label,
      range: next ? (i === 0 ? `<${Math.round(next.min * 100)}%` : `${from}–${Math.round(next.min * 100) - 1}%`) : `${from}%+`,
      icon: <Icon />,
    };
  });

  /*
   * Sub-tabs inside the panel. 'ask' is not among them: Ask is the bar at the
   * bottom of the screen now, and listing it here as well would be the same
   * thing in two places.
   */
  // The map dims a little behind an open sheet (styles.css, .sheet-dim).
  const dim = detent === 'peek' ? 'off' : phone ? detent : 'open';
  // Derived, not stored: a character removed from the list closes its own card with no extra work.
  const openPersona = personas.find((p) => p.id === openPersonaId) ?? null;
  const hiddenNote = (what: string, show: () => void) => (
    <p className="layer-note">
      {what} hidden on the map. <button className="link" onClick={show}>Show</button>
    </p>
  );

  return (
    /* 'none' rather than omitting the attribute: a missing attribute cannot be
       selected on, and the closed state is the one that has to hide the panel. */
    <div
      className={`app${clean ? ' is-clean' : ''}${introPhase === 'sky' || introPhase === 'drop' || introPhase === 'land' ? ' is-intro' : ''}${introPhase === 'swoop' ? ' is-swoop' : ''}`}
      data-view={view ?? 'none'}
    >
      {clean && <div className="clean-hint" role="status">Press H to show the interface</div>}
      <div ref={containerRef} />
      {light === 'auto' && hud && (
        // Auto lighting: a blue multiply veil darkens the chosen preset to the sun's brightness (set per frame).
        <div ref={veilRef} className="light-veil" aria-hidden="true" style={{ opacity: daylightAt(hud.time).veil }} />
      )}
      <BuildingTags ref={tagsRef} onSelect={selectBuilding} />
      <WhatIfCircle ref={circleRef} onRadius={setRadiusClamped} onDragEnd={() => undefined} />
      <TransitTags ref={transitTagsRef} />
      <PlaceTags ref={placeTagsRef} />
      {showParking && <ParkingTags ref={parkingTagsRef} />}

      {/* The intro's haze and clouds, over the still and then the live map until the camera has dropped in. */}
      {(introPhase === 'sky' || introPhase === 'drop' || introPhase === 'land') && <IntroSky phase={introPhase} light={shownLight} />}
      <IntroScreen progress={loadProgress} preset={shownLight} />

      {/*
        The chrome. Each piece owns a corner so the map stays one uninterrupted
        surface: brand top left, layers down the left edge, views across the top,
        clock and weather top right, time bottom left, ask bottom centre.
      */}
      {hud && !clean && (
        <div className="hud">
          <HudBrand
            name="Flowcast"
            campus={currentCampus?.name.replace(' Campus', '') ?? 'BU'}
            weekday={WEEKDAYS[weekday]}
            campuses={campuses}
            onPickCampus={(id) => {
              const next = campuses.find((c) => c.id === id);
              if (next) goToCampus(next);
            }}
          />

          <HudRail items={railItems} tagMode={tagMode} onTagMode={pickTagMode} />

          <HudTabs tabs={VIEW_TABS} active={view} onSelect={selectView} />

          {askContext && (
            <HudAsk>
              <AskPanel context={askContext} initialQuestion={START_QUESTION} onShow={showAsk} onSelect={selectSource} />
            </HudAsk>
          )}

          {/* Bottom left, under the join card: what the three colours mean. */}
          <HudLegend levels={legendLevels} />

          {/*
            Everything about when, in one block: the clock and the temperature to
            read, and under them the day, the drag bar and the transport that
            change them.
          */}
          <HudStatus
            time={formatClock(hud.time)}
            live={live}
            day={
              sourceData && (
                // pickEventDate pins the date and switches the simulated day to
                // its weekday, which is what picking a date has to mean here:
                // the simulation runs a representative week.
                <HudDate value={dateForWeekday(sourceData, weekday)} onPick={pickEventDate} />
              )
            }
            scrubber={
              <input
                type="range"
                className="scrubber"
                min={range[0]}
                max={range[1]}
                step={60}
                value={hud.time}
                onInput={(e) => scrub(Number(e.currentTarget.value))}
                aria-label="Time of day"
                aria-valuetext={formatClock(hud.time)}
              />
            }
            controls={
              <HudTime
                playing={playing}
                onPlay={togglePlaying}
                speed={speed}
                speeds={SPEEDS}
                onSpeed={changeSpeed}
                live={live}
                onLive={goLive}
              />
            }
          >
            <span className="weather-chip-slot" ref={setWeatherChip} />
          </HudStatus>

          {/*
            The bottom-left slot: the invitation to join, or the details of the character you just
            clicked. One at a time and at a fixed height, because the performance readout stacks
            directly above it (hud.css). The details card reads the simulation clock, so it agrees
            with the character walking on screen.
          */}
          <div className="join-slot">
            {openPersona ? (
              <PersonaDetails persona={openPersona} nowMs={hud.time * 1000} onClose={() => setOpenPersonaId(null)} />
            ) : (
              <JoinQrCard />
            )}
          </div>
        </div>
      )}

      <MemoPerfMonitor counts={getPerfCounts} />
      {mapKind && (
        <MemoWeatherControls basemap={basemapRef.current} light={shownLight} simTime={hud?.time} live={live} onChange={onWeather}
          selectedDate={live ? wallClockDate() : conditionsInput?.date ?? (sourceData ? dateForWeekday(sourceData, weekday) : undefined)} panel={weatherPanel} chip={weatherChip} onOpen={openWeather} forceMode={scenarioLook} />
      )}
      <div className="sheet-dim" data-dim={dim} aria-hidden="true" />

      <Sheet
        phone={phone}
        detent={detent}
        onDetent={setDetent}
        onCover={onSheetCover}
        header={
          /* The panel's own title. The wordmark and the campus moved to the
             brand in the top left, which left this header holding nothing but
             padding; it now says which tab you are reading. */
          <h1 className="sheet-title">{view ? VIEW_TITLES[view] : ''}</h1>
        }
        subheader={hud && (
          <p className="sheet-stats">
            <span><b>{hud.walking.toLocaleString()}</b> walking</span>
            {hud.waiting > 0 && <span><b>{hud.waiting.toLocaleString()}</b> at stops</span>}
            {hud.public ? <span><b>{hud.public.toLocaleString()}</b> public on streets</span> : null}
            {bikes && showBikes && <span><b>{ridingHere}</b> on Bluebikes</span>}
            {hud.outdoors ? <span><b>{hud.outdoors.toLocaleString()}</b> by the river</span> : null}
          </p>
        )}
        actions={<>
          {askContext && <LiveVoice compact context={{ weekday, time: askContext.time,
            campus: campus === 'fenway' || campus === 'medical' ? campus : 'charles-river' }}
            onAnswer={(answer) => {
              if (answer.show) showAsk({ ...answer.show,
                select: askContext.locations.find(location => location.id === answer.show?.select) ?? null });
            }} />}
          <span className="weather-chip-slot" ref={setWeatherChip} />
        </>}
      >
        <div className="sheet-context">
          <p className="model-note">
            {sourceData ? 'Campus simulation · Fall 2026' : 'Campus simulation · Demo'}
            {sourceData && ` · ${dateForWeekday(sourceData, weekday)} · Boston time`}
          </p>
          {!live && scheduleError && <p role="alert" className="alert">Transit playback unavailable: {scheduleError}</p>}
          {sourceData && (
            <label className="day-picker">
              Simulation day
              <select value={weekday} onChange={(event) => changeDay(Number(event.target.value))}>
                {WEEKDAYS.map((name, index) => <option key={name} value={index}>{name}</option>)}
              </select>
            </label>
          )}
          {campuses.length > 1 && (
            <div className="campuses" role="group" aria-label="Campus">
              {campuses.map((c) => (
                <button key={c.id} onClick={() => goToCampus(c)} aria-pressed={c.id === campus}>
                  {c.name.replace(' Campus', '')}
                </button>
              ))}
            </div>
          )}
        </div>

        {/*
          No sub-tab row. Each top tab owns one panel, so the only navigation is
          the three tabs across the top; a second row of eight underneath them
          was the thing this layout set out to remove.
        */}
        {hud && view === 'log' && (
          <section id="hud-panel-log" role="tabpanel" aria-labelledby="hud-tab-log">
            <div className="pn-search">
              <HudIcons.search />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                placeholder="Search a building to target"
                aria-label="Search a building to target"
              />
              {search && (
                <button type="button" onClick={() => setSearch('')} aria-label="Clear search">
                  <HudIcons.close />
                </button>
              )}
            </div>

            {/* While a what-if is running, the panel is its readout; the form
                comes back when it is reset. */}
            {incidentRun ? (
              /* The run's readout keeps everything main added to it: the simulated
                 game, its estimate, and the landmarks a meteor can be aimed at. */
              <IncidentPanel locations={ranked.map((entry) => entry.location)} time={hud.time} run={incidentRun}
                onStart={startIncident} onReset={resetIncident} onLocate={selectSource}
                siren={siren} onSiren={toggleSiren} responsePending={responsePending}
                game={simulatedGame} gameEstimate={eventDay.events.find((e) => e.event.id === GAME_ID) ?? null}
                onGame={playSimulatedGame} landmarks={LANDMARK_TARGETS} />
            ) : (
              <>
                {search.trim() && (
                  <div className="pn-card">
                    <p className="pn-label">Pick a building · top {Math.min(3, searchedPlaces.length)}</p>
                    <ol className="pn-rows">
                      {searchedPlaces.slice(0, 3).map((o) => (
                        <li key={o.location.id}>
                          <button
                            type="button"
                            className="pn-row"
                            aria-pressed={whatIfCentre?.id === o.location.id}
                            onClick={() => {
                              setWhatIfCentreId(o.location.id);
                              setSearch('');
                            }}
                          >
                            <span className="pn-tile pn-tile--plain" dangerouslySetInnerHTML={{ __html: CENTRE_PIN }} />
                            <span className="pn-name">{displayName(o.location.name)}</span>
                            <span className="pn-value" />
                            <span className="pn-chev" aria-hidden="true">›</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                    {searchedPlaces.length === 0 && <p className="pn-empty">No matches. Try a building code like CAS.</p>}
                  </div>
                )}

                <WhatIfForm
                  kind={whatIfKind}
                  onKind={pickScenario}
                  centreName={whatIfCentre?.name ?? null}
                  radius={whatIfRadius}
                  onRadius={setRadiusClamped}
                  affected={whatIfZone.chips}
                  affectedCount={whatIfZone.count}
                  minutes={whatIfMinutes}
                  onMinutes={setWhatIfMinutes}
                  outside={whatIfOutside}
                  onOutside={setWhatIfOutside}
                  startLabel={whatIfKind === 'red-sox'
                    ? (nextFenwayGame ? `Play ${nextFenwayGame.name}` : 'No Fenway game in the calendar')
                    : `Start at ${formatClock(hud.time)}`}
                  onStart={startWhatIf}
                  canStart={whatIfKind === 'red-sox' ? Boolean(nextFenwayGame) : Boolean(whatIfCentre)}
                  onAssumptions={() => setAssumptionsOpen((v) => !v)}
                />

                {assumptionsOpen && (
                  <div className="pn-card pn-split">
                    {DISASTER_LIMITATIONS.map((line) => (
                      <p key={line}>{line}</p>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        )}
        {/*
          Ask is the bar at the bottom of the screen, not a panel here as well.
          It is rendered once, unconditionally, for the same reason main began
          keeping this section mounted and merely hidden: multi-turn chat has to
          keep its history when you look at something else.
        */}
        {/* Events: what is on, led by the photograph. */}
        {hud && view === 'events' && sourceData && baseDayRef.current && (
          <section id="hud-panel-events" role="tabpanel" aria-labelledby="hud-tab-events">
            <div className="pn-search">
              <HudIcons.search />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                placeholder="Search events or places"
                aria-label="Search events or places"
              />
              {search && (
                <button type="button" onClick={() => setSearch('')} aria-label="Clear search">
                  <HudIcons.close />
                </button>
              )}
            </div>

            {openEvent ? (
              <EventDetail
                event={openEvent}
                onBack={() => setOpenEventId(null)}
                onShow={(event) => {
                  const where = eventLocation(event);
                  if (where) selectSource(where);
                }}
                buildingName={eventLocation(openEvent)?.name ?? null}
              />
            ) : (
              <EventsList
                events={shownEvents}
                when={eventWhen}
                onWhen={(w) => {
                  setEventWhen(w);
                  setEventsExpanded(false);
                }}
                expanded={eventsExpanded}
                onExpand={setEventsExpanded}
                onOpen={(event) => setOpenEventId(event.id)}
                nowSec={hud.time}
              />
            )}

            {/* The scheduling tools stay: making an event is a different job from
                reading what is on, and nothing in the handoff replaces them. */}
            <EventsPanel day={simDay} data={sourceData} locations={baseDayRef.current.locations} eventsOn={eventsOn}
              onToggle={toggleEvents} onPickDate={pickEventDate} onShow={selectSource}
              venueDay={eventDay} calendar={eventSourcesRef.current.calendar} popularity={eventSourcesRef.current.popularity}
              time={hud.time} onShowVenue={(position) => basemapRef.current?.flyTo(position, 16.6)} onJump={jumpToVenueEvent} />
          </section>
        )}

        {/* Analytics: the campus measured. Search first, because finding one
            building is the common case; the full ranking is the fallback. */}
        {hud && view === 'analytics' && (
          <section id="hud-panel-analytics" role="tabpanel" aria-labelledby="hud-tab-analytics">
            {/* Search first: finding one building is the common case, and the
                query narrows the list below rather than replacing it. */}
            <div className="pn-search">
              <HudIcons.search />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                placeholder={SEARCH_PLACEHOLDER[analyticsSub]}
                aria-label={SEARCH_PLACEHOLDER[analyticsSub]}
              />
              {search && (
                <button type="button" onClick={() => setSearch('')} aria-label="Clear search">
                  <HudIcons.close />
                </button>
              )}
            </div>

            <div className="pn-sub" role="group" aria-label="Analytics subject">
              {ANALYTICS_SUBS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  data-hue={t.hue}
                  aria-pressed={analyticsSub === t.id}
                  onClick={() => {
                    setAnalyticsSub(t.id);
                    // The query means something different in each subject, so it
                    // does not carry across: "Mugar" is not a dock.
                    setSearch('');
                  }}
                >
                  <span className="pn-sub-icon">{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </div>

            {analyticsSub === 'places' && detailLocation && (
              <>
                <BuildingDetail
                  location={detailLocation}
                  percent={detailDisplay.percent}
                  level={{ icon: detailDisplay.icon, word: detailDisplay.secondary, style: detailDisplay.style as Record<string, string> }}
                  known={detailDisplay.hasPercentage}
                  hours={detailHours}
                  nowHour={Math.floor(hud.time / 3600)}
                  event={detailEvent}
                  backLabel="Places"
                  onBack={() => selectBuilding(null)}
                  onWalk={() => selectSource(detailLocation)}
                  onSources={() => setSourcesOpen((v) => !v)}
                  onOpenEvent={(id) => {
                    setOpenEventId(id);
                    selectView('events');
                  }}
                />
                {sourcesOpen && sourceData && baseDayRef.current && (
                  <SourceDataPanel data={sourceData} locations={baseDayRef.current.locations} selectedBuilding={selected}
                    campus={campus} weekday={weekday} time={hud.time} onSelect={selectSource} />
                )}
              </>
            )}

            {tab === 'data' && analyticsSub === 'places' && !detailLocation && sourceData && baseDayRef.current && (
              <SourceDataPanel data={sourceData} locations={baseDayRef.current.locations} selectedBuilding={selected}
                campus={campus} weekday={weekday} time={hud.time} onSelect={selectSource} />
            )}

            {analyticsSub === 'places' && !detailLocation && (
              <PlacesPanel
                entries={searchedPlaces}
                query={search.trim()}
                category={category}
                onCategory={setCategory}
                sort={sort}
                onSort={setSort}
                expanded={listExpanded}
                onExpand={setListExpanded}
                selected={selected}
                onSelect={select}
                pulse={{ walking: hud.walking, stops: hud.waiting, bikes: ridingHere }}
                clock={formatClock(hud.time)}
              />
            )}

            {analyticsSub === 'transit' && (
              <>
                <TransitPanel stops={stopRows} shuttles={shuttleRows} note={live ? (feedError ?? 'live') : 'playback timetable'} />
                {/*
                  Pedestrian and street counts. They had a tab of their own, and
                  the handoff's Analytics has only three subjects; they belong
                  with Transit, because trains, shuttles and counted streets are
                  all the same question about how people move.
                */}
                {!showCounts && hiddenNote('Count sites are', toggleCounts)}
                <MobilityPanel data={mobilityData} view={mobilityView} mode={mobilityMode} weekday={weekday}
                  selected={selectedMobility} onMode={changeMobilityMode} onSelect={selectMobility} error={mobilityError} />
              </>
            )}

            {analyticsSub === 'bikes' && (bikes
              ? <BikesPanel docks={dockRows} total={bikes.data.stations.length} rate={ridingHere} peak={null} />
              : <p className="pn-empty">Bluebikes data could not be loaded.</p>)}

            {/* Last, not first: picking a scenario sets up a reading rather than
                being one, so it should not be what the panel opens on. */}
            {sourceData && <ConditionsPanel scenarios={scenarioFile?.scenarios ?? []} scenario={scenario} live={live} status={engineStatus} error={engineError}
              info={dayInfo} outdoors={hud.outdoors ?? null} comparison={comparison} onScenario={chooseScenario} onCompare={compareWithBaseline} />}
          </section>
        )}
        {/* Always there (hidden unless chosen): WeatherControls draws into it. */}
        <section id="panel-weather" role="tabpanel" aria-labelledby="tab-weather" ref={setWeatherPanel} hidden={!hud || tab !== 'weather'} />
      </Sheet>

      {hud && (
        <div className="toolbar" ref={setToolbarEl} role="group" aria-label="Time and map controls">
          <div className="toolbar-time">
            <button className="tool tool-icon" onClick={togglePlaying} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'}>
              <PlayIcon playing={playing} />
            </button>
            <output className="clock" aria-live="off">
              {formatClock(hud.time)}
              {live && <span className="badge live-badge">CLOCK</span>}
            </output>
            <input
              type="range"
              className="scrubber"
              min={range[0]}
              max={range[1]}
              step={60}
              value={hud.time}
              onInput={(e) => scrub(Number(e.currentTarget.value))}
              aria-label="Time of day"
              aria-valuetext={formatClock(hud.time)}
            />
          </div>
          <div className="toolbar-map">
            <select
              className="tool speed"
              value={live ? 'live' : String(speed)}
              onChange={(e) => (e.target.value === 'live' ? goLive() : changeSpeed(Number(e.target.value)))}
              aria-label="Playback speed"
              title="Clock follows Boston time and live transit; the others play the day back"
            >
              <option value="live">Clock</option>
              {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
              {!SPEEDS.includes(speed) && <option value={speed}>{speed}×</option>}
            </select>
            {mapKind && <MemoCameraControls basemap={basemapRef.current} locations={tourLocations} intro={introPhase !== 'done'} />}
            <Popover title="Layers" hint="Map layers and lighting" className="layers" label={<><LayersIcon /> <span className="tool-word">Layers</span></>}>
              <ul className="layer-list">
                <LayerSwitch label="MBTA" detail="Trains, buses and BU shuttles" on={showTransit} onToggle={toggleTransit} />
                {mapKind === 'mapbox' && <LayerSwitch label="Traffic" detail="Live road congestion" on={showTraffic} onToggle={() => setShowTraffic((v) => !v)} />}
                <LayerSwitch label="Parking" detail="Estimated, BU and event-area lots" on={showParking} onToggle={toggleParking} />
                {bikes && <LayerSwitch label="Bluebikes" detail="Riders and docks" on={showBikes} onToggle={toggleBikes} />}
                <LayerSwitch label="Traffic counts" detail="Vehicles, bikes and people per hour" on={showCounts} onToggle={toggleCounts} />
                {sourceData && <LayerSwitch label="Campus events" detail="Their crowds, on the shown day" on={eventsOn} onToggle={() => toggleEvents(!eventsOn)} />}
              </ul>
              {mapKind === 'mapbox' && (
                <div className="lighting">
                  <label>
                    Lighting
                    <select value={light} onChange={(e) => setLight(e.target.value as LightPreset | 'auto')}>
                      <option value="auto">Auto</option>
                      <option value="dawn">Dawn</option>
                      <option value="day">Day</option>
                      <option value="dusk">Dusk</option>
                      <option value="night">Night</option>
                    </select>
                  </label>
                  {light === 'auto' && (
                    <span className="light-status" title={live ? 'Following Boston time' : 'Following the shown time'}>
                      Auto · {daylightLabel(hud.time)}
                    </span>
                  )}
                </div>
              )}
            </Popover>
          </div>
        </div>
      )}
    </div>
  );
}

/** An on/off row in the Layers popover. */
function LayerSwitch({ label, detail, on, onToggle }: { label: string; detail: string; on: boolean; onToggle: () => void }) {
  return (
    <li>
      <button className="layer-switch" role="switch" aria-checked={on} onClick={onToggle}>
        <span className="layer-text">
          <span className="layer-name">{label}</span>
          <span className="layer-detail">{detail}</span>
        </span>
        <span className="switch" aria-hidden="true" />
      </button>
    </li>
  );
}

const icon = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <svg {...icon}>
      {playing ? <path d="M8 5v14M16 5v14" strokeWidth={3} /> : <path d="M7 4.5v15l12-7.5z" fill="currentColor" />}
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg {...icon}>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </svg>
  );
}

/** The day parking is estimated for: today in Clock mode, else the chosen day of the simulated week. */
function parkingDay(data: CampusData, live: boolean, weekday: number) {
  const date = live ? wallClockDate() : dateForWeekday(data, weekday);
  return { date, weekday, kind: parkingDayKind(date, weekday, data.academicCalendar?.terms) };
}

/** Soonest bus (or BU shuttle) per route and direction at any of a campus's stops. */
function nextBuses(data: TransitData, feed: TransitSource, area: string, kind: 'bus' | 'shuttle' = 'bus') {
  const routes = new Map(data.routes.map((r) => [r.id, r]));
  const stops = new Map(data.stops.map((s) => [s.id, s]));
  const now = Date.now();
  const best = new Map<string, { route: string; direction: 0 | 1; time: number; stop: string }>();
  for (const a of feed.state.arrivals) {
    if (routes.get(a.route)?.kind !== kind || stops.get(a.stop)?.area !== area || a.time < now - 30_000) continue;
    const key = `${a.route}:${a.direction}`;
    if (!best.has(key) || a.time < best.get(key)!.time) best.set(key, { ...a, stop: stops.get(a.stop)?.short ?? a.stop });
  }
  return [...best.values()]
    .sort((a, b) => a.route.localeCompare(b.route, undefined, { numeric: true }) || a.direction - b.direction)
    .map((a) => {
      const route = routes.get(a.route)!;
      return {
        ...a,
        name: route.name,
        longName: route.longName,
        color: route.color,
        textColor: route.textColor,
        directionName: route.directions[a.direction],
      };
    });
}

/** Green Line branch letters serving these stations: "B", "C"... */
function greenBranches({ data }: Transit, stations: { routes: string[] }[]) {
  const ids = new Set(stations.flatMap((s) => s.routes));
  return data.routes.filter((r) => r.kind === 'subway' && ids.has(r.id)).map((r) => r.name);
}

/** Black or white text, whichever reads better on a hex background (BU's lime Comm Ave line needs black). */
function readableOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.18 ? '#111' : '#fff';
}

/** Students aboard a published vehicle (`published:<weekday>:<offset>:<trip>:<run>`); null for live or overnight runs. */
function aboardPublished(vehicleId: string, t: number, playback: Playback): number | null {
  const match = /^published:\d+:0:(.+):\d+$/.exec(vehicleId);
  return match ? playback.studentsAboard(match[1], t) : null;
}

function waitingByStop(waiting: { stop: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rider of waiting) counts.set(rider.stop, (counts.get(rider.stop) ?? 0) + 1);
  return counts;
}

/** People standing about plus people sitting by the river (unpickable), for the shared idle layers. */
function withSitters(standing: WalkingAgent[], sitters: Character[]): Character[] {
  return sitters.length ? [...standing, ...sitters] : standing;
}

/** Students drawn plus event visitors drawn (the same character layers; visitors are never counted as students). */
function withVisitors(students: WalkingAgent[], visitors: WalkingAgent[]): WalkingAgent[] {
  return visitors.length ? students.concat(visitors) : students;
}

const VENUE_TAG_ROOF_M = 24;
/**
 * Building tags with each venue event's crowd: on the venue's own tag when it's a simulated place
 * (Agganis Arena), else a tag of its own (Fenway Park). Student figures on the tag are untouched.
 */
function withVenueEvents(buildings: BuildingOccupancy[], day: EventDay, t: number, locations: CampusLocation[]): BuildingOccupancy[] {
  if (!day.events.length) return buildings;
  let out = buildings;
  for (const venueId of new Set(day.events.map((e) => e.venue.id))) {
    const event = eventLoadLabel(eventLoadAt(day, venueId, t));
    if (!event) continue;
    const venue = day.events.find((e) => e.venue.id === venueId)!.venue;
    const building = venue.locationId ? locations.find((l) => l.id === venue.locationId)?.building : undefined;
    const index = building ? out.findIndex((b) => b.id === building) : -1;
    if (out === buildings) out = buildings.slice();
    if (index >= 0) out[index] = { ...out[index], event };
    else out.push({ id: `venue:${venueId}`, name: venue.name, short: venue.name, position: venue.position, count: 0, capacity: 0, share: 0, roof: VENUE_TAG_ROOF_M, eventOnly: true, event });
  }
  return out;
}

/** Walkers within `radius` metres of the view centre (all of them when radius is null). */
function nearView(walkers: WalkingAgent[], center: [number, number], radius: number | null): WalkingAgent[] {
  if (radius === null) return walkers;
  const kx = 111_320 * Math.cos((center[1] * Math.PI) / 180);
  const r2 = radius * radius;
  return walkers.filter((w) => {
    const dx = (w.position[0] - center[0]) * kx;
    const dy = (w.position[1] - center[1]) * 110_540;
    return dx * dx + dy * dy <= r2;
  });
}

/** Bounds grown by `share` of their size on every side. */
function expandBounds([w, s, e, n]: [number, number, number, number], share: number): [number, number, number, number] {
  const dx = (e - w) * share;
  const dy = (n - s) * share;
  return [w - dx, s - dy, e + dx, n + dy];
}
/** A deferred campus loads once the camera centre is this close to its buildings. */
const DEFERRED_LOAD_METRES = 1500;
function metresToBox([lng, lat]: [number, number], [w, s, e, n]: [number, number, number, number]): number {
  const dx = (lng < w ? w - lng : lng > e ? lng - e : 0) * 111_320 * Math.cos((lat * Math.PI) / 180);
  const dy = (lat < s ? s - lat : lat > n ? lat - n : 0) * 110_540;
  return Math.hypot(dx, dy);
}
/** Walkers inside these bounds (people off screen, e.g. on the Medical Campus, aren't drawn). */
function inView(walkers: WalkingAgent[], [w, s, e, n]: [number, number, number, number]): WalkingAgent[] {
  return walkers.filter(({ position: [x, y] }) => x >= w && x <= e && y >= s && y <= n);
}

// Level of detail for walkers: from far out the figures are drawn several times life size, so the
// whole crowd reads as clutter and costs GPU skinning for people a few pixels apart. A stable share
// of students (the same ones every frame, picked by id) is drawn when zoomed out, and everyone from
// street level in. Only the drawing thins; every count in the panels stays the full simulation.
const DRAW_ALL_FROM_ZOOM = 16.5;
const FARTHEST_ZOOM = 14;
const FARTHEST_SHARE = 0.35;
const walkerShare = new Map<string, number>();
function shareOf(id: string): number {
  let v = walkerShare.get(id);
  if (v === undefined) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    walkerShare.set(id, (v = (h >>> 0) / 4294967296));
  }
  return v;
}
/**
 * Public walkers join the students' walker layers (same characters, no new layers), capped so the
 * extra skinned instances stay a small share of the frame: at most PUBLIC_DRAW_SHARE of the drawn
 * students (and PUBLIC_DRAW_MIN..PUBLIC_DRAW_MAX). The same people stay drawn frame to frame (by id).
 */
const PUBLIC_DRAW_SHARE = 0.3;
const PUBLIC_DRAW_MIN = 150;
const PUBLIC_DRAW_MAX = 500;
function withPublic(students: WalkingAgent[], publicWalkers: WalkingAgent[]): WalkingAgent[] {
  if (!publicWalkers.length) return students;
  const cap = Math.min(PUBLIC_DRAW_MAX, Math.max(PUBLIC_DRAW_MIN, Math.round(students.length * PUBLIC_DRAW_SHARE)));
  const keep = publicWalkers.length <= cap ? publicWalkers : publicWalkers.filter((w) => shareOf(w.id) < cap / publicWalkers.length);
  return students.concat(keep);
}
function thinForZoom(walkers: WalkingAgent[], zoom: number): WalkingAgent[] {
  if (zoom >= DRAW_ALL_FROM_ZOOM) return walkers;
  const f = Math.min(1, Math.max(0, (zoom - FARTHEST_ZOOM) / (DRAW_ALL_FROM_ZOOM - FARTHEST_ZOOM)));
  const keep = FARTHEST_SHARE + (1 - FARTHEST_SHARE) * f;
  return walkers.filter((w) => shareOf(w.id) < keep);
}

/**
 * Live mode draws the real MBTA and BU feeds. When the day is played back or fast-forwarded,
 * live vehicles can't keep up, so scheduled service on the simulation clock takes over.
 */
function transitSourceAt(transit: Transit, t: number, live: boolean, weekday: number, date: string): TransitSource | null {
  if (live) return transit.feed;
  transit.schedule?.setTime(t, weekday, date);
  return transit.schedule;
}

/** Bikes and empty docks at every BU dock at `target` (sim seconds): live if that's now, else estimated. */
function dockStatusAt({ data, feed }: Bikes, target: number, scenario = false): Map<string, DockEstimate> {
  const now = wallClockSeconds();
  return new Map(data.stations.flatMap((s) => {
    const estimate = estimateDock(s, feed.status(s), data.binSeconds, now, target);
    return estimate ? [[s.id, scenario ? { ...estimate, estimated: true } : estimate] as const] : [];
  }));
}

// Sailboats tack against the shown weather's wind, rounded to 15° so a slowly veering wind doesn't
// re-plan every boat's course on every reading. Westerly until the first weather arrives.
function boatWind(): number | undefined {
  const from = activeWindFromDegrees();
  return from === null ? undefined : Math.round(from / 15) * 15;
}

// Nobody's out sailing in the rain, snow, fog or a storm, or after dark (the Night lighting preset).
// Sailing hours (9:00-19:30) are handled by the boat sim itself.
const NO_SAILING = new Set(['drizzle', 'rain', 'heavy-rain', 'snow', 'fog', 'thunderstorm']);
function sailingWeather(weather: ActiveWeather | null, light: LightPreset): boolean {
  if (light === 'night') return false;
  return !weather || !NO_SAILING.has(weather.condition);
}

const PODIUM_ROOF_M = 16;
const AMENITY_SPREAD_M = 14;

/**
 * Building tags: one per building, named for the building (sim/../tags/names.ts), plus a dot of
 * its own for every dining hall, library or gym that shares a building with something else
 * (Warren Towers and Warren Dining; Questrom and Pardee Library; Fenway Center, Fenway Dining and
 * FitRec at Fenway; Mugar and the Music and African Studies libraries inside it). The building's tag
 * carries its main space's load (sharedTagParts); the glow still uses the
 * busiest space.
 */
function splitSharedTags(
  buildings: BuildingOccupancy[],
  occupancy: Occupancy[],
  footprints: BuildingFootprint[],
  roofHeights: RoofHeights | undefined,
): BuildingOccupancy[] {
  const byBuilding = new Map<string, Occupancy[]>();
  for (const o of occupancy) {
    if (o.location.kind === 'off-campus' || o.location.kind === 'outdoor') continue;
    byBuilding.set(o.location.building, [...(byBuilding.get(o.location.building) ?? []), { ...o, share: occupancyShare(o.count, o.location.capacity) }]);
  }
  const out: BuildingOccupancy[] = [];
  for (const b of buildings) {
    const places = byBuilding.get(b.id) ?? [];
    const { rest, amenities } = sharedTagParts(places);
    // A building with one kind of place (or only amenities): its single tag, cleanly named.
    if (!amenities.length || !rest.length) {
      out.push({ ...b, name: displayName(b.name), short: displayShort(b.short, b.name) });
      continue;
    }
    // The whole building's tag: its centre (over all its parts), named for the building.
    const rings = footprints.filter((f) => f.id === b.id);
    const pts = rings.flatMap((f) => f.polygon);
    const centre: [number, number] = pts.length
      ? [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]
      : b.position;
    const main = rest.reduce((a, o) => (o.share > a.share ? o : a));
    out.push({ ...b, position: centre, name: displayName(main.location.name), short: displayShort(main.location.short, main.location.name),
      count: main.count, capacity: main.location.capacity, share: main.share, modeled: main.modeled, capacityBasis: main.location.capacityBasis });
    // Amenities recorded at (nearly) the same point would stack and the label placer would hide all
    // but one: those are fanned out around their shared point, AMENITY_SPREAD_M apart.
    const kx = 111_320 * Math.cos((centre[1] * Math.PI) / 180);
    const spot = (d: Occupancy): [number, number] => {
      const stacked = amenities.filter((o) => Math.hypot((o.location.position[0] - d.location.position[0]) * kx, (o.location.position[1] - d.location.position[1]) * 110_540) < AMENITY_SPREAD_M);
      if (stacked.length < 2) return d.location.position;
      const k = stacked.indexOf(d);
      const angle = (2 * Math.PI * k) / stacked.length; // an even fan, in a stable order
      return [d.location.position[0] + (Math.cos(angle) * AMENITY_SPREAD_M) / kx, d.location.position[1] + (Math.sin(angle) * AMENITY_SPREAD_M) / 110_540];
    };
    for (const d of amenities) {
      out.push({
        id: `${b.id}#${d.location.id}`,
        name: displayName(d.location.name),
        short: displayShort(d.location.short, d.location.name),
        position: spot(d),
        modeled: d.modeled,
        capacityBasis: d.location.capacityBasis,
        count: d.count,
        capacity: d.location.capacity,
        share: d.share,
        roof: Math.min(PODIUM_ROOF_M, roofHeights?.get(b.id) ?? PODIUM_ROOF_M),
      });
    }
  }
  return out;
}
