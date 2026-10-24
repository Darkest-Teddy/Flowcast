import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { applyIncident, INCIDENT_LIMITATIONS } = await import('../src/sim/incidents.ts');
const { Playback } = await import('../src/sim/playback.ts');
const DAY = 86400;
const location = (id, x, building = id) => ({ id, name:id, short:id, kind:'classroom', position:[x,42], capacity:100, building });
const incident = { id:'drill-1', kind:'fire-drill', locationId:'hall', start:100, duration:100 };
function fixture() {
  const locations = [location('hall',-71), location('dining',-71,'hall'), location('assembly',-70.999), location('far',-70.998), location('home',-71.001)];
  const pos = id => locations.find(location => location.id === id).position;
  const route = (from, to, metres) => ({ path:[pos(from),pos(to)], cumulative:[0,metres] });
  const trip = (agent, from, to, start, end) => ({ agent,from,to,path:[pos(from),pos(to)],timestamps:[start,end] });
  const stay = (agent, location, start, end) => ({ agent,location,start,end });
  return { day:'Monday',buildings:[],locations,
    agents:['occupant','shared','incoming','later','expiry','unaffected'].map(id => ({id,home:id==='occupant'?'hall':'home',model:0,walkSpeed:1})),
    walkRoutes:{'hall>assembly':route('hall','assembly',30),'dining>assembly':route('dining','assembly',30),'hall>far':route('hall','far',100),'dining>far':route('dining','far',100)},
    trips:[trip('incoming','home','hall',90,120),trip('later','home','dining',130,160),trip('expiry','home','hall',170,200),trip('occupant','hall','home',300,330)],
    stays:[stay('occupant','hall',0,300),stay('occupant','home',330,DAY),stay('shared','dining',0,DAY),
      stay('incoming','home',0,90),stay('incoming','hall',120,DAY),stay('later','home',0,130),stay('later','dining',160,DAY),
      stay('expiry','home',0,170),stay('expiry','hall',200,DAY),stay('unaffected','home',0,DAY)] };
}
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
function assertConservation(day) {
  const playback = new Playback(day);
  const boundaries = new Set([0,99,100,199.999,200,DAY-0.001]);
  for (const stay of day.stays) for (const time of [stay.start, stay.end]) for (const offset of [-0.001,0,0.001]) boundaries.add(time+offset);
  for (const trip of day.trips) for (const time of trip.timestamps) for (const offset of [-0.001,0,0.001]) boundaries.add(time+offset);
  for (const time of boundaries) {
    if (time < 0 || time >= DAY) continue;
    for (const agent of day.agents) {
      const states = day.stays.filter(stay=>stay.agent===agent.id && stay.start<=time && time<stay.end).length
        + day.trips.filter(trip=>trip.agent===agent.id && trip.timestamps[0]<=time && time<trip.timestamps.at(-1)).length;
      assert.equal(states,1,`${agent.id} has ${states} states at ${time}`);
    }
    const pop = playback.populationAt(time);
    const offCampus=day.stays.filter(stay=>stay.location==='off-campus' && stay.start<=time && time<stay.end).length;
    assert.equal(pop.indoors+pop.walking+(pop.outdoors ?? 0)+offCampus,day.agents.length,`population at ${time}`);
    assert.equal(new Set(playback.walkingAt(time).map(agent=>agent.id)).size,pop.walking);
  }
}
function assertContinuous(day) {
  for (const agent of day.agents) {
    const trips = day.trips.filter(trip=>trip.agent===agent.id).sort((a,b)=>a.timestamps[0]-b.timestamps[0]);
    for (let i=1;i<trips.length;i++) {
      assert.ok(trips[i].timestamps[0]>=trips[i-1].timestamps.at(-1));
      assert.equal(trips[i].from,trips[i-1].to);
      assert.deepEqual(trips[i].path[0],trips[i-1].path.at(-1));
    }
  }
}

