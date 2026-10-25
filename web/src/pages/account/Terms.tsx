import type { ReactNode } from 'react';
import styles from './Terms.module.css';

/** Shown at the top of the terms; change it whenever the text below changes. */
export const TERMS_EFFECTIVE = 'October 25, 2026';
const REPO = 'https://github.com/Darkest-Teddy/Flowcast';

/** The four things worth knowing if nothing else is read. */
const SUMMARY = [
  { title: 'Forecasts are estimates', body: 'Crowd levels come from a simulation of public data, not live head counts.' },
  { title: 'Not for emergencies', body: 'In an emergency, follow BU Police, BU Alerts and 911, never Flowcast.' },
  { title: 'Ask uses AI', body: 'Questions, and up to two weeks of your classes, go to OpenAI to be answered.' },
  { title: 'Your data stays yours', body: 'Download or delete it on this page at any time.' },
];

const CLAUSES: { id: string; title: string; body: ReactNode }[] = [
  {
    id: 'about',
    title: 'What Flowcast is',
    body: <>
      <p>Flowcast is an independent project that models how busy Boston University’s campus will be, using public sources such as class schedules, room capacities, opening hours, event listings and transit timetables. It is not an official Boston University service, and BU does not operate, review or endorse it.</p>
      <p>By signing in or using Flowcast you agree to these terms. If you don’t agree, please don’t use it.</p>
    </>,
  },
  {
    id: 'forecasts',
    title: 'Crowd forecasts are estimates',
    body: <>
      <p>Every crowd level, percentage, “best time” and leave-by time in Flowcast comes from a simulation. It is not a live count of people, and real crowds can differ a lot from the model, especially around events, exams, weather and holidays.</p>
      <p>Opening hours, event details and transit times are copied from published sources and can be out of date. Check the official source before you rely on one, especially for anything time-sensitive.</p>
    </>,
  },
  {
    id: 'safety',
    title: 'Safety and emergencies',
    body: <>
      <p>Fire drills, alarms and closures on the map are what-if rehearsals. They do not describe real incidents and are not a warning system.</p>
      <p>Never use Flowcast to decide what to do in a real emergency. Follow instructions from BU Police, BU Alerts, building staff and emergency services, and call 911 if you are in danger. Walking routes and times are estimates and do not account for accessibility barriers, construction or closures.</p>
    </>,
  },
  {
    id: 'ai',
    title: 'Ask and voice',
    body: <>
      <p>Ask and voice answers are written by an AI model from OpenAI, working from Flowcast’s data. They can be wrong, incomplete or out of date even when they sound confident, so check anything important.</p>
      <p>To answer, Flowcast sends your question, the conversation so far and, if you’ve imported a schedule, up to two weeks of your classes (titles, times and rooms) to OpenAI. Requests are sent with OpenAI’s response storage turned off. Voice sends your speech to OpenAI while voice is on. The Ask conversation itself is kept only in this browser tab.</p>
      <p>Don’t put sensitive personal information, passwords or anything you wouldn’t want processed by a third party into Ask or voice.</p>
    </>,
  },
  {
    id: 'account',
    title: 'Your account and your data',
    body: <>
      <p>You sign in with Google. Flowcast never sees your Google password and does not request access to your Google Calendar. You are responsible for activity on your account.</p>
      <p>Flowcast stores what you give it: your profile (name, home dorm, meal times, study spot, avatar colour), your imported schedule, your notification preferences and the clubs you follow. Your schedule is not added to the shared campus simulation.</p>
      <p>You keep ownership of everything you add. You let Flowcast store and process it only to run the features you use. You can download it, or delete it and sign out, from this page at any time. Theme and similar settings live in your browser and are cleared with your browser data.</p>
    </>,
  },
  {
    id: 'use',
    title: 'Fair use',
    body: <>
      <p>Please don’t:</p>
      <ul>
        <li>try to reach other people’s data, or get around sign-in or access controls;</li>
        <li>overload the service, or scrape it automatically beyond normal use;</li>
        <li>use Ask or voice to produce harmful, harassing or unlawful content;</li>
        <li>claim to run a club you don’t, or upload a club calendar you have no right to share;</li>
        <li>present Flowcast forecasts as official Boston University information.</li>
      </ul>
      <p>Accounts that break these rules may be suspended or removed.</p>
    </>,
  },
  {
    id: 'clubs',
    title: 'Clubs and events',
    body: <p>Club pages and event listings come from public Terrier Central listings and from verified club officers. Officers are responsible for what they publish. Flowcast may edit or remove listings that are inaccurate, misleading or break these terms.</p>,
  },
  {
    id: 'changes',
    title: 'Changes and availability',
    body: <>
      <p>Flowcast may change, pause or stop any feature at any time, and may be unavailable without notice.</p>
      <p>These terms may change as Flowcast does. The date at the top always shows the current version. If you keep using Flowcast after a change, you accept the new terms.</p>
    </>,
  },
  {
    id: 'liability',
    title: 'No warranty',
    body: <>
      <p>Flowcast is provided free and “as is”, without warranties of any kind, including accuracy, availability or fitness for a particular purpose.</p>
      <p>To the fullest extent the law allows, the people behind Flowcast are not liable for any loss or harm that comes from using it or relying on it, including missed classes, crowding, travel delays or decisions based on a forecast. Nothing here limits rights you have under law that can’t be waived.</p>
    </>,
  },
  {
    id: 'contact',
    title: 'Contact',
    body: <p>Questions about these terms or your data? Open an issue on <a href={REPO} target="_blank" rel="noreferrer">Flowcast’s GitHub repository</a>.</p>,
  },
];

/** Terms of service: a short summary, then each clause as a collapsible section. */
export function Terms() {
  return (
    <section id="terms" className={styles.terms} aria-labelledby="terms-title">
      <header className={styles.head}>
        <h2 id="terms-title">Terms of service</h2>
        <p>Effective {TERMS_EFFECTIVE}</p>
      </header>

      <ul className={styles.summary} aria-label="In short">
        {SUMMARY.map((s) => (
          <li key={s.title} className={styles.point}>
            <strong>{s.title}</strong>
            <span>{s.body}</span>
          </li>
        ))}
      </ul>

      <div className={styles.clauses}>
        {CLAUSES.map((c, i) => (
          <details key={c.id} id={`terms-${c.id}`} className={styles.clause}>
            <summary>
              <span className={styles.number}>{i + 1}</span>
              {c.title}
            </summary>
            <div className={styles.body}>{c.body}</div>
          </details>
        ))}
      </div>
    </section>
  );
}
