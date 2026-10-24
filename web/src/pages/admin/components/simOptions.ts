import type { Lighting, Weather } from '../../../data/types';

export const weatherOptions: { value: Weather; label: string; description: string }[] = [
  { value: 'live', label: 'Live from Open-Meteo', description: 'Follows the real Boston weather, checked every 10 minutes.' },
  { value: 'clear', label: 'Clear', description: 'Normal routines. Outdoor spots and walkways fill up between classes.' },
  { value: 'rain', label: 'Rain', description: 'Agents take indoor routes and stay longer in libraries and dining halls.' },
  { value: 'snow', label: 'Snow', description: 'Fewer trips across campus. The Green Line and shuttles get busier.' },
  { value: 'heatwave', label: 'Heatwave', description: 'Agents skip long walks and crowd air-conditioned buildings.' },
];

export const lightingOptions: { value: Lighting; label: string }[] = [
  { value: 'dawn', label: 'Dawn' },
  { value: 'day', label: 'Day' },
  { value: 'dusk', label: 'Dusk' },
  { value: 'night', label: 'Night' },
];

export const speedLabel = (n: number) => (n === 1 ? 'Live clock' : `×${n}`);
export const weatherLabel = (w: Weather) => weatherOptions.find((o) => o.value === w)?.label ?? w;