test('immutable deterministic outdoor evacuation has staggered shared-footprint exits', () => {
  const original=freeze(fixture()), before=JSON.stringify(original);
  const result=applyIncident(original,incident);
  assert.equal(result.assemblyLocation.kind,'outdoor');
  assert.equal(result.assemblyLocation.building,''); assert.equal(result.assemblyLocation.capacity,0);
  assert.ok(result.day.locations.includes(result.assemblyLocation));
  assert.equal(result.requestedEndsAt,200); assert.ok(result.endsAt>=200);
  assert.equal(JSON.stringify(original),before); assert.deepEqual(applyIncident(original,incident),result);
  assert.equal(result.day.agents,original.agents);
  const occupants=result.participants.filter(p=>p.role==='occupant');
  assert.equal(occupants.length,2);
  assert.ok(occupants.every(p=>p.departAt>=115 && p.departAt<=190));
  assert.ok(occupants[1].departAt-occupants[0].departAt>=0.5);
  assert.ok(occupants.every(p=>p.assemblyAt>p.departAt && p.releaseAt>=p.assemblyAt+60));
  assert.notEqual(occupants[0].releaseAt,occupants[1].releaseAt);
  assertConservation(result.day); assertContinuous(result.day);
  for(const p of occupants) assert.ok(result.day.stays.filter(s=>s.agent===p.agentId && ['hall','dining'].includes(s.location)).every(s=>s.end<=p.departAt || s.start>=result.endsAt));
  assert.deepEqual(result.day.stays.filter(s=>s.agent==='unaffected'),original.stays.filter(s=>s.agent==='unaffected'));
});

test('in-flight arrivals turn at their actual position; future arrivals wait at origin', () => {
  const original=fixture(), result=applyIncident(original,incident), {day}=result;
  const walks=day.trips.filter(t=>t.agent==='incoming').sort((a,b)=>a.timestamps[0]-b.timestamps[0]);
  assert.deepEqual(walks[0].timestamps,[90,100]);
  assert.deepEqual(walks[1].timestamps,[100,110]);
  assert.deepEqual(walks[1].path,[...walks[0].path].reverse());
  assert.notDeepEqual(walks[0].path.at(-1),original.locations[0].position);
  const later=day.trips.filter(t=>t.agent==='later');
  assert.ok(later.every(t=>t.timestamps[0]>=result.endsAt));
  assert.ok(result.participants.filter(p=>p.role==='arrival').every(p=>p.assemblyAt===null));
  assert.ok(!day.stays.some(s=>['incoming','later'].includes(s.agent) && s.location===result.assemblyLocation.id));
  assertConservation(day); assertContinuous(day);
});

test('expiry permits staggered physical returns without shifting scheduled end times', () => {
  const result=applyIncident(fixture(),incident), {day}=result;
  const p=result.participants.find(p=>p.agentId==='occupant');
  const returning=day.trips.find(t=>t.agent==='occupant' && t.from===result.assemblyLocation.id);
  assert.equal(returning.timestamps[0],p.releaseAt);
  assert.ok(returning.timestamps.at(-1)>p.releaseAt);
  assert.deepEqual(day.trips.find(t=>t.agent==='occupant' && t.to==='home').timestamps,[300,330]);
  assertConservation(day); assertContinuous(day);
});

test('short incidents extend through egress and muster; late-day scenarios reject safely', () => {
  const result=applyIncident(fixture(),{...incident,duration:1});
  assert.ok(result.endsAt>result.requestedEndsAt);
  assert.ok(result.participants.filter(p=>p.role==='occupant').every(p=>p.assemblyAt+60<=result.endsAt));
  assertConservation(result.day); assertContinuous(result.day);
  const base=fixture(); base.trips=[];base.agents=[base.agents[0]];base.stays=[{agent:'occupant',location:'hall',start:0,end:DAY}];
  assert.throws(()=>applyIncident(base,{...incident,start:DAY-10,duration:5}),/midnight/);
});

test('a departure exactly at incident start remains unaffected', () => {
  const base=fixture();
  base.stays.find(s=>s.agent==='occupant' && s.location==='hall').end=100;
  base.stays.find(s=>s.agent==='occupant' && s.location==='home').start=130;
  base.trips.find(t=>t.agent==='occupant').timestamps=[100,130];
  for (const kind of ['fire-drill','building-closure']) {
    const result=applyIncident(base,{...incident,kind});
    assert.ok(!result.participants.some(p=>p.agentId==='occupant'));
    assert.deepEqual(result.day.trips.filter(t=>t.agent==='occupant'),base.trips.filter(t=>t.agent==='occupant'));
    assertConservation(result.day);
  }
});

