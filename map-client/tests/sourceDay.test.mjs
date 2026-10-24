import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
const { Playback } = await import('../src/sim/playback.ts');

function location(id, kind, campus = 'main') {
  return { id, name:id, short:id, kind, position:[-71.1,42.35], capacity:100, building:id, campus };
}
function meeting(id, weekday=0, start=9*3600, end=10*3600, extra={}) {
  return { id,courseCode:id,title:id,section:'A1',roomCode:'100',intervals:[{weekday,startSec:weekday*86400+start,endSec:weekday*86400+end}],roomCapacity:20,notes:null,calendarRestricted:false,sharedKey:null,sourceUrl:'https://www.bu.edu/example',...extra };
}
function fixture() {
  const locations = [location('home','dorm'),location('class','classroom'),location('meal','dining'),location('study','library'),location('gym','gym')];
  locations.forEach((location,index)=>{location.position=[-71.1-index*0.001,42.35];});
  const walkRoutes = {};
  for (const from of locations) for (const to of locations) {
    if (from.id!==to.id) walkRoutes[`${from.id}>${to.id}`]={path:[from.position,to.position],cumulative:[0,140]};
  }
  const base={day:'Wednesday',locations,buildings:[],agents:Array.from({length:10},(_,i)=>({id:`a${i}`,home:'home',model:i%12,campus:'main'})),walkRoutes,trips:[]};
  const data={schemaVersion:1,term:'FALL 2026',collectedAt:'2026-10-24',referenceWeekStart:'2026-10-19',coverage:{},locations:{},events:[],libraryHistory:{},signals:[],assumptions:[],inputFiles:[]};
  for (const loc of locations) data.locations[loc.id]={id:loc.id,buildingCodes:[],meetings:[],evidence:[],hours:[]};
  data.locations.class.meetings=[meeting('A'),meeting('B',0,11*3600,12*3600),meeting('C',2,10*3600,11*3600)];
  return {base,data};
}
function validate(day) {
  assert.equal(day.sourceStats.unroutableTrips,0);
  for (const agent of day.agents) {
    const trips=day.trips.filter(t=>t.agent===agent.id);
    let where=agent.home, freeAt=0;
    for (const trip of trips) {
      assert.equal(trip.from,where);
      assert.ok(trip.timestamps[0]>=freeAt-1e-8);
      assert.ok(trip.timestamps[0]>=0);
      assert.ok(trip.timestamps.at(-1)<=86400);
      assert.equal(trip.timestamps.length,trip.path.length);
      assert.equal(trip.timestamps.at(-1)-trip.timestamps[0],(trip.path.length-1)*100);
      where=trip.to;freeAt=trip.timestamps.at(-1);
    }
    assert.equal(where,agent.home);
  }
}

test('published anchors drive fixed-time arrivals and preserve cohort/population',()=>{
  const {base,data}=fixture();const day=buildSourceDay(base,data,0);
  assert.equal(day.agents,base.agents);assert.equal(day.sourceStats.assignedClasses,20);
  assert.equal(day.sourceAssignments.length,20);
  for (const assignment of day.sourceAssignments) {
    const arrival=day.trips.find(t=>t.agent===assignment.agentId&&t.to===assignment.locationId&&Math.abs(t.timestamps.at(-1)-assignment.startSec)<1e-8);
    assert.ok(arrival);
  }
  validate(day);
});

test('day choice is deterministic and differs by source weekday',()=>{
  const {base,data}=fixture();
  const monday=buildSourceDay(base,data,0),wednesday=buildSourceDay(base,data,2),sunday=buildSourceDay(base,data,6);
  assert.deepEqual(buildSourceDay(base,data,0),monday);
  assert.ok(wednesday.sourceAssignments.every(a=>a.courseCode==='C'));
  assert.equal(sunday.sourceStats.assignedClasses,0);
  assert.ok(sunday.trips.length>0);
  validate(sunday);
});

test('restricted and shared candidates cannot inflate schedule choices',()=>{
  const {base,data}=fixture();
  data.locations.class.meetings=[meeting('restricted',0,9*3600,10*3600,{calendarRestricted:true}),meeting('one',0,10*3600,11*3600,{sharedKey:'same-room-time'}),meeting('two',0,10*3600,11*3600,{sharedKey:'same-room-time'})];
  const day=buildSourceDay(base,data,0);
  assert.equal(day.sourceStats.skippedCalendar,1);assert.equal(day.sourceStats.sharedCandidatesSuppressed,1);
  assert.equal(day.sourceStats.eligibleMeetings,1);
  assert.ok(day.sourceAssignments.every(a=>a.courseCode==='one'));
});

test('date-specific closure blocks a visit; undated snapshots do not masquerade as current hours',()=>{
  const {base,data}=fixture();
  data.locations.study.hours=[{date:'2026-10-19',windows:[],text:'Closed',sourceUrl:'source',qualifier:null}];
  data.locations.meal.hours=[{date:null,windows:[],text:'Unknown service date',sourceUrl:'source',qualifier:'snapshot'}];
  const day=buildSourceDay(base,data,0);
  assert.ok(!day.trips.some(t=>t.to==='study'));
  assert.ok(day.trips.some(t=>t.to==='meal'));
});

test('unreachable locations never create straight-line fallback trips',()=>{
  const {base,data}=fixture();
  for (const key of Object.keys(base.walkRoutes)) if (key.endsWith('>class')) delete base.walkRoutes[key];
  const day=buildSourceDay(base,data,0);
  assert.equal(day.sourceStats.assignedClasses,0);assert.ok(day.sourceStats.unroutableCandidates>0);
  assert.ok(!day.trips.some(t=>t.to==='class'));validate(day);
});

