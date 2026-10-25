export interface PersonalSchedule {
  asOf: string;
  windowStart: string;
  windowEnd: string;
  truncated: boolean;
  items: Array<{
    title: string;
    start: string;
    end: string;
    locationId: string;
    locationText: string;
  }>;
}