test('commuter turnback preserves off-campus classification and traveled geometry', () => {
  const base=fixture(); base.agents.find(a=>a.id==='incoming').walkSpeed=2;
  base.stays.find(s=>s.agent==='incoming' && s.location==='home').location='off-campus';
  base.trips.find(t=>t.agent==='incoming').from='off-campus';
  const result=applyIncident(base,incident);
  assert.ok(result.day.stays.some(s=>s.agent==='incoming' && s.location==='off-campus' && s.start===110));
  assertConservation(result.day); assertContinuous(result.day);
});

test('no-dwell inbound visit is canceled when its saved return reaches the origin', () => {
  const base=fixture();base.stays=base.stays.filter(s=>!(s.agent==='incoming' && s.location==='hall'));
  base.trips.push({agent:'incoming',from:'hall',to:'home',path:[[-71,42],[-71.001,42]],timestamps:[120,150]});
  base.stays.push({agent:'incoming',location:'home',start:150,end:DAY});
  const result=applyIncident(base,incident);
  assert.ok(result.day.trips.filter(t=>t.agent==='incoming').every(t=>t.timestamps.at(-1)<=110));
  assertConservation(result.day); assertContinuous(result.day);
});

test('assembly lies on saved path and outside every footprint including unrelated buildings', () => {
  const base=fixture();
  base.buildings=[{id:'hall',height:14,name:null,polygon:[[-71.0001,41.9999],[-70.9995,41.9999],[-70.9995,42.0001],[-71.0001,42.0001]]}];
  const result=applyIncident(base,incident);
  assert.ok(result.assemblyLocation.position[0]>-70.9995);
  assert.equal(result.assemblyLocation.position[1],42);
  assertConservation(result.day);
});

const closure={...incident,kind:'building-closure'};
const blockedStays=(day,agent,from,to)=>day.stays.filter(s=>s.agent===agent && ['hall','dining'].includes(s.location) && s.start<to && s.end>from);

test('closure has no assembly, muster or extension; active activities are interrupted and resumed', () => {
  const original=freeze(fixture());
  const short=applyIncident(original,{...closure,duration:1});
  assert.equal(short.endsAt,short.requestedEndsAt); assertConservation(short.day); assertContinuous(short.day);
  const result=applyIncident(original,closure), {day}=result;
  assert.equal(result.assemblyLocation,null); assert.equal(result.assemblyClearanceMetres,null);
  assert.equal(result.endsAt,result.requestedEndsAt); assert.equal(day.locations,original.locations);
  assert.ok(result.participants.every(p=>p.assemblyAt===null));
  const occupants=result.participants.filter(p=>p.role==='occupant');
  assert.deepEqual(occupants.map(p=>p.outcome),['interrupted','interrupted']);
  for(const p of occupants) {
    assert.equal(p.waitLocationId,'assembly');
    assert.ok(p.departAt>=115 && p.releaseAt>=result.requestedEndsAt);
    assert.equal(blockedStays(day,p.agentId,p.departAt,p.resumedAt).length,0);
    assert.ok(day.stays.some(s=>s.agent===p.agentId && s.location==='assembly' && s.end===p.releaseAt));
  }
  assert.deepEqual(day.trips.find(t=>t.agent==='occupant' && t.to==='home').timestamps,[300,330]);
  assertConservation(day); assertContinuous(day);
});

test('closure occupant whose activity ends during closure leaves early on the saved walk', () => {
  const base=fixture();
  base.stays.find(s=>s.agent==='occupant' && s.location==='hall').end=150;
  base.stays.find(s=>s.agent==='occupant' && s.location==='home').start=180;
  base.trips.find(t=>t.agent==='occupant').timestamps=[150,180];
  const result=applyIncident(base,closure), p=result.participants.find(p=>p.agentId==='occupant');
  assert.equal(p.outcome,'cancelled'); assert.equal(p.assemblyAt,null); assert.equal(p.releaseAt,p.departAt);
  const walk=result.day.trips.filter(t=>t.agent==='occupant');
  assert.equal(walk.length,1); assert.deepEqual(walk[0].path,base.trips.find(t=>t.agent==='occupant').path);
  assert.equal(walk[0].timestamps[0],p.departAt); assert.ok(p.departAt<150);
  assert.equal(p.resumedAt,walk[0].timestamps[1]);
  assert.equal(blockedStays(result.day,'occupant',p.departAt,DAY).length,0);
  // Same schedule under a drill evacuates to the assembly point instead.
  const drill=applyIncident(base,incident);
  assert.equal(drill.participants.find(p=>p.agentId==='occupant').outcome,'evacuated');
  assertConservation(result.day); assertContinuous(result.day);
});

