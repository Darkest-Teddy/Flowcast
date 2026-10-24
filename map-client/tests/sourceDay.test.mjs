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
  const base={stopRoutes:{'gate>class':walkRoutes['home>class']},day:'Wednesday',locations,buildings:[],agents:Array.from({length:10},(_,i)=>({id:`a${i}`,home:'home',model:i%12,campus:'main'})),walkRoutes,trips:[]};
  const data={schemaVersion:1,term:'FALL 2026',collectedAt:'2026-10-24',referenceWeekStart:'2026-10-19',coverage:{},locations:{},events:[],libraryHistory:{},signals:[],assumptions:[],inputFiles:[]};
  for (const loc of locations) data.locations[loc.id]={id:loc.id,buildingCodes:[],meetings:[],evidence:[],hours:['dining','library','gym'].includes(loc.kind)?Array.from({length:7},(_,weekday)=>({date:null,weekday,windows:[[7*3600,23*3600]],text:'Published weekly schedule',sourceUrl:'source',qualifier:null})):[]};
  data.locations.class.meetings=[meeting('A'),meeting('B',0,11*3600,12*3600),meeting('C',2,10*3600,11*3600)];
  return {base,data};
}
function validate(day) {
  const segments = new Map(day.agents.map(a => [a.id, []]));
  for (const stay of day.stays) segments.get(stay.agent).push({start:stay.start,end:stay.end,from:stay.location,to:stay.location});
  for (const trip of day.trips) segments.get(trip.agent).push({start:trip.timestamps[0],end:trip.timestamps.at(-1),from:trip.from,to:trip.to});
  for (const agent of day.agents) {
    const parts=segments.get(agent.id).sort((a,b)=>a.start-b.start||a.end-b.end);
    assert.equal(parts[0].start,0); assert.equal(parts.at(-1).end,86400);
    assert.equal(parts[0].from,agent.home); assert.equal(parts.at(-1).to,agent.home);
    for(let i=1;i<parts.length;i++) {
      assert.ok(Math.abs(parts[i].start-parts[i-1].end)<1e-7,'no overlap or uncovered time');
      const entering=parts[i-1].to==='off-campus'||parts[i].from==='off-campus';
      if(!entering) assert.equal(parts[i-1].to,parts[i].from,'continuous network movement');
    }
  }
}

test('weekly section enrollment repeats every published day and caches results',()=>{
  const {base,data}=fixture();
  data.locations.class.meetings=[meeting('MWF',0,9*3600,10*3600,{intervals:[0,2,4].map(weekday=>({weekday,startSec:weekday*86400+9*3600,endSec:weekday*86400+10*3600}))})];
  const days=[0,2,4].map(d=>buildSourceDay(base,data,d));
  assert.deepEqual(days[0].sourceAssignments.map(a=>a.agentId),days[1].sourceAssignments.map(a=>a.agentId));
  assert.deepEqual(days[0].sourceAssignments,days[2].sourceAssignments);
  assert.equal(buildSourceDay(base,data,0),days[0]);
  for(const day of days) validate(day);
  assert.ok(buildSourceDay(base,data,6).trips.length>0);
  assert.equal(buildSourceDay(base,data,6).sourceAssignments.length,0);
});

test('section admission requires full-week travel feasibility',()=>{
  const {base,data}=fixture();
  data.locations.class.meetings=[meeting('first',0,9*3600,10*3600,{intervals:[0,2].map(weekday=>({weekday,startSec:weekday*86400+9*3600,endSec:weekday*86400+10*3600}))})];
  data.locations.study.meetings=[meeting('second',0,11*3600,12*3600,{intervals:[{weekday:0,startSec:11*3600,endSec:12*3600},{weekday:2,startSec:2*86400+10*3600,endSec:2*86400+11*3600}]})];
  const monday=buildSourceDay(base,data,0);
  for(const agent of base.agents) assert.equal(monday.sourceAssignments.filter(a=>a.agentId===agent.id).length,1);
  validate(monday);validate(buildSourceDay(base,data,2));
});

test('shared cross-listed seats and unknown room fallback cap weekly membership',()=>{
  const {base,data}=fixture();base.agents=Array.from({length:100},(_,i)=>({id:`cap${i}`,home:'home',model:0,campus:'main'}));
  data.locations.class.meetings=[meeting('one',0,9*3600,10*3600,{sharedKey:'cross',roomCapacity:7}),meeting('two',0,9*3600,10*3600,{sharedKey:'cross',roomCapacity:9}),meeting('unknown',0,11*3600,12*3600,{roomCapacity:null})];
  const day=buildSourceDay(base,data,0);
  assert.equal(day.sourceAssignments.filter(a=>a.meetingId==='one'||a.meetingId==='two').length,7);
  assert.equal(day.sourceAssignments.filter(a=>a.meetingId==='unknown').length,24);
  validate(day);
});

