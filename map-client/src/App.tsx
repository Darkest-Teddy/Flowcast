import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { PickingInfo } from '@deck.gl/core';
import { createBasemap, INITIAL_VIEW, TRAFFIC_LEVELS, type Basemap, type LightPreset } from './map/basemap';
import { agentLayers, loadCharacterModels, type LoadedModels } from './layers/agents';
import { crowdLayers, modelRoofHeights, modelVolumes, type RoofHeights } from './layers/crowd';
import { activityDisplay, BuildingTags, type BuildingTagsHandle } from './BuildingTags';
import { TransitTags, type TagMarker, type TransitTagsHandle } from './TransitTags';
import { PlaceTags, placeHitLayers, placeUnder, type PlaceTagsHandle } from './PlaceTags';
import { createPlacer } from './layers/placement';
import { cullLayers } from './layers/culling';
import { buildingModelLayers, campusBounds, DEFERRED_CAMPUSES, landmarkClips, loadBuildings, loadCampusModels } from './layers/buildings';
import { daylightAt, daylightLabel } from './map/daylight';
import { loadMonuments, monumentLayers } from './layers/monuments';
import { fieldBuildingIds, fieldLayers, loadFields } from './layers/fields';
import { loadVehicleModels, transitLayers, transitTooltip, type VehicleModels } from './layers/transit';
import { loadStreet, streetLayers, streetTooltip } from './layers/street';
import { boatLayers, boatTooltip, loadBoats } from './layers/boats';
import { Playback, formatClock, loadDay, occupancyShare, type BuildingFootprint, type BuildingOccupancy, type Campus, type Occupancy, type WalkingAgent } from './sim/playback';
import { MbtaFeed, loadTransit, minutesUntil, type TransitData, type TransitSource } from './transit/mbta';
import { loadShuttles } from './transit/buShuttle';
import { trackCorridors } from './transit/tracks';
import { PublishedTransit, loadPublishedSchedule } from './transit/publishedSchedule';
import { buildPopulation, loadPopulation, type PopulationBase } from './sim/population';
import { advanceTime } from './sim/clock';
import { dateForWeekday, loadCampusData, WEEKDAYS, type CampusData } from './data/campusData';
import { buildSourceDay, type SourceDay } from './sim/sourceDay';
import { weekdayOf } from './sim/gatherings';
import { EventsPanel } from './EventsPanel';
import { createTransitService, mergeSchedules, type TransitService } from './sim/transitService';
import { waitingCharacters, waitingRiderLayers } from './layers/waitingRiders';
import { SourceDataPanel } from './SourceDataPanel';
import { AMENITY_KINDS, displayName, displayShort } from './tags/names';
import type { CampusLocation } from './sim/playback';
import { CameraControls } from './CameraControls';
import { PerfMonitor, type PerfCounts } from './PerfMonitor';
import { WeatherControls } from './WeatherControls';
import { activeWindFromDegrees } from './weather/weather';
import { type ActiveWeather } from './weather/weather';
import { precipitationLayers, setParticleScale } from './weather/precipitation';
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
import { LoadingScreen, createLoadProgress } from './LoadingScreen';
import { loadMobility, mobilityAt, type MobilityData, type MobilityMode, type MobilityView, type MobilityPoint, type MobilityArc } from './data/mobility';
import { mobilityLayers, mobilityTooltip } from './layers/mobility';
import { MobilityPanel } from './MobilityPanel';
import { IncidentPanel, type IncidentRun } from './IncidentPanel';
import { applyIncident, type IncidentKind } from './sim/incidents';
import { damageAt } from './sim/disasterDamage';
import { damageExclusionAreas, fallbackDamageLayers } from './layers/damageFallback';
import { incidentLayers } from './layers/incidents';
import { planFireResponse as planDisasterFireResponse, fireResponseAt } from './sim/disasterFireResponse';
import { fireResponseLayers } from './layers/fireResponse';
import { AskPanel, type AskShow } from './AskPanel';
import { askRouteLayers, type AskRoute } from './layers/askRoute';
import { askMeetings, type AskContext } from './insights';
import type { WalkRoute } from './sim/playback';
import { fireLayers, fireTooltip, loadFireModels, nearestResponding, type FireModels } from './layers/fireTrucks';
import { loadFireNetwork, planFireResponse, signalOracle, type FireNetwork } from './sim/fireResponse';
import { registeredSignals } from './sim/signals';
import { FireSiren } from './fireSiren';
import { ParkingTags, type ParkingTagsHandle } from './ParkingTags';
import { ParkingPanel } from './ParkingPanel';
import { parkingLayers, parkingUnder } from './layers/parking';
import { campusParkingEvents, createParkingModel, loadParking, parkingAt, parkingDayKind, type LotState, type ParkingData, type ParkingEvent, type ParkingModel, type ParkingState } from './sim/parking';

