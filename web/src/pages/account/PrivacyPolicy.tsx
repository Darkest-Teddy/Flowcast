import { Policy, type Clause } from './Policy';
import { REPO } from './Terms';

/** Shown at the top of the policy; change it whenever the text below changes. */
export const PRIVACY_EFFECTIVE = 'October 25, 2026';

const SUMMARY = [
  { title: 'Only what features need', body: 'Your Google name and email, plus what you choose to add. Crowd reports are anonymous counts.' },
  { title: 'No ads, no sale, no trackers', body: 'No analytics or advertising scripts, and your data is never sold or shared for marketing.' },
  { title: 'AI only when you ask', body: 'Ask and voice send your question, and up to two weeks of classes, to OpenAI.' },
  { title: 'In your control', body: 'Download everything, change it, or delete it from this page.' },
];

/*
 * Every statement here is checked against the code: what the dashboard server stores
 * (server/src/dashboard/router.ts), what Ask sends (web/src/lib/personalSchedule.ts, 14 days;
 * store: false in server/src/agent.ts, chat.ts and voice.ts), what the browser calls (Mapbox,
 * MBTA, Bluebikes, Open-Meteo) and keeps (theme, sidebar and map settings; the Ask chat in
 * sessionStorage), and how crowd reports are counted (server/src/dashboard/crowdReports.ts: a count
 * per place, Boston date, hour and answer, with no account column; the throttle is in-memory HMACs)
 * and remembered on the device (web/src/lib/crowdReports.ts). Change the policy with the code.
 */