test('commuters walk saved gateway access paths without fabricated off-map commute or dorm returns',()=>{
  const {base,data}=fixture();base.agents=[{id:'commuter',home:'off-campus',residency:'commuter',campus:'main',model:0,walkSpeed:1.1}];
  data.locations.study.meetings=[meeting('later',0,13*3600,14*3600)];
  const day=buildSourceDay(base,data,0);validate(day);
  assert.ok(day.sourceAssignments.length>=2);
  assert.ok(day.trips.some(t=>t.from==='off-campus'));
  assert.ok(day.trips.some(t=>t.to==='off-campus'));
  assert.ok(day.trips.every(t=>t.to!=='home'));
  assert.ok(day.sourceStats.campusAccessTrips>=2);
  const access=day.trips.find(t=>t.from==='off-campus');
  assert.deepEqual(access.path[0],base.stopRoutes['gate>class'].path[0]);
  const lead=Math.min(...day.sourceAssignments.map(a=>a.startSec))-access.timestamps.at(-1);
  assert.ok(lead>=120&&lead<=720);
  assert.ok(day.trips.every(t=>t.timestamps.at(-1)-t.timestamps[0]>=0));
  assert.equal(day.stays[0].location,'off-campus');assert.equal(day.stays.at(-1).location,'off-campus');
  assert.ok(day.stays[0].end<Math.min(...day.sourceAssignments.map(a=>a.startSec)));
  assert.ok(day.stays.at(-1).start>Math.max(...day.sourceAssignments.map(a=>a.endSec)));
});

test('campus gateway detours beyond the declared 2km limit cannot create assignments',()=>{
  const {base,data}=fixture();base.agents=[{id:'remote-gate',home:'off-campus',residency:'commuter',campus:'main',model:0}];
  base.stopRoutes={'gate>class':{...base.stopRoutes['gate>class'],cumulative:[0,2100]}};
  const day=buildSourceDay(base,data,0);assert.equal(day.sourceAssignments.length,0);assert.equal(day.trips.length,0);validate(day);
});

test('residents return home in sufficient gaps and use their stable walking speed',()=>{
  const {base,data}=fixture();base.agents=[{id:'resident',home:'home',residency:'resident',campus:'main',model:0,walkSpeed:1.6}];
  const day=buildSourceDay(base,data,0);validate(day);
  assert.equal(day.trips[0].timestamps.at(-1)-day.trips[0].timestamps[0],140/1.6);
  assert.ok(day.stays.filter(s=>s.location==='home').length>=3);
  assert.ok(day.sourceAssignments.every(a=>a.locationId==='class'));
});

test('network composition retains original endpoints; absent routes and date closures prevent admission',()=>{
  const {base,data}=fixture();delete base.walkRoutes['home>class'];
  const day=buildSourceDay(base,data,0);assert.ok(day.sourceStats.composedTrips>0);validate(day);
  assert.ok(day.trips.some(t=>t.from==='home'&&t.to==='class'&&t.path.length===3));
  const blocked=fixture();blocked.data.locations.class.hours=[{date:'2026-10-21',windows:[],text:'Closed',sourceUrl:'source',qualifier:null}];
  blocked.data.locations.class.meetings=[meeting('MW',0,9*3600,10*3600,{intervals:[0,2].map(weekday=>({weekday,startSec:weekday*86400+9*3600,endSec:weekday*86400+10*3600}))})];
  assert.ok(buildSourceDay(blocked.base,blocked.data,0).sourceAssignments.length>0,'published class times remain authoritative despite public building closure');
  const unreachable=fixture();unreachable.base.walkRoutes={};assert.equal(buildSourceDay(unreachable.base,unreachable.data,0).trips.length,0);
});

test('restricted meetings excluded and zero-class residents and commuters have complete home stays',()=>{
  const {base,data}=fixture();data.locations.class.meetings=[meeting('restricted',0,9*3600,10*3600,{calendarRestricted:true})];
  base.agents.push({id:'off',home:'off-campus',campus:'main',residency:'commuter',model:0});
  base.walkRoutes={};base.stopRoutes={};
  const day=buildSourceDay(base,data,0);assert.equal(day.trips.length,0);assert.equal(day.stays.length,base.agents.length);validate(day);
  assert.equal(day.sourceStats.unassignedStudents,base.agents.length);
});