// The HUD re-renders the app twice a second; these only need to when their own props change.
const MemoPerfMonitor = memo(PerfMonitor);
const MemoCameraControls = memo(CameraControls);
const MemoWeatherControls = memo(WeatherControls);

const SPEEDS = [1, 30, 120, 600];
const COUNTS_KEY = 'flowcast.trafficCounts';
const params = new URLSearchParams(window.location.search);
/** ?date=2026-11-18 plays that date's campus events on its weekday (projected onto the representative week). */
const URL_DATE = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date')! : null;
/** ?events=0 starts with campus events off, showing the no-event baseline. */
const START_EVENTS = params.get('events') !== '0';
// Live by default: the simulated day follows the real clock at 1x, so walkers, trains and buses
// all move at their true relative speeds. ?at=, ?speed= or ?date= start in playback mode instead.
const START_LIVE = !params.has('at') && !params.has('speed') && !URL_DATE;

const BOSTON_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** Seconds since midnight in Boston. */
function wallClockSeconds(): number {
  const now = new Date();
  const parts = BOSTON_CLOCK.format(now).split(':').map(Number);
  return parts[0] * 3600 + parts[1] * 60 + parts[2] + now.getMilliseconds() / 1000;
}

/** ?at=9:00 (24h clock) starts playback there; default is the run-up to the 9:05 class change. */
function startTimeFromUrl(): number {
  const at = params.get('at');
  const match = at?.match(/^(\d{1,2}):(\d{2})$/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 : 8 * 3600 + 50 * 60;
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
const START_AT = START_LIVE ? wallClockSeconds() : startTimeFromUrl();
const START_SPEED = START_LIVE ? 1 : Number(params.get('speed')) || SPEEDS[1];
const OCCUPANCY_REFRESH_MS = 500;
/** ?ask=least+crowded+library opens the Ask tab with that question answered. */
const START_QUESTION = params.get('ask');

interface Hud {
  time: number;
  walking: number;
  occupancy: Occupancy[];
  /** Bluebikes riders on the map, by the campus of the BU dock they left or are heading to. */
  riding: Map<string, number>;
  /** Students standing at stops for a published departure. */
  waiting: number;
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

  const [loadProgress] = useState(createLoadProgress);
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
  const [tab, setTab] = useState<'ask' | 'crowds' | 'data' | 'transit' | 'bikes' | 'traffic' | 'incidents'>(START_QUESTION ? 'ask' : 'crowds');
  const [incidentRun, setIncidentRun] = useState<IncidentRun | null>(null);
  const incidentRunRef = useRef<IncidentRun | null>(null);
  const baselinePlaybackRef = useRef<Playback | null>(null);
  const askRouteRef = useRef<AskRoute | null>(null); // the walk an Ask answer draws, read by the frame loop
  const walkRoutesRef = useRef<Record<string, WalkRoute>>({});
  // Boston Fire apparatus for fire alarms: street graph and models, loaded after the map starts.
  const fireRef = useRef<Promise<{ network: FireNetwork; models: FireModels } | null> | null>(null);
  const fireModelsRef = useRef<FireModels>({});
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
  const playbackRef = useRef<Playback | null>(null);
  // Campus events: on by default. Which date's events play is decided by eventDateFor().
  const [eventsOn, setEventsOn] = useState(START_EVENTS);
  const eventsOnRef = useRef(START_EVENTS);
  const pinnedDateRef = useRef<string | null>(URL_DATE);
  const [simDay, setSimDay] = useState<SourceDay | null>(null);
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
    const built = buildSourceDay(base, data, day, transitServiceRef.current, { eventDate: eventDateFor(data, day) });
    setSimDay(built);
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

    (async () => {
      loadProgress.reset();
      const track = loadProgress.track;
      // BU Shuttle timetable (recorded TransLoc schedules + BU's GTFS baseline); MBTA-only without it.
      const shuttleTimetable = loadPublishedSchedule('/data/shuttle-schedule.json').catch(() => null);
      const [basemap, day, models, transitData, vehicleModels, detailedBuildings, street, snapshot, monuments, bikeData, boats, population, mbtaTimetable, mobilitySnapshot, fields] = await Promise.all([
        track('Drawing the map', createBasemap(mapElement, shownLight)),
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
      ]);
      if (cancelled) return basemap.remove();
      const shuttleSchedule = await shuttleTimetable;
      const timetable = mbtaTimetable ? mergeSchedules(mbtaTimetable, shuttleSchedule) : shuttleSchedule;
      basemapRef.current = basemap;
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
      baseDayRef.current = populationBase;
      setSourceData(snapshot);
      setMobilityData(mobilitySnapshot);
      transitServiceRef.current = timetable ? createTransitService(timetable) : undefined;
      const playback = playDay(populationBase, snapshot, weekdayRef.current);
      playbackRef.current = playback;
      setRange([0, 86400]);
      setCampuses(day.campuses ?? []);

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
        onClick: ({ object }: PickingInfo) => {
          if (object && 'mobilityKind' in object) {
            selectedMobilityRef.current = object.id;
            setSelectedMobility(object.id);
            setTab('traffic');
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
          if (id) setTab("data");
        },
        getTooltip: ({ object }: PickingInfo) => {
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
          const source = transit && (liveRef.current ? transit.feed : transit.schedule);
          const text = transit && source ? transitTooltip(object, transit.data, source) : null;
          if (text) return text;
          if (!object || !('bearing' in object) || 'receivedAt' in object) return null;
          const agent = object as WalkingAgent;
          // Riders walking to a stop are headed for a transit stop, not a building.
          return `Student ${agent.id} → ${playbackRef.current?.locations.find((l) => l.id === agent.to)?.name ?? transit?.data.stops.find((s) => s.id === agent.to)?.short}`;
        },
      });
      basemap.addControl(overlay);
      // Fire response data is only needed once someone sounds a fire alarm: fetch it in the background.
      fireRef.current = Promise.all([loadFireNetwork(), loadFireModels()])
        .then(([network, models]) => { fireModelsRef.current = models; return { network, models }; })
        .catch(() => null);
      // Dev-only handle for poking at layers from the browser console.
      if (import.meta.env.DEV || params.has('debug')) Object.assign(window, { __flowcast: { overlay, basemap, get playback() { return playbackRef.current; }, get time() { return timeRef.current; }, get incident() { return incidentRunRef.current; }, transitRef, bikesRef, populationBase, quality } });
      // Lift the loading screen once the first frames are drawn and the view's tiles are in (or
      // after 4 s regardless), sweeping the camera in from a wider, turned view as it fades.
      const revealFrom = performance.now();
      const reveal = () => {
        if (cancelled) return;
        if (!basemap.tilesLoaded() && performance.now() - revealFrom < 4000) return void requestAnimationFrame(reveal);
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
        const waitingRiders = playback.waitingAt(t);
        const bikes = bikesRef.current;
        const riding = bikes ? bikes.replay.ridingAt(t) : [];
        if (now - lastOccupancy > OCCUPANCY_REFRESH_MS) {
          occupancy = playback.occupancyAt(t);
          lastOccupancy = now;
          if (bikesRef.current) dockStatus = dockStatusAt(bikesRef.current, liveRef.current ? wallClockSeconds() : t);
          const ridingByCampus = new Map<string, number>();
          for (const r of riding) ridingByCampus.set(bikes!.campusOf(r.trip), (ridingByCampus.get(bikes!.campusOf(r.trip)) ?? 0) + 1);
          setHud({ time: t, walking: walking.length, occupancy, riding: ridingByCampus, waiting: waitingRiders.length });
        }
        // Reserve the active assembly label before placing building and transit tags.
        const placer = createPlacer(basemap.project);
        const damage = damageAt(incidentRunRef.current, t, damageFootprints);
        const damagedIds = new Set(damage.map(building => building.id));
        const damageKey = damage.map(building => building.id).join(',');
        if (damageKey !== damageExclusionKey) {
          basemap.excludeBuildings([...baselineExcludedBuildings, ...damage.map(building => Number(building.id.split('/')[1])).filter(Number.isFinite)], damageExclusionAreas(damage, detailedBuildings?.manifest));
          damageExclusionKey = damageKey;
        }
        const response = incidentRunRef.current?.fireResponse;
        const fireTrucks = response ? fireResponseAt(response, t) : [];
        const incidentFrameLayers = incidentLayers(incidentRunRef.current, t, occupancy, day.buildings, placer, damage);
        // Rolled up per building only when occupancy is refreshed (or the day changes), not every frame.
        if (occupancy !== buildingsFrom || playback !== buildingsPlayback) {
          buildingOccupancy = playback.byBuilding(occupancy);
          buildings = splitSharedTags(buildingOccupancy, occupancy, day.buildings, roofHeights);
          buildingsFrom = occupancy;
          buildingsPlayback = playback;
        }
        tagsRef.current?.update({
          buildings: buildings.filter(building => !damagedIds.has(building.id.split('#')[0])),
          footprints: day.buildings,
          locations: populationBase.locations,
          selectedId: selectedRef.current,
          placer,
          project: basemap.project,
          camera: basemap.getCamera(),
          roofHeights,
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
          parkingTagsRef.current?.update({ placer, project: basemap.project, camera: basemap.getCamera(), state: parkingState });
        } else parkingState = null;
        const transit = transitRef.current;
        // Live feeds and published playback share the rendering interface.
        const source = transit ? transitSourceAt(transit, t, liveRef.current, weekdayRef.current) : null;
        const showBikesNow = bikes && showBikesRef.current;
        // Shown time and day (0 = Sunday), for BU shuttle service hours.
        const serviceTime = liveRef.current ? wallClockSeconds() : t;
        const serviceDay = liveRef.current ? new Date().getDay() : (weekdayRef.current + 1) % 7;
        // Then station, stop and dock tags, through the same placer.
        transitTagsRef.current?.update({
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
        placeTagsRef.current?.update({
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
        const frameLayers = [
          ...fallbackDamageLayers(damage, new Set(detailedBuildings?.manifest.campuses
            .filter(campus => detailedBuildings.models[campus.id])
            .flatMap(campus => campus.buildings.map(building => building.osm)) ?? [])),
          ...fireResponseLayers(fireTrucks, t, basemap.getZoom()),
          ...(detailedBuildings
            ? buildingModelLayers(detailedBuildings.manifest, detailedBuildings.models, { lightPreset: lightRef.current, clock: t, auto: lightModeRef.current === 'auto', litWindows: q.litWindows, damage, footprints: damageFootprints })
            : []),
          ...crowdLayers({
            footprints: day.buildings,
            buildings: buildingOccupancy.filter((building) => building.modeled !== false && !damagedIds.has(building.id)),
            trips: playback.trailsAt(t, Math.min(600, Math.max(20, speedRef.current * 3))),
            time: t,
            speed: speedRef.current,
            selectedId: selectedRef.current,
            zoom: basemap.getZoom(),
            roofHeights,
            volumes,
          }),
          ...(street ? streetLayers({ street, transit, time: t, zoom: basemap.getZoom() }) : []),
          ...(transit && source && showTransitRef.current ? transitLayers({ data: transit.data, feed: source, now, zoom: basemap.getZoom(), models: transit.models, time: serviceTime, weekday: serviceDay }) : []),
          ...(monuments ? monumentLayers(monuments, { zoom: basemap.getZoom(), lightPreset: lightRef.current, time: serviceTime }) : []),
          ...(fields ? fieldLayers(fields, { zoom: basemap.getZoom(), lightPreset: lightRef.current, clock: t, auto: lightModeRef.current === 'auto' }) : []),
          ...(parking && parkingState ? parkingLayers(parking.data, parkingState) : []),
          ...placeHitLayers(monuments?.monuments ?? null, fields?.fields ?? null, basemap.getZoom()),
          ...(boats && sailingWeather(weatherRef.current, lightRef.current) ? boatLayers({ boats, time: t, zoom: basemap.getZoom(), speed: liveRef.current ? 1 : speedRef.current, lightPreset: lightRef.current, windFromDegrees: boatWind() }) : []),
          ...(showBikesNow
            ? bikeLayers({ data: bikes.data, trips: bikes.replay.trips, riding, time: t, speed: speedRef.current, zoom: basemap.getZoom(), dockStatus })
            : []),
          ...agentLayers(thinForZoom(inView(nearView(walking, basemap.getCamera().center, q.walkerRadius), view), basemap.getZoom()), models, t, { zoom: basemap.getZoom() }),
          ...incidentFrameLayers,
          // Fire apparatus: no layers unless a fire alarm's response is under way.
          ...fireLayers(incidentRunRef.current?.response ?? null, { time: t, now, zoom: basemap.getZoom(), night: lightRef.current !== 'day', models: fireModelsRef.current }),
          ...(transit ? waitingRiderLayers(nearView(waitingCharacters(waitingRiders, transit.feed.tracks), basemap.getCamera().center, q.walkerRadius), models, t, basemap.getZoom()) : []),
          ...askRouteLayers(askRouteRef.current),
          ...(currentMobility && showCountsRef.current ? mobilityLayers(currentMobility, { selectedId: selectedMobilityRef.current, placer }) : []),
          ...precipitationLayers(weatherRef.current?.effect.precipitation, basemap.getCamera(), now, lightRef.current),
        ];
        overlay!.setProps({ layers: frameLayers });
        // Siren (off unless switched on): only while apparatus run lights-and-siren and the clock runs.
        sirenRef.current?.set(playingRef.current ? FireSiren.levelAt(nearestResponding(incidentRunRef.current?.response ?? null, basemap.getCamera().center)) : 0);
        perfRef.current = {
          walkers: walking.length,
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
  }, []);

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
  /** Play a specific date's events: switches to that date's weekday. */
  const pickEventDate = (date: string) => {
    pinnedDateRef.current = date;
    eventsOnRef.current = true;
    setEventsOn(true);
    changeDay(weekdayOf(date));
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
  const startIncident = (kind: IncidentKind, locationId: string, duration: number, radiusMetres?: number) => {
    const baseline = playbackRef.current;
    if (!baseline || baselinePlaybackRef.current) throw new Error('Reset the current scenario before starting another incident.');
    if (timeRef.current + duration > 86400) throw new Error('This incident would extend past midnight. Choose a shorter duration or an earlier simulation time.');
    const incident = { id: `incident-${weekdayRef.current}-${timeRef.current}`, kind, locationId, start: timeRef.current, duration, radiusMetres };
    const result = applyIncident(baseline.data, incident, sourceData ? { sourceData, weekday: weekdayRef.current } : undefined);
    const location = baseline.locations.find((entry) => entry.id === locationId)!;
    const responsePlan = kind === 'fire' ? (transitRef.current
      ? planDisasterFireResponse({ incident, location, hazard: result.hazard }, transitRef.current.data, baseline.data.buildings)
      : { plan: null, reason: 'no-road-data' as const }) : null;
    const fireResponse = responsePlan?.plan ?? null;
    const playback = new Playback(result.day);
    baselinePlaybackRef.current = baseline;
    playbackRef.current = playback;
    leaveLive();
    const run = { incident, location, fireResponse, fireResponseUnavailable: responsePlan?.reason,
      hazard: result.hazard, casualties: result.casualties, assemblyLocation: result.assemblyLocation, assemblyClearanceMetres: result.assemblyClearanceMetres ?? null, affectedAgents: result.affectedAgents, endsAt: result.endsAt, participants: result.participants };
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
  const askContext: AskContext | null = hud && playbackRef.current
    ? {
        locations: playbackRef.current.locations.filter((l) => l.kind !== 'off-campus'),
        walkRoutes: walkRoutesRef.current,
        meetings,
        occupancyAt: (t) => playbackRef.current!.occupancyAt(t),
        time: Math.floor(hud.time / 60) * 60,
        weekday,
        campus,
        data: sourceData ?? undefined,
      }
    : null;
  const showAsk = (show: AskShow | null) => {
    askRouteRef.current = show?.route ?? null;
    if (!show) return;
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

  return (
    <div className="app">
      <div ref={containerRef} />
      {light === 'auto' && hud && (
        // Auto lighting: a blue multiply veil darkens the chosen preset to the sun's brightness (set per frame).
        <div ref={veilRef} aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'rgb(18, 24, 52)',
          mixBlendMode: 'multiply', opacity: daylightAt(hud.time).veil }} />
      )}
      <BuildingTags ref={tagsRef} onSelect={selectBuilding} />
      <TransitTags ref={transitTagsRef} />
      <PlaceTags ref={placeTagsRef} />
      {showParking && <ParkingTags ref={parkingTagsRef} />}

      <header className="panel title">
        <h1>Flowcast</h1>
        <p>
          {currentCampus?.name ?? 'BU'} · {WEEKDAYS[weekday]} {hud ? `· ${hud.walking} walking` : ''}{hud?.waiting ? ` · ${hud.waiting} at stops` : ''}
          {bikes && showBikes && hud ? ` · ${ridingHere} on Bluebikes` : ''}
        </p>
        <p className="model-note">{sourceData ? 'Campus simulation · Fall 2026' : 'Campus simulation · Demo'}</p>
        {sourceData && <p className="model-note">{dateForWeekday(sourceData, weekday)} · Boston time</p>}
        {!live && scheduleError && <p role="alert">Transit playback unavailable: {scheduleError}</p>}
        {sourceData && <label className="day-picker">Simulation day <select aria-label="Simulation day" value={weekday} onChange={(event) => changeDay(Number(event.target.value))}>{WEEKDAYS.map((name, index) => <option key={name} value={index}>{name}</option>)}</select></label>}
        {campuses.length > 1 && (
          <div className="campuses" role="group" aria-label="Campus">
            {campuses.map((c) => (
              <button key={c.id} onClick={() => goToCampus(c)} aria-pressed={c.id === campus}>
                {c.name.replace(' Campus', '')}
              </button>
            ))}
          </div>
        )}
      </header>

      <LoadingScreen progress={loadProgress} />

      <MemoPerfMonitor counts={getPerfCounts} />
      {mapKind && <MemoCameraControls basemap={basemapRef.current} locations={tourLocations} />}
      {mapKind && <MemoWeatherControls basemap={basemapRef.current} light={shownLight} simTime={hud?.time} live={live} onChange={onWeather} />}

      {hud && (
        <aside className="panel side">
          <div className="tabs mobility-tabs" role="tablist" aria-label="Side panel">
            <button role="tab" id="tab-ask" aria-selected={tab === 'ask'} aria-controls="panel-ask" onClick={() => setTab('ask')}>Ask</button>
            <button role="tab" id="tab-crowds" aria-selected={tab === 'crowds'} aria-controls="panel-crowds" onClick={() => setTab('crowds')}>
              Crowds
            </button>
            <button role="tab" id="tab-data" aria-selected={tab === 'data'} aria-controls="panel-data" onClick={() => setTab('data')}>Data</button>
            <button role="tab" id="tab-incidents" aria-selected={tab === 'incidents'} aria-controls="panel-incidents" onClick={() => setTab('incidents')}>Incidents</button>
            <button role="tab" id="tab-transit" aria-selected={tab === 'transit'} aria-controls="panel-transit" onClick={() => setTab('transit')}>
              Transit
            </button>
            <button role="tab" id="tab-traffic" aria-selected={tab === 'traffic'} aria-controls="panel-traffic" onClick={() => setTab('traffic')}>Traffic</button>
            {bikes && (
              <button role="tab" id="tab-bikes" aria-selected={tab === 'bikes'} aria-controls="panel-bikes" onClick={() => setTab('bikes')}>
                Bikes
              </button>
            )}
          </div>
          {tab === 'incidents' ? (
            <IncidentPanel locations={ranked.map((entry) => entry.location)} time={hud.time} run={incidentRun}
              onStart={startIncident} onReset={resetIncident} onLocate={selectSource}
              siren={siren} onSiren={toggleSiren} responsePending={responsePending} />
          ) : tab === 'ask' && askContext ? (
            <section id="panel-ask" role="tabpanel" aria-labelledby="tab-ask">
              <AskPanel context={askContext} initialQuestion={START_QUESTION} onShow={showAsk} onSelect={selectSource} />
            </section>
          ) : tab === 'crowds' ? (
            <section id="panel-crowds" role="tabpanel" aria-labelledby="tab-crowds">
              {sourceData && baseDayRef.current && (
                <EventsPanel day={simDay} data={sourceData} locations={baseDayRef.current.locations} eventsOn={eventsOn}
                  onToggle={toggleEvents} onPickDate={pickEventDate} onShow={selectSource} />
              )}

              <h2>Campus activity</h2>
              <ol>
                {ranked.slice(0, 8).map((o) => {
                  const display = activityDisplay({
                    count: o.count, capacity: o.location.capacity, share: o.share,
                    modeled: o.modeled ?? o.location.activityModeled,
                    capacityBasis: o.location.capacityBasis, kind: o.location.kind,
                    allowZero: o.location.estimatedProfile?.purpose === 'rowing',
                  });
                  return (
                    <li key={o.location.id}>
                      <button
                        className={o.location.building === selected ? 'row selected' : 'row'}
                        onClick={() => select(o)}
                        aria-pressed={o.location.building === selected}
                        style={display.style}
                      >
                        <span className="name">{displayName(o.location.name)}</span>
                        {display.hasPercentage && <span className="bar" aria-hidden="true">
                          <span style={{ width: `${Math.min(100, display.percent)}%` }} />
                        </span>}
                        <span className="value">
                          <b>{display.primary}</b>{display.secondary && ` · ${display.secondary}`}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : tab === 'bikes' && bikes ? (
            <section id="panel-bikes" role="tabpanel" aria-labelledby="tab-bikes">
              <div className="toggles" role="group" aria-label="Map layers">
                <button onClick={toggleBikes} aria-pressed={showBikes}>
                  Bluebikes
                </button>
              </div>
              <h2>
                Real Bluebikes rides <span className="muted">· {formatDate(bikes.data.replayDate)}</span>
              </h2>
              <p className="bike-summary">
                <strong>{ridingHere}</strong> riding to or from {currentCampus?.name.replace(' Campus', '') ?? 'BU'} docks now ·{' '}
                {bikes.replay.trips.filter((t) => bikes.campusOf(t) === campus).length.toLocaleString()} rides that day
              </p>
              {docks.length > 0 && (
                <>
                  <h3>Typical {bikes.data.weekday} at these docks</h3>
                  <ActivityChart
                    values={activityCurve(docks, bikes.data.binSeconds)}
                    binSeconds={bikes.data.binSeconds}
                    time={hud.time}
                    unit="rides/h"
                    label={`Rides docked and undocked per hour at ${currentCampus?.name ?? 'BU'} Bluebikes docks on a typical ${bikes.data.weekday}`}
                  />
                  <p className="muted">
                    Docked + undocked per hour, averaged over {bikes.data.profileDates.length} {bikes.data.weekday}s in{' '}
                    {new Date(`${bikes.data.month}-15T12:00:00`).toLocaleDateString([], { month: 'long', year: 'numeric' })}
                  </p>
                  <h3>
                    {live ? 'Live docks' : `Docks at ${hud ? formatClock(hud.time) : ''} (estimated)`}{' '}
                    <span className="muted">
                      {bikeFeedError ??
                        (bikeFeedUpdatedAt ? `· updated ${new Date(bikeFeedUpdatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '· connecting…')}
                    </span>
                  </h3>
                  <table className="arrivals">
                    <thead>
                      <tr>
                        <th scope="col">Dock</th>
                        <th scope="col">Bikes</th>
                        <th scope="col">Empty</th>
                        <th scope="col" title="Estimated bikes in 1 hour">+1 h</th>
                        <th scope="col" title="Estimated bikes in 3 hours">+3 h</th>
                      </tr>
                    </thead>
                    <tbody>
                      {docks.map((s) => {
                        // "Now" is the shown time: the live count in Live mode, else an estimate.
                        const shown = hud ? (live ? wallClockSeconds() : hud.time) : wallClockSeconds();
                        const at = (offset: number) => estimateDock(s, bikes.feed.status(s), bikes.data.binSeconds, wallClockSeconds(), shown + offset);
                        const nowEst = at(0);
                        const mark = (e: DockEstimate) => (e.estimated ? '≈' : '');
                        return (
                          <tr key={s.id}>
                            <th scope="row">{s.short}</th>
                            <td>
                              {mark(nowEst)}
                              {nowEst.bikes}
                              {nowEst.ebikes > 0 && <span className="muted"> ({nowEst.ebikes}⚡)</span>}
                            </td>
                            <td>
                              {mark(nowEst)}
                              {nowEst.docks}
                            </td>
                            <td>≈{at(3600).bikes}</td>
                            <td>≈{at(3 * 3600).bikes}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="muted source">
                    ≈ estimated: today's live count plus a typical {bikes.data.weekday}'s arrivals and departures at each dock. Bluebikes'
                    rebalancing vans aren't modelled. ⚡ = e-bikes.
                  </p>
                </>
              )}
              <p className="muted source">
                Bluebikes System Data and live feed. Docks within {bikes.data.stationRadiusMetres} m of a BU building. Ride times at BU docks are real;
                street routes are inferred.
              </p>
            </section>
          ) : tab === 'traffic' ? (
            <section id="panel-traffic" role="tabpanel" aria-labelledby="tab-traffic">
              <div className="toggles" role="group" aria-label="Map layers">
                <button onClick={toggleCounts} aria-pressed={showCounts}>
                  Counts on map
                </button>
              </div>
              <MobilityPanel data={mobilityData} view={mobilityView} mode={mobilityMode} weekday={weekday} selected={selectedMobility} onMode={changeMobilityMode} onSelect={selectMobility} error={mobilityError} />
            </section>
          ) : tab === 'data' ? (
            <section id="panel-data" role="tabpanel" aria-labelledby="tab-data">
              {baseDayRef.current && <p>{baseDayRef.current.populationSummary.total.toLocaleString()} students · {baseDayRef.current.populationSummary.reportingPeriod}. Students outside the study area remain off map.</p>}
              {sourceData && baseDayRef.current ? <SourceDataPanel data={sourceData} locations={baseDayRef.current.locations} selectedBuilding={selected} campus={campus} weekday={weekday} time={hud.time} onSelect={selectSource} /> : <p>Campus data could not be loaded.</p>}
            </section>
          ) : (
            <section id="panel-transit" role="tabpanel" aria-labelledby="tab-transit">
              <div className="toggles" role="group" aria-label="Map layers">
                <button onClick={toggleTransit} aria-pressed={showTransit}>
                  MBTA
                </button>
                {mapKind === 'mapbox' && (
                  <button onClick={() => setShowTraffic((v) => !v)} aria-pressed={showTraffic}>
                    Traffic
                  </button>
                )}
                <button onClick={toggleParking} aria-pressed={showParking} title="Estimated parking at BU and event-area lots">
                  Parking
                </button>
              </div>
              {showParking && (parkingError
                ? <p role="alert">Parking estimate unavailable: {parkingError}</p>
                : parkingRef.current && <ParkingPanel data={parkingRef.current.data} state={parkingView} onSelect={selectLot} />)}
              {transit && source && showTransit && (
                <>
                  <h2>
                    {live ? 'Live MBTA' : 'Scheduled service'}{' '}
                    <span className="muted">
                      {live
                        ? (feedError ?? (feedUpdatedAt ? `· updated ${new Date(feedUpdatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '· connecting…'))
                        : '· playback timetable'}
                    </span>
                  </h2>
                  {stations.length > 0 && (
                    <>
                      <h3>
                        {greenBranches(transit, stations).map((b) => (
                          <span key={b} className="route-badge" style={{ background: '#00843D', color: '#fff' }}>
                            {b}
                          </span>
                        ))}{' '}
                        Green Line
                      </h3>
                      <table className="arrivals">
                        <thead>
                          <tr>
                            <th scope="col">Station</th>
                            <th scope="col">Inbound</th>
                            <th scope="col">Outbound</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stations.map((s) => {
                            // Trains only: Kenmore is also a stop for the 57 and other buses.
                            const next: Partial<Record<0 | 1, { route: string; time: number }>> = {};
                            for (const a of source!.nextArrivals(s.id)) {
                              if (a.route.startsWith('Green-') && (!next[a.direction] || a.time < next[a.direction]!.time)) next[a.direction] = a;
                            }
                            // Name the branch where several stop (Kenmore: B, C, D).
                            const cell = (direction: 0 | 1) => {
                              const a = next[direction];
                              if (!a) return '—';
                              const branch = s.routes.filter((r) => r.startsWith('Green-')).length > 1 ? `${a.route.replace('Green-', '')} ` : '';
                              return `${branch}${minutesUntil(a.time)}`;
                            };
                            return (
                              <tr key={s.id}>
                                <th scope="row">{s.short}</th>
                                <td>{cell(1)}</td>
                                <td>{cell(0)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </>
                  )}
                  {busArrivals.length > 0 && (
                    <>
                      <h3>Buses</h3>
                      <ul className="buses">
                        {busArrivals.map((b) => (
                          <li key={`${b.route}-${b.direction}`}>
                            <span className="route-badge" style={{ background: b.color, color: b.textColor }}>
                              {b.name}
                            </span>
                            <span className="bus-text">
                              {b.directionName} at {b.stop}
                            </span>
                            <strong>{minutesUntil(b.time)}</strong>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {shuttleArrivals.length > 0 && (
                    <>
                      <h3>BU Shuttle</h3>
                      <ul className="buses">
                        {shuttleArrivals.map((b) => (
                          <li key={b.route}>
                            <span className="route-badge" style={{ background: b.color, color: readableOn(b.color) }} aria-hidden="true">
                              BU
                            </span>
                            <span className="bus-text">
                              {b.longName} at {b.stop}
                            </span>
                            <strong>{minutesUntil(b.time)}</strong>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
              {mapKind === 'mapbox' && showTraffic && (
                <>
                  <h3>Traffic</h3>
                  <ul className="legend" aria-label="Traffic legend">
                    {TRAFFIC_LEVELS.map((l) => (
                      <li key={l.key}>
                        <span className="swatch" style={{ background: l.color, height: Math.round(3 * l.boost) }} aria-hidden="true" />
                        {l.label}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
        </aside>
      )}

      {hud && (
        <footer className="panel timeline">
          <button className="play" onClick={togglePlaying} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? '❚❚' : '▶'}
          </button>
          <output className="clock" aria-live="off">
            {formatClock(hud.time)}
            {live && <span className="live-badge">CLOCK</span>}
          </output>
          <input
            type="range"
            min={range[0]}
            max={range[1]}
            step={60}
            value={hud.time}
            onInput={(e) => scrub(Number(e.currentTarget.value))}
            aria-label="Time of day"
            aria-valuetext={formatClock(hud.time)}
          />
          <div className="speeds" role="group" aria-label="Playback speed">
            <button onClick={goLive} aria-pressed={live} title="Follow Boston time and live transit">
              Clock
            </button>
            {SPEEDS.map((s) => (
              <button key={s} onClick={() => changeSpeed(s)} aria-pressed={!live && speed === s}>
                {s}×
              </button>
            ))}
          </div>
          {mapKind === 'mapbox' && (
            <select value={light} onChange={(e) => setLight(e.target.value as LightPreset | 'auto')} aria-label="Lighting">
              <option value="auto">Auto</option>
              <option value="dawn">Dawn</option>
              <option value="day">Day</option>
              <option value="dusk">Dusk</option>
              <option value="night">Night</option>
            </select>
          )}
          {mapKind === 'mapbox' && light === 'auto' && hud && (
            <span className="light-status" style={{ fontSize: 12, opacity: 0.85, whiteSpace: 'nowrap' }} title={live ? 'Following Boston time' : 'Following the shown time'}>
              Auto · {daylightLabel(hud.time)}
            </span>
          )}
        </footer>
      )}


    </div>
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
function transitSourceAt(transit: Transit, t: number, live: boolean, weekday: number): TransitSource | null {
  if (live) return transit.feed;
  transit.schedule?.setTime(t, weekday);
  return transit.schedule;
}

/** Bikes and empty docks at every BU dock at `target` (sim seconds): live if that's now, else estimated. */
function dockStatusAt({ data, feed }: Bikes, target: number): Map<string, DockEstimate> {
  const now = wallClockSeconds();
  return new Map(data.stations.map((s) => [s.id, estimateDock(s, feed.status(s), data.binSeconds, now, target)]));
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
 * FitRec at Fenway). The building's tag carries its main space's load; the glow still uses the
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
    const amenities = places.filter((o) => AMENITY_KINDS.has(o.location.kind));
    const rest = places.filter((o) => !AMENITY_KINDS.has(o.location.kind));
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