test('closure scheduled departure before the exit slot is kept and does not consume exit flow', () => {
  const base=fixture();
  base.stays.find(s=>s.agent==='occupant' && s.location==='hall').end=101;
  base.stays.find(s=>s.agent==='occupant' && s.location==='home').start=131;
  base.trips.find(t=>t.agent==='occupant').timestamps=[101,131];
  const result=applyIncident(base,closure), p=result.participants.find(p=>p.agentId==='occupant');
  assert.equal(p.outcome,'cancelled'); assert.equal(p.departAt,101);
  assert.deepEqual(result.day.trips.find(t=>t.agent==='occupant').timestamps,[101,131]);
  assertConservation(result.day);
});

test('later repeat visits never re-enter the closed footprint before reopening', () => {
  const base=fixture(), pos=id=>base.locations.find(l=>l.id===id).position;
  base.stays=base.stays.filter(s=>s.agent!=='occupant'); base.trips=base.trips.filter(t=>t.agent!=='occupant');
  base.stays.push({agent:'occupant',location:'hall',start:0,end:150},{agent:'occupant',location:'home',start:180,end:200},
    {agent:'occupant',location:'hall',start:230,end:600},{agent:'occupant',location:'home',start:630,end:DAY});
  const trip=(from,to,start,end)=>({agent:'occupant',from,to,path:[pos(from),pos(to)],timestamps:[start,end]});
  base.trips.push(trip('hall','home',150,180),trip('home','hall',200,230),trip('hall','home',600,630));
  for(const kind of ['building-closure','fire-drill']) {
    const result=applyIncident(base,{...incident,kind,duration:300}), {day}=result;
    const reentry=day.trips.find(t=>t.agent==='occupant' && t.from==='home' && t.to==='hall');
    assert.ok(reentry.timestamps.at(-1)>=result.endsAt,`${kind}: early re-entry`);
    assert.equal(blockedStays(day,'occupant',result.participants.find(p=>p.agentId==='occupant').departAt,result.endsAt).length,0);
    assert.deepEqual(day.trips.find(t=>t.agent==='occupant' && t.timestamps[0]>=600).timestamps,[600,630]);
    assertConservation(day); assertContinuous(day);
  }
});

test('arrival whose visit would expire goes straight to the next activity on a saved route', () => {
  const base=fixture(), pos=id=>base.locations.find(l=>l.id===id).position;
  base.walkRoutes['home>far']={path:[pos('home'),pos('far')],cumulative:[0,200]};
  base.stays=base.stays.filter(s=>s.agent!=='later'); base.trips=base.trips.filter(t=>t.agent!=='later');
  base.stays.push({agent:'later',location:'home',start:0,end:130},{agent:'later',location:'dining',start:160,end:170},{agent:'later',location:'far',start:270,end:DAY});
  base.trips.push({agent:'later',from:'home',to:'dining',path:[pos('home'),pos('dining')],timestamps:[130,160]},
    {agent:'later',from:'dining',to:'far',path:[pos('dining'),pos('far')],timestamps:[170,270]});
  for(const kind of ['building-closure','fire-drill']) {
    const result=applyIncident(base,{...incident,kind}), p=result.participants.find(p=>p.agentId==='later');
    assert.equal(p.role,'arrival'); assert.equal(p.outcome,'cancelled');
    const walks=result.day.trips.filter(t=>t.agent==='later');
    assert.equal(walks.length,1); assert.equal(walks[0].to,'far'); assert.deepEqual(walks[0].path,base.walkRoutes['home>far'].path);
    assert.ok(!result.day.stays.some(s=>s.agent==='later' && s.location==='dining'));
    assertConservation(result.day); assertContinuous(result.day);
  }
});

