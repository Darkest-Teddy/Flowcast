# Kickoff Checklist — Flowcast (DS+X)

Use this on-site, starting at 8:00 AM Saturday. It turns Section 2, 13, and 15 of `campus-digital-twin-spec.md` into a literal order of operations for the first hour.

Before writing this, I checked the full plan for gaps. Six things were missing — logistics the spec never had to cover because it was written before kickoff, not at kickoff. They're folded into this checklist below, and flagged inline with **[NEW]** so you know what's new versus what's a restatement of the main spec.

---

## 0. Physical/logistics setup (do this before touching code) **[NEW]**

- [ ] Confirm power: at least one outlet or power strip at the team table, for the laptop that will run the live demo. A dead laptop battery at hour 26 is a fully preventable failure.
- [ ] Bring (or confirm someone has): the correct HDMI adapter/dongle for the demo laptop's actual port, a spare HDMI cable, and a portable battery pack as backup power.
- [ ] Set up one shared real-time communication channel for the 5 people (Slack, Discord, iMessage group — whatever the team already uses). Pin the repo link, the Railway project link, and this checklist in it.
- [ ] Confirm who's holding each secret/credential and how it's shared: the LLM API key, any Mapbox/MapLibre token, and the Railway project credentials. Put them in a shared `.env.example` pattern and a password manager or encrypted note — **never commit real keys to the repo.**

## 1. Submission requirements **[NEW — verify this immediately]**

Most hackathons, DS+X included, require a separate submission (commonly a Devpost page: a write-up, screenshots, a short demo video, and a repo link) by a deadline that is **earlier than the live judging walk-through**. This plan's roadmap (Section 13) does not currently reserve time for this. Before anything else:

- [ ] Find the actual submission requirement and deadline (ask an organizer/mentor directly if it's not obvious from the event page).
- [ ] If a written submission or demo video is required, **add a block for it into Section 13's roadmap now** — the current plan assumes the only deliverable is the live 10:00–11:00 AM judging window, which may be wrong.

## 2. Role assignment (Section 2 of the main spec)

- [ ] Assign the 5 roles to real names: Data & Schedules Lead, Simulation & ML Lead, Realtime Backend Lead, 3D Map/Frontend Lead, Mobile Web/Product & Pitch Lead.
- [ ] Say out loud who owns final sign-off on scope decisions during the event (there should be one person who can make a fast call if two teammates disagree at 3 AM).

## 3. Repo and environment setup **[expands on Section 8]**

- [ ] Create the shared repository. Recommended: a single monorepo with top-level folders (`/data-pipeline` for Python, `/server` for Node.js, `/map-client` for the big-screen React app, `/mobile` for the phone React app) — one repo is easier for 5 people to coordinate on in 27 hours than four separate repos.
- [ ] Agree on a branching rule before anyone writes code: e.g., everyone branches off `main`, opens a pull request, one quick self-merge after a glance — no long-lived feature branches, given the time pressure.
- [ ] Set up the Railway project: one PostgreSQL instance, one Redis instance, the Node.js service skeleton deployed once (even empty), so the pipeline from laptop → GitHub → Railway is proven working in hour 1, not discovered broken in hour 20.

## 4. Confirm the three open items from Section 15

- [ ] Confirm which teammate's real MyBU schedule is the seed example, and get their explicit sign-off to use it in the public demo.
- [ ] Create the free Mapbox GL JS account and access token (corrected from an earlier draft that recommended MapLibre — see Section 6.1 of the main spec: only Mapbox's proprietary "Standard" style gives textured, lit buildings for free; its 50,000-map-load free tier covers the whole event, so there's no real billing risk).
- [ ] Agree on the exact wording of the data-retention consent line before the first real persona is collected tonight (Section 10.1 of the main spec has the draft: "Your name, avatar, and schedule may be kept and shown in future demos of this project.").

## 5. QR code and public URL **[NEW]**

The main spec assumes a QR code exists but never says when it's generated or what it points to.

- [ ] Decide the public URL early: either the raw Railway-hosted URL, or a shortened link (e.g., a free URL shortener) pointing to it — a short link is easier to also write on a whiteboard as a backup if the QR code itself fails to scan for someone.
- [ ] Generate the actual QR code as soon as the mobile app has a working placeholder page (don't wait for the final version — regenerate later if the URL changes, but have *something* scannable early so you can test the phone flow all day, not just at the end).
- [ ] Test the QR code on at least two different phones (iOS and Android) before judging — camera apps handle QR codes slightly differently.

## 6. Hour 0–1 build tasks (from Section 13 of the main spec)

- [ ] Read the full spec together as a team once, so everyone shares the same mental model before splitting up.
- [ ] Data Lead: start the OpenStreetMap pull for the BU campus bounding box and the course-catalog scrape.
- [ ] Simulation & ML Lead: scaffold the synthetic schedule generator.
- [ ] Realtime Backend Lead: scaffold the Node.js server, Socket.IO, and the database schema.
- [ ] 3D Map/Frontend Lead: scaffold the React app with Mapbox GL JS (Standard style) rendering the real campus outline (no agents yet).
- [ ] Mobile Web Lead: scaffold the phone web app shell and the QR-code entry flow.

---

## Still worth a team decision before you're deep into building **[NEW]**

These aren't blocking, but they're the kind of thing that's cheap to decide now and expensive to improvise at hour 24:

- **Who actually speaks during the live pitch**, and who operates the laptop/demo controls while that person talks — these are usually two different people.
- **A single rehearsed recovery line** for if the live demo visibly breaks in front of judges, since the team has explicitly chosen "live or nothing" with no video fallback (Section 11). Even just agreeing in advance who says what ("here's what this is supposed to do, let me show you the dashboard view instead") keeps a failure from turning into dead air.
- **Sleep/shift plan**, informally — with 5 people and 27 hours, even a loose agreement that 1–2 people nap in shifts overnight while others hold the overnight block (Section 13's 2:00–5:00 AM slot) keeps the 7:00 AM feature freeze from hitting a fully exhausted team all at once.
