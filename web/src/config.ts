// Runtime configuration. Everything environment-specific comes from Vite env vars (see .env.example),
// never from literals inside components.

export const config = {
  mapUrl: import.meta.env.VITE_MAP_URL ?? '/map', // served by this same app; see vite.config.ts
  eventImpactUrl: import.meta.env.VITE_EVENT_IMPACT_URL ?? '/data/event-impact.json', // built by map-client's prepare:data
  appName: 'Flowcast',
} as const;
