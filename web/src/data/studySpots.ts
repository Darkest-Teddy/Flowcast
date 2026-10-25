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
// BU's room-level 'Power' feature maps to outlets; it does not promise power at every seat.
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
  {
    id: 'mugar-first-floor',
    locationId: 'mugar',
    name: 'Mugar 1st Floor Open Study',
    area: 'Mugar Memorial Library, 1st floor',
    amenities: {
      outlets: true,
      whiteboard: true
    },
    notes: 'Considerate-volume open seating with computers.',
    sourceUrl: 'https://www.bu.edu/library/space/1st-floor-open-study/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'mugar-fiedler',
    locationId: 'mugar',
    name: 'Arthur Fiedler Reading Room',
    area: 'Mugar Memorial Library, 2nd floor',
    amenities: {
      quiet: true,
      outlets: true
    },
    notes: 'Silent reading space; collection materials stay in the library.',
    sourceUrl: 'https://www.bu.edu/library/space/arthur-fiedler/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'mugar-basement',
    locationId: 'mugar',
    name: 'Mugar Basement Open Study',
    area: 'Mugar Memorial Library, basement',
    amenities: {
      group: true,
      outlets: true,
      whiteboard: true
    },
    notes: 'Collaborative seating during library hours.',
    sourceUrl: 'https://www.bu.edu/library/space/mugar-basement-open-study/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'mugar-fourth-floor',
    locationId: 'mugar',
    name: 'Mugar 4th Floor Open Study',
    area: 'Mugar Memorial Library, 4th floor',
    amenities: {
      quiet: true,
      outlets: true,
      whiteboard: true
    },
    notes: 'Silent seating around the floor perimeter and among the stacks.',
    sourceUrl: 'https://www.bu.edu/library/space/mugar-4th-floor-study/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'mugar-fifth-floor',
    locationId: 'mugar',
    name: 'Mugar 5th Floor Open Study',
    area: 'Mugar Memorial Library, 5th floor',
    amenities: {
      quiet: true,
      outlets: true,
      whiteboard: true
    },
    notes: 'Silent seating among the stacks.',
    sourceUrl: 'https://www.bu.edu/library/space/mugar-5th-floor-open-study/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'pardee-open-study',
    locationId: 'pardee',
    name: 'Pardee Open Study Spaces',
    area: 'Questrom School of Business, 3rd floor',
    amenities: {
      outlets: true,
      whiteboard: true
    },
    notes: 'Mixed silent and considerate areas with computers. Present your BU ID at entry.',
    sourceUrl: 'https://www.bu.edu/library/space/pardee-management-library-open-study-spaces/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'astronomy-open-seating',
    locationId: 'astronomy-library',
    name: 'Astronomy Library Open Seating',
    area: 'College of Arts & Sciences, 6th floor, 725 Commonwealth Avenue',
    amenities: {
      quiet: true
    },
    notes: 'Unstaffed silent study space; closed on weekends and holidays. Check current hours.',
    sourceUrl: 'https://www.bu.edu/library/space/astronomy-library-open-seating/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'pickering-quiet-room',
    locationId: 'pickering-library',
    name: 'Pickering Quiet Study Room',
    area: 'Pickering Educational Resources Library',
    amenities: {
      group: true,
      whiteboard: true
    },
    notes: 'Reservable for up to three people. Despite its name, BU categorizes this room as collaborative; silent study is not verified. Check booking limits when reserving.',
    sourceUrl: 'https://www.bu.edu/library/space/pickering-quiet-study-room/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'mugar-reservable-rooms',
    locationId: 'mugar',
    name: 'Mugar Reservable Study Rooms',
    area: 'Mugar Memorial Library, floors 4–6',
    amenities: {
      outlets: true,
      whiteboard: true
    },
    notes: 'Twelve rooms for one to three people, depending on the room. BU students, faculty and staff may book a combined two hours per 24 hours.',
    sourceUrl: 'https://www.bu.edu/library/space/mugar-reservable-study-rooms/',
    maxSessionMinutes: 120,
    checkedAt,
    hoursUrl,
  },
  {
    id: 'mugar-music-listening',
    locationId: 'mugar',
    name: 'Mugar Music Listening Room',
    area: 'Mugar Memorial Library, 2nd floor',
    amenities: {
      quiet: true,
      outlets: true
    },
    notes: 'Silent study seating alongside turntables and listening stations; headphones listed by BU.',
    sourceUrl: 'https://www.bu.edu/library/space/mugar-music-listening-room/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'mugar-mezzanine',
    locationId: 'mugar',
    name: 'Mugar Mezzanine Open Study',
    area: 'Mugar Memorial Library, 2nd floor, south side',
    amenities: {
      outlets: true
    },
    notes: 'Considerate-volume seating overlooking the first floor.',
    sourceUrl: 'https://www.bu.edu/library/space/mugar-2nd-floor-mezzanine-open-study/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'mugar-third-floor',
    locationId: 'mugar',
    name: 'Mugar 3rd Floor Open Study',
    area: 'Mugar Memorial Library, 3rd floor',
    amenities: {
      outlets: true,
      whiteboard: true
    },
    notes: 'Considerate-volume seating; BU describes study and group work here, rather than a designated collaborative zone.',
    sourceUrl: 'https://www.bu.edu/library/space/mugar-3rd-floor-open-study/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'mugar-sixth-floor',
    locationId: 'mugar',
    name: 'Mugar 6th Floor Open Study',
    area: 'Mugar Memorial Library, 6th floor, north side',
    amenities: {
      quiet: true,
      outlets: true,
      whiteboard: true
    },
    notes: 'Silent seating overlooking the Charles River; African Studies Library occupies the south side.',
    sourceUrl: 'https://www.bu.edu/library/space/mugar-6th-floor-open-study/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'sel-first-floor',
    locationId: 'sel',
    name: 'Science & Engineering Library 1st Floor',
    area: 'Science & Engineering Library, 1st floor',
    amenities: {},
    notes: 'Considerate-volume open study seating during library hours.',
    sourceUrl: 'https://www.bu.edu/library/space/science-engineering-1st-floor-open-study/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'pickering-open-study',
    locationId: 'pickering-library',
    name: 'Pickering Open Study Space',
    area: 'Pickering Educational Resources Library',
    amenities: {},
    notes: 'Considerate-volume open seating during library hours.',
    sourceUrl: 'https://www.bu.edu/library/space/pickering-educational-resources-library-open-study-space/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'mugar-mlk-reading',
    locationId: 'mugar',
    name: 'MLK Jr. Reading Room',
    area: 'Mugar Memorial Library, 3rd floor',
    amenities: {
      outlets: true
    },
    notes: 'Reading space with a permanent archival exhibit. BU describes silent seating but labels the zone considerate; silent study is not verified.',
    sourceUrl: 'https://www.bu.edu/library/space/mugar-3rd-floor-mlk-reading-room/',
    checkedAt,
    hoursUrl,
  },
  {
    id: 'mugar-second-floor',
    locationId: 'mugar',
    name: 'Mugar 2nd Floor Open Study',
    area: 'Mugar Memorial Library, 2nd floor, north side',
    amenities: {
      quiet: true,
      outlets: true
    },
    notes: 'Silent seating overlooking the Charles River.',
    sourceUrl: 'https://www.bu.edu/library/space/mugar-2nd-floor-open-study/',
    checkedAt,
    hoursUrl,
  },
];