test('drill return queue applies only to people re-entering for an active activity', () => {
  const base=fixture();
  base.agents.push({id:'third',home:'hall',model:0,walkSpeed:1}); base.stays.push({agent:'third',location:'hall',start:0,end:DAY});
  base.stays.find(s=>s.agent==='occupant' && s.location==='hall').end=150;
  base.stays.find(s=>s.agent==='occupant' && s.location==='home').start=180;
  base.trips.find(t=>t.agent==='occupant').timestamps=[150,180];
  const result=applyIncident(base,incident), release=id=>result.participants.find(p=>p.agentId===id).releaseAt;
  assert.equal(release('occupant'),result.endsAt);
  assert.deepEqual([release('shared'),release('third')].sort((a,b)=>a-b),[result.endsAt,result.endsAt+1]);
  assertConservation(result.day); assertContinuous(result.day);
});

test('empty buildings: both kinds leave the day unchanged; closure adds no location', () => {
  const base=fixture();
  base.walkRoutes['far>assembly']={path:[[-70.998,42],[-70.999,42]],cumulative:[0,50]};
  for(const kind of ['fire-drill','building-closure']) {
    const result=applyIncident(base,{...incident,kind,locationId:'far'});
    assert.equal(result.affectedAgents,0); assert.deepEqual(result.day.trips,base.trips); assert.deepEqual(result.day.stays,base.stays);
    assert.equal(result.day.locations.length,base.locations.length+(kind==='fire-drill'?1:0));
  }
  assert.equal(applyIncident(base,{...closure,locationId:'far'}).assemblyLocation,null);
});

test('closure without any saved walk out rejects instead of inventing a waiting place', () => {
  assert.throws(()=>applyIncident({...fixture(),walkRoutes:{}},closure),/No saved walk route out of the closed building/);
});

test('assembly points closer than the footprint buffer are rejected', () => {
  const base=fixture();
  delete base.walkRoutes['hall>far']; delete base.walkRoutes['dining>far'];
  base.buildings=[{id:'hall',height:14,name:null,polygon:[[-71.0001,41.9999],[-70.99905,41.9999],[-70.99905,42.0001],[-71.0001,42.0001]]}];
  assert.throws(()=>applyIncident(base,incident),/No saved walk route/);
});

test('invalid incidents, off-campus targets and absent routes are rejected', () => {
  for (const duration of [0,-1,NaN,Infinity]) assert.throws(()=>applyIncident(fixture(),{...incident,duration}),/Invalid incident/);
  for (const patch of [{start:-1},{start:NaN},{start:DAY},{kind:'other'},{id:''},{duration:DAY}]) assert.throws(()=>applyIncident(fixture(),{...incident,...patch}),/Invalid incident/);
  const base=fixture(); base.locations.push({...location('off-campus',0),kind:'off-campus'});
  for (const locationId of ['missing','off-campus']) assert.throws(()=>applyIncident(base,{...incident,locationId}),/on-campus/);
  assert.throws(()=>applyIncident({...base,walkRoutes:{}},incident),/No saved walk route/);
  assert.throws(()=>applyIncident(base,{...incident,locationId:'far'}),/No saved walk route/);
});

test('ambiguous, incomplete and disconnected timelines are rejected', () => {
  const changes=[day=>delete day.stays,day=>day.stays.pop(),day=>day.agents.push(day.agents[0]),
    day=>day.stays.push({...day.stays[0]}),day=>day.stays[0].end=299,
    day=>day.trips[0].timestamps=[120,90],day=>day.trips[0].agent='missing',
    day=>{ for(const [key,route] of Object.entries(day.walkRoutes)) if(key.startsWith('hall>')) route.path[0]=[0,0]; },day=>day.agents[0].walkSpeed=0];
  for (const change of changes) { const day=fixture();change(day); assert.throws(()=>applyIncident(day,incident),/Unsupported day timeline|No saved walk route/); }
  assert.ok(INCIDENT_LIMITATIONS.some(text=>text.includes('not a verified safe')));
});

