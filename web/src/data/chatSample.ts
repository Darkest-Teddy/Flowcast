// DEVELOPMENT ONLY. A fixed Ask chat conversation and directory for checking the /ask page
// without the Ask server (/ask?sample=1 in `npm run dev`). Every figure here is made up for layout
// testing: it is not from the model, the simulation or any dataset, and the page labels it
// "Sample response — not from the model". api.chatSample() loads it only when import.meta.env.DEV,
// so production builds never include it.

const hours = ['8 AM', '9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM', '5 PM', '6 PM', '7 PM', '8 PM', '9 PM', '10 PM'];

export const chatSample = {
  directory: {
    chatAvailable: true,
    model: 'sample',
    domains: [
      {
        id: 'crowds',
        title: 'Crowds by place and hour',
        description: 'Simulated students in each building over the day, against its published seats or stated capacity.',
        datasets: [
          { name: 'BU Fall 2026 class schedule', kind: 'published', period: 'Fall 2026', url: 'https://www.bu.edu/link/bin/uiscgi_studentlink.pl', coverage: '3,805 class meetings' },
          { name: 'Simulated student day', kind: 'simulated', period: 'Representative week', url: null, coverage: '18,000 students' },
          { name: 'Room capacities', kind: 'assumption', period: null, url: null, coverage: '212 places' },
        ],
        examples: ['When is Mugar quietest on Tuesday?', 'Which library is least crowded at 2 PM?', 'Compare GSU and Warren dining at lunch'],
      },
      {
        id: 'dining',
        title: 'Dining',
        description: 'Dining hall hours and how full the simulation projects each one to be.',
        datasets: [{ name: 'BU Dining hours', kind: 'published', period: 'Oct 2026', url: 'https://www.bu.edu/dining/', coverage: '6 dining halls' }],
        examples: ['Quietest dining hall at 6 PM', 'Is Marciano open late on Friday?'],
      },
      {
        id: 'transit',
        title: 'Transit',
        description: 'MBTA Green Line B ridership and BU shuttle stops near campus.',
        datasets: [
          { name: 'MBTA ridership by stop', kind: 'published', period: 'Fall 2025', url: 'https://mbta-massdot.opendata.arcgis.com/', coverage: '8 stops' },
          { name: 'Hourly ridership shape', kind: 'mixed', period: null, url: null, coverage: null },
        ],
        examples: ['How busy is BU Central station at 5 PM?', 'When do the most people ride the B line?'],
      },
    ],
  },
  conversation: [
    { role: 'user', text: 'How busy are the libraries this afternoon?' },
    {
      role: 'assistant',
      response: {
        answer:
          '**Mugar** is the busiest library in the afternoon, peaking around **2 PM** at about 78% of its seats.\n\n- **SEL** stays quieter all day.\n- **Pardee** closes at 10 PM, so its line stops there.\n\nThese are simulated students over published seats, not a live count.',
        visuals: [
          {
            id: 'v1', kind: 'line', title: 'Libraries over the day', source: 'simulated', note: 'Simulated students over published seats',
            unit: '% full', x: hours,
            series: [
              { name: 'Mugar', values: [22, 35, 48, 60, 66, 74, 78, 75, 70, 62, 55, 49, 41, 30, 18] },
              { name: 'SEL', values: [10, 18, 26, 31, 35, 40, 44, 42, 38, 33, 29, 25, 20, 14, 9] },
              { name: 'Pardee', values: [8, 15, 30, 42, 50, 58, 61, 57, 50, 43, 36, 28, 20, null, null] },
            ],
            marker: { index: 6, label: 'Now' },
          },
          {
            id: 'v2', kind: 'bar', title: 'Libraries at 2 PM', source: 'simulated', note: 'Simulated students over published seats',
            unit: '% full',
            bars: [
              { label: 'Mugar Memorial Library', value: 78, level: 'Busy', detail: '1,547 of 1,980 seats' },
              { label: 'Pardee Management Library', value: 61, level: 'Moderate', detail: '152 of 250 seats' },
              { label: 'Science & Engineering Library', value: 44, level: 'Moderate', detail: '132 of 300 seats' },
              { label: 'Music Library', value: 12, level: 'Quiet', detail: null },
              { label: 'Stone Science Library', value: null, level: null, detail: 'Closed' },
            ],
          },
        ],
        show: null,
        mapLink: '/map?at=14:00&speed=1',
        sources: [
          { label: 'BU Fall 2026 class schedule', domain: 'crowds', kind: 'published', url: 'https://www.bu.edu/link/bin/uiscgi_studentlink.pl' },
          { label: 'Simulated student day', domain: 'crowds', kind: 'simulated', url: null },
          { label: 'Library seat counts', domain: 'crowds', kind: 'assumption', url: null },
        ],
        followUps: ['When is SEL quietest?', 'Compare Mugar on Monday and Friday'],
        model: 'sample',
        calls: ['crowd_timeline', 'rank_places'],
      },
    },
    { role: 'user', text: 'What about dining tonight?' },
    {
      role: 'assistant',
      response: {
        answer: 'Dinner peaks at **6 PM**. **Warren Towers** is the fullest; **GSU** has the most room.',
        visuals: [
          {
            id: 'v3', kind: 'stats', title: 'Dining at 6 PM', source: 'mixed', note: 'Hours are published; crowding is simulated',
            items: [
              { label: 'Dining halls open', value: '5 of 6', detail: 'Fenway Dining closes at 3 PM' },
              { label: 'Busiest', value: '91%', detail: 'Warren Towers, Packed' },
              { label: 'Most room', value: '38%', detail: 'GSU, Quiet' },
              { label: 'Latest close', value: 'Open until 10 PM', detail: 'Marciano Commons' },
            ],
          },
          {
            id: 'v4', kind: 'table', title: 'Dining hall hours today', source: 'published', note: 'BU Dining, Oct 2026',
            columns: [
              { key: 'name', label: 'Dining hall', align: 'left' },
              { key: 'opens', label: 'Opens', align: 'left' },
              { key: 'closes', label: 'Closes', align: 'left' },
              { key: 'seats', label: 'Seats', align: 'right' },
            ],
            rows: [
              { name: 'Marciano Commons', opens: '7 AM', closes: '10 PM', seats: 1200 },
              { name: 'Warren Towers', opens: '7 AM', closes: '9 PM', seats: 950 },
              { name: 'West Campus', opens: '7 AM', closes: '9 PM', seats: 600 },
              { name: 'George Sherman Union', opens: '8 AM', closes: '8 PM', seats: 600 },
              { name: 'Fenway Dining', opens: '11 AM', closes: '3 PM', seats: null },
            ],
          },
          // Malformed on purpose: the page must drop it, not crash.
          { id: 'v5', kind: 'pie', title: 'Not a supported kind', source: 'simulated' },
        ],
        show: null,
        mapLink: null,
        sources: [
          { label: 'BU Dining hours', domain: 'dining', kind: 'published', url: 'https://www.bu.edu/dining/' },
          { label: 'Simulated student day', domain: 'crowds', kind: 'simulated', url: null },
        ],
        followUps: ['Is Marciano quieter at 7 PM?'],
        model: 'sample',
        calls: ['dining_hours', 'rank_places'],
      },
    },
  ],
} as const;