test('part-time and full-time undergraduate/graduate course loads respect modeled limits',()=>{
  const {base,data}=fixture();
  base.agents=Array.from({length:90},(_,i)=>({id:`load-${i}`,home:'home',model:0,campus:'main',attendance:i<30?'part-time':'full-time',studentLevel:i>=30&&i<60?'graduate':'undergraduate'}));
  data.locations.class.meetings=Array.from({length:7},(_,i)=>meeting(`course-${i}`,0,(8+i)*3600,(8+i)*3600+1800,{roomCapacity:100}));
  const day=buildSourceDay(base,data,0);
  for(const agent of base.agents) {
    const count=day.sourceAssignments.filter(a=>a.agentId===agent.id).length;
    const minimum=agent.attendance==='part-time'?1:agent.studentLevel==='graduate'?3:4;
    assert.ok(count>=minimum&&count<=minimum+1,`${agent.id}: ${count} courses`);
  }
});

test('weekend resident trips are deterministic, probability-bounded and respect exact-date/weekly dining windows',()=>{
  const {base,data}=fixture();data.locations.class.meetings=[];
  base.agents=Array.from({length:100},(_,i)=>({id:`weekend${i}`,home:'home',residency:'resident',campus:'main',model:0}));
  data.locations.meal.hours=[{date:null,weekday:5,windows:[[11*3600,21*3600]],text:'Published Saturday service window',sourceUrl:'source',qualifier:null}];
  data.locations.study.hours=[{date:'2026-10-24',windows:[],text:'Closed',sourceUrl:'source',qualifier:null}];
  const day=buildSourceDay(base,data,5);validate(day);
  assert.equal(day.sourceAssignments.length,0);assert.ok(day.sourceStats.modeledActivities>0);
  assert.ok(day.trips.length>100);assert.ok(day.trips.length<100*10);
  assert.ok(!day.trips.some(t=>t.to==='study'));
  assert.ok(day.trips.some(t=>t.to==='meal'));
  for(const stay of day.stays.filter(s=>s.location==='meal')) assert.ok(stay.start>=11*3600&&stay.end<=21*3600);
  const playback=new Playback(day);
  assert.ok(Array.from({length:840},(_,i)=>playback.walkingAt(8*3600+i*60).length).some(n=>n>0));
  assert.equal(buildSourceDay(base,data,5),day);
});

test('unknown and merely undated venue hours never permit optional gym, study or dining visits',()=>{
  const {base,data}=fixture();data.locations.class.meetings=[];
  base.agents=Array.from({length:100},(_,i)=>({id:`unknown${i}`,home:'home',residency:'resident',campus:'main',model:0}));
  data.locations.meal.hours=[{date:null,windows:[[0,86400]],text:'Undated',sourceUrl:'source',qualifier:null}];
  data.locations.study.hours=[];data.locations.gym.hours=[];
  const day=buildSourceDay(base,data,5);validate(day);
  assert.ok(!day.stays.some(s=>['meal','study','gym'].includes(s.location)));
  assert.ok(day.sourceStats.modeledOffCampusMeals>0);
  assert.ok(day.trips.every(t=>t.from==='off-campus'||t.to==='off-campus'));
});

test('exact-date closures override valid weekly openings and expired weekly schedules stay unavailable',()=>{
  const {base,data}=fixture();data.locations.class.meetings=[];
  base.agents=Array.from({length:100},(_,i)=>({id:`closed${i}`,home:'home',residency:'resident',campus:'main',model:0}));
  data.locations.meal.hours=[{date:null,weekday:5,windows:[[0,86400]],text:'Weekly open',sourceUrl:'source',qualifier:null},{date:'2026-10-24',windows:[],text:'Closed',sourceUrl:'source',qualifier:null}];
  data.locations.study.hours=[{date:null,weekday:5,validTo:'2026-10-23',windows:[[0,86400]],text:'Expired',sourceUrl:'source',qualifier:null}];
  data.locations.gym.hours=[{date:null,weekday:5,validFrom:'2026-10-25',windows:[[0,86400]],text:'Future',sourceUrl:'source',qualifier:null}];
  const day=buildSourceDay(base,data,5);validate(day);
  assert.ok(!day.stays.some(s=>['meal','study','gym'].includes(s.location)));
});