const CLAUSES: Clause[] = [
  {
    id: 'scope',
    title: 'Who we are and what this covers',
    body: <>
      <p>Flowcast is a student project built for the Hackachusetts hackathon. It is a prototype, not a commercial service, and it is not run by Boston University. This policy covers the Flowcast dashboard and campus map.</p>
      <p>The campus map and the landing page work without an account and collect nothing about you. Everything below applies once you sign in.</p>
    </>,
  },
  {
    id: 'collect',
    title: 'What we collect',
    body: <>
      <p><strong>From your Google sign-in:</strong> your name, email address and an account ID. Your name becomes your Flowcast profile name, which you can change. We never receive your Google password and never ask for access to your calendar, contacts, Drive or location.</p>
      <p><strong>What you choose to add:</strong></p>
      <ul>
        <li>your profile: home dorm, usual lunch and dinner times, favourite study spot and avatar colour;</li>
        <li>your class schedule, if you import one: each class’s title, start and end times and room;</li>
        <li>the clubs you follow and your notification preferences.</li>
      </ul>
      <p><strong>Crowd reports:</strong> if you answer “Was it busy?”, only an anonymous count is kept, never anything that identifies you (see Crowd reports below).</p>
      <p><strong>What we don’t collect:</strong> your location, your contacts, anything from your other apps, or analytics about how you use Flowcast. There are no advertising or tracking scripts and no tracking cookies.</p>
    </>,
  },
  {
    id: 'use',
    title: 'How we use it',
    body: <>
      <p>Only to run the features you use: leave-by times, “your next gap”, study spot suggestions, answers in Ask, and showing your clubs’ events.</p>
      <ul>
        <li>Your schedule is never added to the shared campus simulation, and no one else can see it.</li>
        <li>We don’t sell your data, share it for advertising, or build a profile of you beyond what you see in Flowcast.</li>
        <li>We don’t use your data to train AI models.</li>
      </ul>
    </>,
  },
  {
    id: 'ai',
    title: 'AI features (Ask and voice)',
    body: <>
      <p>Ask and voice are optional. When you use them, your question and the conversation so far go to OpenAI to produce an answer. If you’ve imported a schedule, up to two weeks of your classes (titles, times and rooms) go with each question so Ask can answer things like “where is my next class?”. Voice sends your speech to OpenAI while voice is on.</p>
      <p>Flowcast sends these requests with OpenAI’s response storage turned off, so they aren’t saved for later use. Under OpenAI’s API data policy, OpenAI may still keep them for a limited time to detect abuse, and does not use API data to train its models by default.</p>
      <p>Our own server logs record only that a request failed and why, never the text of your question or your schedule. The Ask conversation is kept only in your browser tab and is cleared when you close it.</p>
    </>,
  },
  {
    id: 'reports',
    title: 'Crowd reports (“Was it busy?”)',
    body: <>
      <p>After Flowcast suggests a place, it may ask once, on a later visit, how busy it was: Quiet, OK or Packed. You can also report a place you’re at. Answering is optional; “Didn’t go” or closing the question sends nothing.</p>
      <p>Your answer only adds one to a count for that place, Boston date and Boston hour. The time is rounded to the hour before it’s stored, and nothing about you is stored with it: no account, session or exact time. Because a count can’t be traced back to anyone, reports aren’t part of your data download, and deleting your profile doesn’t remove them.</p>
      <p>To stop the same person reporting a place over and over, the server briefly remembers a scrambled form of your account ID (a keyed hash) in memory only. It is never written down, can’t be matched to a stored count, and disappears within the hour or when the server restarts.</p>
      <p>Other students see reports only as totals, and only for places and hours with at least three reports in the last week. Reports are shown beside the model’s projections and never change them.</p>
    </>,
  },
  {
    id: 'processors',
    title: 'Services that handle your data',
    body: <>
      <p>Flowcast relies on a few outside services, each of which only sees what it needs:</p>
      <ul>
        <li><strong>Supabase</strong> runs Google sign-in and holds your sign-in record (name, email, account ID).</li>
        <li><strong>Railway</strong> hosts the app and the database that stores your profile, schedule and follows. Like any web host, it handles standard connection data such as IP addresses.</li>
        <li><strong>OpenAI</strong> answers Ask and voice, as described above.</li>
        <li><strong>Mapbox, MBTA, Bluebikes and Open-Meteo</strong> provide map tiles, transit times, bike availability and weather. Your browser fetches these directly, so they receive your IP address, but no personal data.</li>
      </ul>
    </>,
  },
  {
    id: 'device',
    title: 'What stays on your device',
    body: <p>Your browser keeps your sign-in session, your theme, sidebar and map settings, (in the tab only) your Ask conversation, and a short list of up to eight places Flowcast recently suggested, so it can ask once whether they were busy. These never leave your device except to sign you in, and clearing your browser data removes them.</p>,
  },
  {
    id: 'retention',
    title: 'How long we keep it',
    body: <>
      <p>We keep your Flowcast data for as long as you have an account. Nothing expires automatically. Anonymous crowd-report counts are kept as campus totals; they aren’t linked to any account.</p>
      <p>“Delete profile data” on this page permanently removes your Flowcast record (profile, schedule, follows and preferences) from our database straight away and signs you out. Your sign-in record stays with Supabase. Since this is a student project with no private support inbox, if you want that removed too, open an issue on <a href={REPO} target="_blank" rel="noreferrer">GitHub</a> that says only that you’d like your sign-in record deleted. Don’t include your email or any other personal details in the issue.</p>
    </>,
  },
  {
    id: 'rights',
    title: 'Your choices',
    body: <ul>
      <li><strong>See it:</strong> “Download account data” gives you everything we store about you, as a file.</li>
      <li><strong>Change it:</strong> edit your profile at any time, or re-import or remove your schedule in Calendars.</li>
      <li><strong>Delete it:</strong> “Delete profile data” removes it all.</li>
      <li><strong>Limit it:</strong> everything beyond sign-in is optional. You can use Flowcast without importing a schedule, without Ask or voice, and without answering “Was it busy?”.</li>
    </ul>,
  },
  {
    id: 'security',
    title: 'Security',
    body: <>
      <p>All traffic uses HTTPS. Every request for your data is checked against your sign-in, and each account can only read and change its own record. Database credentials and AI keys stay on the server and never reach your browser.</p>
      <p>Flowcast is a prototype and hasn’t been through a formal security audit, so please don’t store anything in it you’d consider sensitive.</p>
    </>,
  },
  {
    id: 'audience',
    title: 'Who Flowcast is for',
    body: <p>Flowcast is meant for Boston University students and visitors. It isn’t directed at children under 13, and we don’t knowingly collect their data.</p>,
  },
  {
    id: 'changes',
    title: 'Changes to this policy',
    body: <p>If what Flowcast collects or how it uses it changes, this policy changes with it, and the date at the top shows the current version.</p>,
  },
];

/** Privacy policy: a short summary, then each clause as a collapsible section. */
export function PrivacyPolicy() {
  return <Policy id="privacy" title="Privacy policy" effective={PRIVACY_EFFECTIVE} summary={SUMMARY} clauses={CLAUSES}
    intro={<>How Flowcast handles your data, in plain language. The <a href="#terms">terms of service</a> cover how you may use Flowcast.</>} />;
}