test('agents without classes and without routes remain at home with no synthetic class fallback',()=>{
  const {base,data}=fixture();base.walkRoutes={};data.locations.class.meetings=[];
  const day=buildSourceDay(base,data,1);
  assert.equal(day.agents.length,10);assert.equal(day.trips.length,0);assert.equal(day.sourceStats.assignedClasses,0);
});


test('missing direct routes compose existing continuous network legs without intermediate arrivals',()=>{
  const {base,data}=fixture();delete base.walkRoutes['home>class'];
  const day=buildSourceDay(base,data,0);
  assert.ok(day.sourceStats.composedRoutes>0);assert.ok(day.sourceStats.composedTrips>0);
  assert.equal(day.sourceStats.assignedClasses,20);
  assert.ok(day.trips.some(t=>t.from==='home'&&t.to==='class'&&t.path.length===3));
  validate(day);
});

test('discontinuous route endpoints are rejected rather than bridged by a new straight line',()=>{
  const {base,data}=fixture();
  for (const key of Object.keys(base.walkRoutes)) if (key.endsWith('>class')) base.walkRoutes[key].path[1]=[-72,42.35];
  const day=buildSourceDay(base,data,0);
  assert.ok(day.sourceStats.invalidRoutes>0);
  assert.equal(day.sourceStats.assignedClasses,0);
});

test('one meeting cannot acquire a whole campus cohort and unknown seats use a conservative model limit',()=>{
  const {base,data}=fixture();base.agents=Array.from({length:100},(_,i)=>({id:`student-${i}`,home:'home',model:i%12,campus:'main'}));
  data.locations.class.meetings=[meeting('small',0,9*3600,10*3600,{roomCapacity:7})];
  const known=buildSourceDay(base,data,0);assert.equal(known.sourceStats.assignedClasses,7);assert.equal(known.sourceStats.scheduledStudents,7);
  assert.ok(known.sourceStats.capacityLimitedCandidates>0);
  data.locations.class.meetings=[meeting('unknown',0,9*3600,10*3600,{roomCapacity:null})];
  const unknown=buildSourceDay(base,data,0);assert.equal(unknown.sourceStats.assignedClasses,24);
  assert.deepEqual(buildSourceDay(base,data,0).sourceAssignments,unknown.sourceAssignments);
});


test('Playback counts agents with no trips at home and keeps the full-day range valid',()=>{
  const {base,data}=fixture();base.walkRoutes={};data.locations.class.meetings=[];
  const day=buildSourceDay(base,data,6),playback=new Playback(day);
  assert.equal(playback.occupancyAt(12*3600).reduce((sum,row)=>sum+row.count,0),base.agents.length);
  assert.equal(playback.walkingAt(12*3600).length,0);
  assert.ok(Number.isFinite(playback.startTime));assert.ok(Number.isFinite(playback.endTime));
});

test('co-located places sum their building population rather than discard a quieter location',()=>{
  const {base}=fixture();base.locations[1].building='shared';base.locations[2].building='shared';
  base.agents=[{id:'one',home:'class',model:0,campus:'main'},{id:'two',home:'meal',model:1,campus:'main'}];
  const playback=new Playback(base),rows=playback.byBuilding(playback.occupancyAt(0));
  assert.equal(rows.find(row=>row.id==='shared').count,2);
});

test('saved campus bundle conserves all1200 students and valid routes throughout the week',()=>{
  const base=JSON.parse(readFileSync(new URL('../public/data/demo-day.json',import.meta.url),'utf8'));
  const data=JSON.parse(readFileSync(new URL('../public/data/campus-data.json',import.meta.url),'utf8'));
  const meetings=new Map(Object.values(data.locations).flatMap(location=>location.meetings).map(meeting=>[meeting.id,meeting]));
  const edges=new Set();
  for(const route of Object.values(base.walkRoutes))for(let i=1;i<route.path.length;i++)edges.add(JSON.stringify([route.path[i-1],route.path[i]]));
  for(let weekday=0;weekday<7;weekday++){
    const day=buildSourceDay(base,data,weekday),playback=new Playback(day),byAgent=new Map(),attendance=new Map();
    assert.equal(day.agents.length,1200);assert.equal(day.sourceStats.unroutableTrips,0);assert.equal(day.sourceStats.invalidRoutes,0);
    for(const trip of day.trips){
      const rows=byAgent.get(trip.agent)??[];rows.push(trip);byAgent.set(trip.agent,rows);
      for(let i=1;i<trip.path.length;i++)assert.ok(edges.has(JSON.stringify([trip.path[i-1],trip.path[i]])),'movement edge must already exist in the bundled network');
    }
    for(const agent of day.agents){let where=agent.home,freeAt=0;for(const trip of byAgent.get(agent.id)??[]){assert.equal(trip.from,where);assert.ok(trip.timestamps[0]>=freeAt-1e-7);assert.ok(trip.timestamps.at(-1)<=86400);where=trip.to;freeAt=trip.timestamps.at(-1);}assert.equal(where,agent.home);}
    for(const assignment of day.sourceAssignments){
      const key=assignment.meetingId+':'+assignment.startSec;attendance.set(key,(attendance.get(key)??0)+1);
      const meeting=meetings.get(assignment.meetingId);const seats=meeting.roomCapacity===null?24:Math.floor(meeting.roomCapacity);
      assert.ok(attendance.get(key)<=seats,'synthetic attendance cannot exceed its explicit seat upper bound');
    }
    for(const time of [0,9*3600,12*3600,18*3600,86399]){
      const occupancy=playback.occupancyAt(time),inside=occupancy.reduce((sum,row)=>sum+row.count,0);
      assert.equal(inside+playback.walkingAt(time).length,1200);
      assert.equal(playback.byBuilding(occupancy).reduce((sum,row)=>sum+row.count,0),inside);
    }
  }
});