test('recovery skips expired stays, retains physical walks, and catches up to fixed timing', () => {
  const base=fixture();
  base.stays=base.stays.filter(stay=>stay.agent!=='occupant');
  base.trips=base.trips.filter(trip=>trip.agent!=='occupant');
  base.stays.push({agent:'occupant',location:'hall',start:0,end:110},
    {agent:'occupant',location:'home',start:140,end:170},
    {agent:'occupant',location:'far',start:200,end:400},
    {agent:'occupant',location:'home',start:430,end:DAY});
  const trip=(from,to,start,end)=>({agent:'occupant',from,to,path:[base.locations.find(l=>l.id===from).position,base.locations.find(l=>l.id===to).position],timestamps:[start,end]});
  base.trips.push(trip('hall','home',110,140),trip('home','far',170,200),trip('far','home',400,430));
  const {day}=applyIncident(base,incident);
  const walks=day.trips.filter(t=>t.agent==='occupant' && !t.to.startsWith('incident:') && !t.from.startsWith('incident:'));
  assert.ok(walks.some(t=>t.to==='home' && t.timestamps[0]===400));
  assert.ok(!day.stays.some(s=>s.agent==='occupant' && s.location==='home' && s.start<400));
  assert.equal(day.stays.find(s=>s.agent==='occupant' && s.location==='far').end,400);
  assertConservation(day);assertContinuous(day);
});

test('zero-length saved transitions are accepted without admitting arbitrary location jumps', () => {
  const base=fixture();
  base.stays=base.stays.filter(stay=>stay.agent!=='shared');
  base.stays.push({agent:'shared',location:'hall',start:0,end:50},{agent:'shared',location:'dining',start:50,end:DAY});
  assert.throws(()=>applyIncident(base,incident),/disconnected itinerary/);
  base.walkRoutes['hall>dining']={path:[[-71,42],[-71,42]],cumulative:[0,0]};
  const {day}=applyIncident(base,incident);
  assertConservation(day);
});

test('recovery reserves off-map travel time between distinct commuter gateways', () => {
  const base=fixture();
  base.stays=base.stays.filter(stay=>stay.agent!=='occupant');
  base.trips=base.trips.filter(trip=>trip.agent!=='occupant');
  base.stays.push({agent:'occupant',location:'hall',start:0,end:110},
    {agent:'occupant',location:'off-campus',start:140,end:2140},
    {agent:'occupant',location:'home',start:2170,end:DAY});
  base.trips.push({agent:'occupant',from:'hall',to:'off-campus',path:[[-71,42],[-71.01,42]],timestamps:[110,140]},
    {agent:'occupant',from:'off-campus',to:'home',path:[[-71,42],[-71.001,42]],timestamps:[2140,2170]});
  const {day}=applyIncident(base,{...incident,duration:2400});
  const outward=day.trips.find(t=>t.agent==='occupant' && t.to==='off-campus');
  const inward=day.trips.find(t=>t.agent==='occupant' && t.from==='off-campus');
  assert.ok(inward.timestamps[0]-outward.timestamps.at(-1)>800);
  assertConservation(day);
});

