export type StudyAmenity = 'quiet' | 'group' | 'outlets' | 'whiteboard' | 'food';

export interface StudySpot {
  id: string;
  locationId: string;
  name: string;
  area: string;
  amenities: Partial<Record<StudyAmenity, boolean>>;
  notes: string;
  sourceUrl: string;
  checkedAt: string;
  hoursUrl: string;
  maxSessionMinutes?: number;
}

const checkedAt = '2026-10-25';
const hoursUrl = 'https://www.bu.edu/library/visit-study/hours/';
const access = 'Bring a valid BU ID; unaffiliated visitors need advance permission.';

// Unknown amenities are omitted. Quiet means a designated silent zone, not live noise or occupancy.
// BU's room-level "Power" feature maps to outlets; it does not promise power at every seat.
export const studySpots: StudySpot[] = [
  {
    id: 'mugar-pal-lounge',
    locationId: 'mugar',
    name: 'Mugar PAL Study Lounge',
    area: 'Mugar Memorial Library, 3rd floor',
    amenities: { group: true, outlets: true, whiteboard: true },
    notes: `Open collaborative seating during library hours. ${access}`,
    sourceUrl: 'https://www.bu.edu/library/space/pal-lounge/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'mugar-riverview',
    locationId: 'mugar',
    name: 'Mugar Riverview Reading Room',
    area: 'Mugar Memorial Library, 1st floor, Room 115',
    amenities: { quiet: true, outlets: true, whiteboard: true },
    notes: `Silent study only when the room is not being used for instruction or staff meetings. ${access}`,
    sourceUrl: 'https://www.bu.edu/library/space/mugar-riverview-reading-room-room-115/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'pardee-team-rooms',
    maxSessionMinutes: 120,
    locationId: 'pardee',
    name: 'Pardee Team Rooms',
    area: 'Pardee Management Library, rooms L214A, L214B, 214C and 318N',
    amenities: { group: true, outlets: true, whiteboard: true },
    notes: `Reservable by BU students, faculty and staff for a combined two hours per 24 hours. Room capacities range from four to eight people. ${access}`,
    sourceUrl: 'https://www.bu.edu/library/space/pardee-management-library-team-room/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'sel-lower-level',
    locationId: 'sel',
    name: 'Science & Engineering Library Lower Level',
    area: 'Science & Engineering Library, lower level',
    amenities: { quiet: true },
    notes: `Designated silent study space; check current library hours. ${access}`,
    sourceUrl: 'https://www.bu.edu/library/space/science-engineering-library-lower-level/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'sel-group-alcove',
    maxSessionMinutes: 120,
    locationId: 'sel',
    name: 'Science & Engineering Library Group Study Alcove',
    area: 'Science & Engineering Library, group study alcove',
    amenities: { group: true },
    notes: `Reservable for up to two hours at a time for up to two people. The alcove has no door. ${access}`,
    sourceUrl: 'https://www.bu.edu/library/space/science-engineering-library-group-study-alcove/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'pickering-group-work-room',
    maxSessionMinutes: 180,
    locationId: 'pickering-library',
    name: 'Pickering Group Work Room',
    area: 'Pickering Educational Resources Library, Group Work Room',
    amenities: { group: true, outlets: true, whiteboard: true },
    notes: `Reservable for up to eight people and up to three hours per day. ${access}`,
    sourceUrl: 'https://www.bu.edu/library/space/pickering-educational-resources-library/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'stone-open-seating',
    locationId: 'stone-library',
    name: 'Stone Science Library Open Seating',
    area: 'Stone Science Library, open study area',
    amenities: { quiet: true },
    notes: `Open silent study seating during library hours. ${access}`,
    sourceUrl: 'https://www.bu.edu/library/space/stone-science-library/',
    checkedAt,
    hoursUrl,
  },
];