test('modeled off-campus meals conserve population, walk both gateway directions and preserve class membership',()=>{
  const {base,data}=fixture();base.agents=Array.from({length:100},(_,i)=>({id:`outside${i}`,home:'home',residency:'resident',campus:'main',model:0}));
  const day=buildSourceDay(base,data,0);validate(day);
  assert.ok(day.sourceStats.modeledOffCampusMeals>0);
  for(const agent of base.agents) {
    const offStays=day.stays.filter(s=>s.agent===agent.id&&s.location==='off-campus');
    for(const stay of offStays) {
      assert.ok(day.trips.some(t=>t.agent===agent.id&&t.to==='off-campus'&&t.timestamps.at(-1)<=stay.start+1e-7));
      assert.ok(day.trips.some(t=>t.agent===agent.id&&t.from==='off-campus'&&t.timestamps[0]>=stay.end));
    }
  }
  const playback=new Playback(day);
  for(let hour=0;hour<24;hour++) { const n=playback.populationAt(hour*3600);assert.equal(n.indoors+n.walking+n.offCampus,100);assert.ok(n.offCampus>=0); }
  assert.ok(day.sourceAssignments.length>0);
});

test('residents return home after off-campus meals during long gaps and optional arrivals never precede planned opening',()=>{
  const {base,data}=fixture();data.locations.class.meetings=[];
  base.agents=Array.from({length:200},(_,i)=>({id:`return${i}`,home:'home',residency:'resident',campus:'main',model:0}));
  const day=buildSourceDay(base,data,5);validate(day);
  let checkedReturns=0;
  for(const activity of day.sourceActivities.filter(a=>a.kind==='off-campus-meal')) {
    const later=day.sourceActivities.filter(a=>a.agentId===activity.agentId&&a.startSec>activity.endSec).sort((a,b)=>a.startSec-b.startSec)[0];
    if(!later||later.startSec-activity.endSec>3600) {
      const homeReturn=day.trips.find(t=>t.agent===activity.agentId&&t.from==='off-campus'&&t.to==='home'&&Math.abs(t.timestamps[0]-activity.endSec)<1e-7);
      assert.ok(homeReturn,'long gap returns resident home immediately after meal');checkedReturns++;
    }
  }
  assert.ok(checkedReturns>0);
  for(const activity of day.sourceActivities.filter(a=>a.locationId!=='off-campus')) {
    for(const trip of day.trips.filter(t=>t.agent===activity.agentId&&t.from==='off-campus'&&t.to===activity.locationId)) {
      if(trip.timestamps.at(-1)<=activity.startSec&&trip.timestamps.at(-1)>activity.startSec-720)
        assert.ok(Math.abs(trip.timestamps.at(-1)-activity.startSec)<1e-7,'optional gateway arrival has no class lead');
    }
  }
});

test('saved source bundle scales to 36977 weekly students and conserves complete day timelines',()=>{
  const base=JSON.parse(readFileSync(new URL('../public/data/demo-day.json',import.meta.url)));
  const data=JSON.parse(readFileSync(new URL('../public/data/campus-data.json',import.meta.url)));
  const homes=base.agents;
  base.agents=Array.from({length:36977},(_,i)=>({...homes[i%homes.length],id:`scaled-${i}`,home:i<10048?homes[i%homes.length].home:'off-campus',residency:i<10048?'resident':'commuter',walkSpeed:1.1+(i%51)/100}));
  base.trips=[];
  const started=performance.now(); const monday=buildSourceDay(base,data,0);
  console.log(`36977 students: weekly plan + Monday ${(performance.now()-started).toFixed(0)}ms; ${monday.sourceStats.weeklyEnrollments} weekly enrollments; ${monday.sourceStats.weeklyEnrolledStudents} covered students`);
  for(let weekday=0;weekday<7;weekday++) {
    const day=buildSourceDay(base,data,weekday);validate(day);
    const counts=new Map();
    for(const assignment of day.sourceAssignments) counts.set(assignment.meetingId,(counts.get(assignment.meetingId)??0)+1);
    const meetings=new Map(Object.values(data.locations).flatMap(l=>l.meetings.map(m=>[m.id,m])));
    for(const [id,count] of counts) assert.ok(count<=(meetings.get(id).roomCapacity??24));
    assert.equal(day.sourceStats.unroutableTrips,0);assert.equal(day.sourceStats.invalidRoutes,0);
  }
});