test('saved Wednesday population supports every target, with full CDS and shared-footprint continuity checks', async () => {
  const {buildPopulation}=await import('../src/sim/population.ts');
  const {buildSourceDay}=await import('../src/sim/sourceDay.ts');
  const read=name=>JSON.parse(readFileSync(new URL(`../public/data/${name}.json`,import.meta.url),'utf8'));
  const source=read('campus-data');
  const original=buildSourceDay(buildPopulation(read('demo-day'),source,read('population')),source,2);
  const byAgent=day=>{
    const map=new Map(day.agents.map(agent=>[agent.id,[]]));
    for(const stay of day.stays)map.get(stay.agent).push({start:stay.start,end:stay.end,stay});
    for(const trip of day.trips)map.get(trip.agent).push({start:trip.timestamps[0],end:trip.timestamps.at(-1),trip});
    for(const events of map.values())events.sort((a,b)=>a.start-b.start);
    return map;
  };
  const baseline=byAgent(original);
  const originalStays=JSON.stringify(original.stays);
  const originalTrips=JSON.stringify(original.trips);
  const scenarios=[...original.locations.filter(location=>location.kind!=='off-campus').map(location=>[location.id,30*60,'fire-drill']),
    ['questrom',120*60,'building-closure'],['cds',30*60,'building-closure']];
  for(const [locationId,duration,kind] of scenarios) {
    const result=applyIncident(original,{id:`real-${locationId}`,kind,locationId,start:12*3600,duration});
    assert.equal(result.day.agents,original.agents);
    if(kind==='building-closure') {
      assert.equal(result.assemblyLocation,null); assert.equal(result.endsAt,result.requestedEndsAt);
      assert.equal(result.day.locations,original.locations);
      assert.ok(result.participants.every(p=>p.assemblyAt===null));
      assert.ok(result.participants.some(p=>p.outcome==='cancelled') && result.participants.some(p=>p.outcome==='interrupted'),`${locationId}: closure outcomes`);
    } else assert.ok(result.assemblyClearanceMetres>=10,`${locationId}: assembly clearance`);
    const point=result.assemblyLocation?.position;
    if(point) for(const building of original.buildings) {
      let inside=false; const polygon=building.polygon;
      for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
        const a=polygon[i], b=polygon[j];
        if((a[1]>point[1])!==(b[1]>point[1]) && point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
      }
      assert.ok(!inside,`${locationId}: assembly inside ${building.id}`);
    }
    const exits=result.participants.filter(p=>p.role==='occupant' && (kind==='fire-drill' || !baseline.get(p.agentId).some(e=>e.trip && e.start===p.departAt)));
    if(kind==='building-closure') assert.ok(result.participants.every(p=>p.role!=='occupant' || p.departAt>=12*3600));
    for(let i=1;i<exits.length;i++)assert.ok(exits[i].departAt-exits[i-1].departAt>=0.5-1e-7);
    if(locationId!=='cds' && kind!=='building-closure')continue;
    assert.ok(result.affectedAgents>0);
    const target=original.locations.find(l=>l.id===locationId);
    const blocked=new Set(original.locations.filter(l=>l.building===target.building).map(l=>l.id));
    const timelines=byAgent(result.day);
    let changed=0;
    for(const [id,events] of timelines) {
      let time=0;
      let endpoint;
      for(const event of events) {
        assert.ok(Math.abs(event.start-time)<1e-7,`${locationId}: gap or overlap for ${id} at ${time}`);
        time=event.end;
        if(event.trip) {
          if(endpoint && event.trip.from!=='off-campus')assert.deepEqual(event.trip.path[0],endpoint,`${id}: disconnected walk`);
          endpoint=event.trip.path.at(-1);
        } else {
          if(blocked.has(event.stay.location)) { const p=result.participants.find(p=>p.agentId===id); assert.ok(event.end<=(p?.role==='occupant'?p.departAt:43200) || event.start>=result.endsAt,`${id}: blocked occupancy`); }
        }
      }
      assert.ok(time>=DAY,`${id}: incomplete day`);
      if(JSON.stringify(events)!==JSON.stringify(baseline.get(id)))changed++;
      // An occupant already leaving on schedule before its exit slot is counted but keeps its day.
      else assert.ok(result.participants.some(p=>p.agentId===id && p.decision?.reason==='scheduled departure precedes the exit slot') || !result.participants.some(p=>p.agentId===id),`${id}: affected without a change`);
    }
    const natural=result.participants.filter(p=>p.decision?.reason==='scheduled departure precedes the exit slot'
      && JSON.stringify(timelines.get(p.agentId))===JSON.stringify(baseline.get(p.agentId))).length;
    assert.equal(changed+natural,result.affectedAgents);
  }
  assert.equal(JSON.stringify(original.stays),originalStays);
  assert.equal(JSON.stringify(original.trips),originalTrips);
});

test('arrival exactly at start is an occupant; arrival exactly at reopening is unmodified', () => {
  const base=fixture();
  base.trips.find(t=>t.agent==='incoming').timestamps=[70,100];
  base.stays.find(s=>s.agent==='incoming' && s.location==='home').end=70;
  base.stays.find(s=>s.agent==='incoming' && s.location==='hall').start=100;
  const long={...incident,duration:1000};
  base.trips.find(t=>t.agent==='expiry').timestamps=[1070,1100];
  base.stays.find(s=>s.agent==='expiry' && s.location==='home').end=1070;
  base.stays.find(s=>s.agent==='expiry' && s.location==='hall').start=1100;
  for (const kind of ['fire-drill','building-closure']) {
    const result=applyIncident(base,{...long,kind});
    assert.equal(result.participants.find(p=>p.agentId==='incoming').role,'occupant');
    assert.ok(!result.participants.some(p=>p.agentId==='expiry'));
    assertConservation(result.day);
  }
});

test('dense footprint shares finite exit flow and outdoor population remains visible', () => {
  const base=fixture(); base.trips=[]; base.agents=[]; base.stays=[];
  for(let i=0;i<300;i++) {
    const id=`dense-${i}`;base.agents.push({id,home:'hall',model:0,walkSpeed:1});
    base.stays.push({agent:id,location:i%2?'hall':'dining',start:0,end:DAY});
  }
  const result=applyIncident(base,{...incident,duration:1});
  const participants=result.participants;
  for(let i=1;i<participants.length;i++)assert.ok(participants[i].departAt-participants[i-1].departAt>=0.5-1e-7);
  assert.ok(participants.at(-1).departAt-participants[0].departAt>=149.5);
  const playback=new Playback(result.day);
  assert.equal(playback.populationAt(result.endsAt-0.001).outdoors,300);
  assert.equal(playback.outdoorAt(result.endsAt-0.001).length,300);
  assert.ok(playback.populationAt(participants[0].departAt+1).indoors>0);
  assert.ok(playback.populationAt(participants.at(-1).assemblyAt).walking<300);
  assert.equal(new Set(result.day.agents.map(a=>a.id)).size,300);
});

test('every pre-incident position and stay is unchanged, including partial approach geometry', () => {
  const base=fixture();
  for (const kind of ['fire-drill','building-closure']) {
  const result=applyIncident(base,{...incident,kind});
  const before=new Playback(base), after=new Playback(result.day);
  for(const time of [0,50,89,90,95,99.999]) {
    assert.deepEqual(after.populationAt(time),before.populationAt(time));
    const a=after.walkingAt(time), b=before.walkingAt(time);
    assert.equal(a.length,b.length);
    for(let i=0;i<a.length;i++) {
      assert.equal(a[i].id,b[i].id); assert.equal(a[i].to,b[i].to);
      for(let j=0;j<2;j++)assert.ok(Math.abs(a[i].position[j]-b[i].position[j])<1e-10);
    }
  }
  }
});

test('diversion never skips physical transfer between different off-campus gateways', () => {
  const base=fixture();base.agents=base.agents.filter(a=>a.id==='incoming');
  base.stays=[{agent:'incoming',location:'off-campus',start:0,end:90},{agent:'incoming',location:'hall',start:120,end:140},
    {agent:'incoming',location:'off-campus',start:170,end:300},{agent:'incoming',location:'home',start:330,end:DAY}];
  base.trips=[{agent:'incoming',from:'off-campus',to:'hall',path:[[-71.001,42],[-71,42]],timestamps:[90,120]},
    {agent:'incoming',from:'hall',to:'off-campus',path:[[-71,42],[-71.01,42]],timestamps:[140,170]},
    {agent:'incoming',from:'off-campus',to:'home',path:[[-71,42],[-71.001,42]],timestamps:[300,330]}];
  const result=applyIncident(base,{...incident,duration:1000});
  const outward=result.day.trips.find(t=>t.from==='hall');
  const inward=result.day.trips.find(t=>t.to==='home');
  assert.ok(outward);assert.ok(inward.timestamps[0]-outward.timestamps.at(-1)>800);
  assertConservation(result.day);
});


test('canceled same-gateway visit still reserves transfer to a later different gateway', () => {
  const base=fixture();base.agents=base.agents.filter(a=>a.id==='incoming');
  base.stays=[{agent:'incoming',location:'off-campus',start:0,end:90},{agent:'incoming',location:'hall',start:120,end:140},
    {agent:'incoming',location:'off-campus',start:170,end:300},{agent:'incoming',location:'home',start:330,end:DAY}];
  base.trips=[{agent:'incoming',from:'off-campus',to:'hall',path:[[-71.01,42],[-71,42]],timestamps:[90,120]},
    {agent:'incoming',from:'hall',to:'off-campus',path:[[-71,42],[-71.01,42]],timestamps:[140,170]},
    {agent:'incoming',from:'off-campus',to:'home',path:[[-71,42],[-71.001,42]],timestamps:[300,330]}];
  const result=applyIncident(base,incident);
  const inward=result.day.trips.find(t=>t.to==='home');
  assert.ok(inward.timestamps[0]-110>800);
  assertConservation(result.day);
});
