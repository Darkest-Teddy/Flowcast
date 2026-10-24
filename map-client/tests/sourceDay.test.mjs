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
const { buildSourceDay, venueWindows } = await import('../src/sim/sourceDay.ts');
const { Playback } = await import('../src/sim/playback.ts');
const { calibrateCapacities } = await import('../src/sim/calibrate.ts');

test('legacy capacity sizing preserves source/model references and remains playable', () => {
  const warren = {id:'warren',name:'Warren',short:'Warren',kind:'dorm',position:[-71,42],building:'warren',capacity:600,referenceCapacity:600};
  const zero = {...warren,id:'unknown',capacity:0,referenceCapacity:0};
  const day = {day:'Monday',buildings:[],locations:[warren,zero],agents:[],trips:[],stays:[]};
  assert.equal(calibrateCapacities(day),day);
  assert.doesNotThrow(() => new Playback(calibrateCapacities(day)));
  const mixed = calibrateCapacities({...day,locations:[...day.locations,{...warren,id:'demo',referenceCapacity:undefined}]});
  assert.equal(mixed.locations[0],warren);
  assert.equal(mixed.locations[1],zero);
  assert.doesNotThrow(() => new Playback(mixed));
  assert.throws(() => calibrateCapacities({...day,locations:[{...warren,capacity:700}]}),/Capacity differs/);
});

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
  const memberships=day=>[...day.sourceAssignments].sort((a,b)=>a.agentId.localeCompare(b.agentId)||a.startSec-b.startSec||a.meetingId.localeCompare(b.meetingId));
  assert.deepEqual(memberships(days[0]),memberships(days[1]));
  assert.deepEqual(memberships(days[0]),memberships(days[2]));
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
  data.locations.class.meetings=[meeting('one',0,9*3600,10*3600,{sharedKey:'cross',roomCapacity:7}),meeting('two',0,9*3600,10*3600,{sharedKey:'cross',roomCapacity:9}),meeting('unknown',0,11*3600,12*3600,{roomCapacity:null,roomCode:'unknown-room'})];
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

test('merely undated venue hours never permit optional visits',()=>{
  const {base,data}=fixture();data.locations.class.meetings=[];
  base.agents=Array.from({length:100},(_,i)=>({id:`undated${i}`,home:'home',residency:'resident',campus:'main',model:0}));
  const undated=[{date:null,windows:[[0,86400]],text:'Undated',sourceUrl:'source',qualifier:null}];
  data.locations.meal.hours=undated;data.locations.study.hours=undated;data.locations.gym.hours=undated;
  const day=buildSourceDay(base,data,5);validate(day);
  assert.ok(!day.stays.some(s=>['meal','study','gym'].includes(s.location)));
  assert.ok(day.sourceStats.modeledOffCampusMeals>0);
});

test('typical hours require an explicit estimated fallback and never authorize ordinary visits',()=>{
  const {base,data}=fixture();data.locations.class.meetings=[];
  base.agents=Array.from({length:100},(_,i)=>({id:`unknown${i}`,home:'home',residency:'resident',campus:'main',model:0}));
  data.locations.meal.hours=[];data.locations.study.hours=[];data.locations.gym.hours=[];
  assert.deepEqual(venueWindows(data,'meal','dining',5),[]);
  assert.deepEqual(venueWindows(data,'meal','dining',5,{estimatedFallback:true}),[[10*3600,20*3600]]);
  const day=buildSourceDay(base,data,5);validate(day);
  assert.ok(!day.stays.some(s=>['meal','study','gym'].includes(s.location)));
});

test('nearest-week estimated fallback preserves exact-date closures and does not invent undated authority',()=>{
  const {data}=fixture();
  data.locations.meal.hours=[{date:'2026-10-26',windows:[[8*3600,20*3600]],text:'Next Monday',sourceUrl:'source',qualifier:null}];
  assert.deepEqual(venueWindows(data,'meal','dining',0),[]);
  assert.deepEqual(venueWindows(data,'meal','dining',0,{estimatedFallback:true}),[[8*3600,20*3600]]);
  data.locations.meal.hours.push({date:'2026-10-19',windows:[],text:'Closed',sourceUrl:'source',qualifier:null});
  assert.deepEqual(venueWindows(data,'meal','dining',0,{estimatedFallback:true}),[]);
  data.locations.meal.hours=[{date:null,windows:[[0,86400]],text:'Undated',sourceUrl:'source',qualifier:null}];
  assert.deepEqual(venueWindows(data,'meal','dining',0,{estimatedFallback:true}),[]);
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

test('same-building classes permit a mapped resident home break before the location fast path',()=>{
  const {base,data}=fixture();base.agents=[{id:'home-break',home:'home',residency:'resident',campus:'main',model:0}];
  base.stopRoutes={};for(const loc of Object.values(data.locations))loc.hours=[];
  data.locations.class.meetings=[meeting('morning',0,9*3600,10*3600),meeting('evening',0,18*3600,19*3600)];
  const day=buildSourceDay(base,data,0);validate(day);
  assert.ok(day.stays.some(s=>s.location==='home'&&s.start===10*3600+100&&s.end===18*3600-100));
  assert.ok(!day.stays.some(s=>s.location==='class'&&s.end-s.start>3600));
});

test('commuter optional visits stay inside existing class-day anchors without extra campus days',()=>{
  const {base,data}=fixture();base.agents=Array.from({length:100},(_,i)=>({id:`day-commuter-${i}`,home:'off-campus',residency:'commuter',campus:'main',model:0}));
  data.locations.class.meetings=[meeting('morning',0,9*3600,10*3600,{roomCapacity:100}),meeting('evening',0,20*3600,21*3600,{roomCapacity:100})];
  const day=buildSourceDay(base,data,0);validate(day);assert.ok(day.sourceActivities.length>0);
  for(const activity of day.sourceActivities){assert.ok(activity.startSec>=9*3600);assert.ok(activity.endSec<=21*3600);}
  const sunday=buildSourceDay(base,data,6);assert.equal(sunday.sourceActivities.length,0);assert.equal(sunday.trips.length,0);validate(sunday);
});

test('unmapped residents retain their campus and can make physical daily visits without invented dorms',()=>{
  const {base,data}=fixture();data.locations.class.meetings=[];
  base.agents=Array.from({length:100},(_,i)=>({id:`unmapped-resident-${i}`,home:'off-campus',residency:'resident',campus:'main',model:0}));
  const day=buildSourceDay(base,data,5);validate(day);
  assert.ok(day.sourceActivities.some(a=>a.locationId!=='off-campus'));
  assert.ok(day.sourceActivities.some(a=>a.kind==='off-campus-meal'));
  assert.ok(day.trips.some(t=>t.from==='off-campus'));assert.ok(day.trips.some(t=>t.to==='off-campus'));
  assert.ok(day.trips.every(t=>t.from!=='home'&&t.to!=='home'&&t.timestamps.at(-1)>t.timestamps[0]));
  assert.ok(day.agents.every(a=>a.home==='off-campus'&&a.residency==='resident'&&a.campus==='main'));
});

test('unmapped residents leave classrooms immediately before later off-campus meals',()=>{
  const {base,data}=fixture();base.agents=Array.from({length:100},(_,i)=>({id:`meal-exit-${i}`,home:'off-campus',residency:'resident',campus:'main',model:0}));
  data.locations.class.meetings=[meeting('morning',0,9*3600,10*3600,{roomCapacity:100})];
  const day=buildSourceDay(base,data,0);validate(day);let checked=0;
  for(const agent of base.agents){
    const next=day.sourceActivities.filter(a=>a.agentId===agent.id&&a.startSec>=10*3600).sort((a,b)=>a.startSec-b.startSec)[0];
    if(next?.kind!=='off-campus-meal')continue;
    assert.ok(day.trips.some(t=>t.agent===agent.id&&t.from==='class'&&t.to==='off-campus'&&t.timestamps[0]===10*3600));checked++;
  }
  assert.ok(checked>0);
});

test('optional capacity reservations include waits and pre-reserve published classes without trimming attendance',()=>{
  const {base,data}=fixture();base.agents=Array.from({length:200},(_,i)=>({id:`capacity-${i}`,home:'home',residency:'resident',campus:'main',model:0}));
  for(const location of base.locations)if(['dining','library','gym'].includes(location.kind))location.capacity=5;
  data.locations.class.meetings=[];data.locations.study.meetings=[meeting('published-library-class',0,14*3600,19*3600,{roomCapacity:2})];
  const day=buildSourceDay(base,data,0);validate(day);
  assert.equal(day.sourceAssignments.filter(a=>a.meetingId==='published-library-class').length,2);
  assert.ok(day.sourceStats.optionalCapacityRejected>0);
  for(const location of base.locations.filter(l=>['dining','library','gym'].includes(l.kind))){
    const events=day.stays.filter(s=>s.location===location.id).flatMap(s=>[[s.start,1],[s.end,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    let count=0;for(const[,delta]of events){count+=delta;assert.ok(count<=location.capacity,`${location.id}: ${count}`);}
  }
});

test('compatible saved gateways replace an unavailable preferred route instead of causing long classroom waits',()=>{
  const {base,data}=fixture();
  const gateA=[-71.101,42.351],gateB=[-71.102,42.351];
  base.stopRoutes={
    'gateA>class':{path:[gateA,base.locations.find(l=>l.id==='class').position],cumulative:[0,2100]},
    'gateB>class':{path:[gateB,base.locations.find(l=>l.id==='class').position],cumulative:[0,140]},
  };
  base.agents=Array.from({length:100},(_,i)=>({id:`alternative-${i}`,home:'off-campus',residency:'commuter',campus:'main',model:0}));
  for(const source of Object.values(data.locations))source.hours=[];
  data.locations.class.meetings=[meeting('early',0,9*3600,10*3600,{roomCapacity:100}),meeting('late',0,18*3600,19*3600,{roomCapacity:100})];
  const day=buildSourceDay(base,data,0);validate(day);
  assert.equal(day.sourceAssignments.length,200);
  for(const agent of base.agents) {
    assert.ok(day.trips.some(t=>t.agent===agent.id&&t.to==='off-campus'&&t.timestamps[0]===10*3600));
    assert.ok(!day.stays.some(s=>s.agent===agent.id&&s.location==='class'&&s.start===10*3600&&s.end>11*3600));
  }
  for(const trip of day.trips.filter(t=>t.from==='off-campus'))assert.deepEqual(trip.path[0],gateB);
});

test('partially overlapping weekly sections share physical room seats across mapped aliases',()=>{
  const {base,data}=fixture();base.agents=Array.from({length:100},(_,i)=>({id:`room-${i}`,home:'home',residency:'resident',campus:'main',model:0}));
  data.locations.class.meetings=[meeting('first',0,9*3600,10*3600,{buildingCode:'ONE',roomCode:'100',roomCapacity:5,intervals:[0,2].map(weekday=>({weekday,startSec:weekday*86400+9*3600,endSec:weekday*86400+10*3600}))})];
  data.locations.study.meetings=[meeting('second',0,9.5*3600,10.5*3600,{buildingCode:'ONE',roomCode:'100',roomCapacity:5})];
  const monday=buildSourceDay(base,data,0),wednesday=buildSourceDay(base,data,2);validate(monday);validate(wednesday);
  assert.equal(monday.sourceAssignments.length,5);
  assert.ok(monday.sourceStats.roomCapacityLimitedCandidates>0);
  const members=day=>day.sourceAssignments.filter(a=>a.meetingId==='first').map(a=>a.agentId).sort();
  assert.deepEqual(members(monday),members(wednesday));
  assert.ok(monday.sourceAssignments.every(a=>a.startSec===(a.meetingId==='first'?9*3600:9.5*3600)));
});

test('unknown physical room seats use a shared 24-person fallback while distinct rooms remain independent',()=>{
  const {base,data}=fixture();base.agents=Array.from({length:100},(_,i)=>({id:`unknown-room-${i}`,home:'home',residency:'resident',campus:'main',model:0}));
  data.locations.class.meetings=[meeting('one',0,9*3600,10*3600,{buildingCode:'ONE',roomCode:'100',roomCapacity:null}),meeting('two',0,9.5*3600,10.5*3600,{buildingCode:'ONE',roomCode:'100',roomCapacity:null}),meeting('other-room',0,9*3600,10*3600,{buildingCode:'ONE',roomCode:'101',roomCapacity:7})];
  const day=buildSourceDay(base,data,0);validate(day);
  assert.equal(day.sourceAssignments.filter(a=>a.meetingId!=='other-room').length,24);
  assert.equal(day.sourceAssignments.filter(a=>a.meetingId==='other-room').length,7);
});

test('cross-listed graduate/undergraduate sections share one roster and emit eligible aliases',()=>{
  const {base,data}=fixture();base.agents=Array.from({length:20},(_,i)=>({id:`cross-level-${i}`,home:'home',residency:'resident',campus:'main',studentLevel:i<10?'undergraduate':'graduate',model:0}));
  const intervals=[0,2,4].map(weekday=>({weekday,startSec:weekday*86400+9*3600,endSec:weekday*86400+10*3600}));
  data.locations.class.meetings=[meeting('A-graduate',0,9*3600,10*3600,{courseCode:'CAS CS 600',roomCapacity:8,sharedKey:'cross-level',intervals}),meeting('B-undergraduate',0,9*3600,10*3600,{courseCode:'CAS CS 400',roomCapacity:8,sharedKey:'cross-level',intervals})];
  const monday=buildSourceDay(base,data,0),wednesday=buildSourceDay(base,data,2);validate(monday);validate(wednesday);
  assert.equal(monday.sourceAssignments.length,8);
  for(const assignment of monday.sourceAssignments){
    const agent=base.agents.find(a=>a.id===assignment.agentId);
    assert.equal(assignment.courseCode,agent.studentLevel==='undergraduate'?'CAS CS 400':'CAS CS 600');
  }
  const roster=day=>day.sourceAssignments.map(a=>`${a.agentId}:${a.courseCode}`).sort();
  assert.deepEqual(roster(monday),roster(wednesday));
});

test('nondegree offerings remain source data without becoming degree-course enrollment',()=>{
  const {base,data}=fixture();data.locations.class.meetings=[meeting('nondegree',0,9*3600,10*3600,{courseCode:'QST ES 090'}),meeting('exercise',0,11*3600,12*3600,{courseCode:'PDP FT 151'})];
  const day=buildSourceDay(base,data,0);validate(day);
  assert.equal(day.sourceAssignments.length,0);assert.equal(day.sourceStats.excludedNonDegreeSections,2);
  assert.equal(data.locations.class.meetings.length,2);
});

test('stable school affinity concentrates feasible schedules while allowing electives',()=>{
  const {base,data}=fixture();base.agents=Array.from({length:100},(_,i)=>({id:`affinity-${i}`,home:'home',residency:'resident',campus:'main',studentLevel:'undergraduate',attendance:'full-time',model:0}));
  data.locations.class.meetings=['CAS','ENG','QST','COM'].flatMap(school=>Array.from({length:5},(_,i)=>meeting(`${school}-${i}`,0,(9+i*2)*3600,(9+i*2)*3600+1800,{courseCode:`${school} XX ${100+i}`,roomCapacity:1000})));
  const day=buildSourceDay(base,data,0);validate(day);
  for(const agent of base.agents){
    const courses=day.sourceAssignments.filter(a=>a.agentId===agent.id),schools=new Map();
    for(const course of courses){const school=course.courseCode.split(' ')[0];schools.set(school,(schools.get(school)??0)+1);}
    assert.ok(courses.length>=4);assert.ok(schools.size<=2);assert.ok(Math.max(...schools.values())>=courses.length-1);
  }
  assert.ok(day.sourceStats.affinityCourseEnrollments>0);
});

function profile(purpose='academic',extra={}) {
  return {purpose,weekdayWindows:Array.from({length:7},(_,weekday)=>({weekday,windows:[[9*3600,17*3600]]})),durationMinutes:30,attendanceProbability:1,capacity:5,dailyParticipants:20,studentLevel:'any',basis:'configured_scenario_estimate',confidence:'low',note:'Synthetic student participants; no observed attendance',proxy:'Scenario proxy',...extra};
}

test('explicit estimated academic profiles use existing people and remain separate from published enrollment',()=>{
  const {base,data}=fixture();data.locations.class.meetings=[];data.locations.class.hours=[];
  base.locations.find(l=>l.id==='class').estimatedProfile=profile();
  base.agents=Array.from({length:100},(_,i)=>({id:`estimated-${i}`,home:'home',residency:'resident',campus:'main',studentLevel:'undergraduate',model:0}));
  const day=buildSourceDay(base,data,0);validate(day);
  const estimates=day.sourceActivities.filter(a=>a.kind==='estimated');
  assert.ok(estimates.length>0&&estimates.length<=20);assert.equal(day.sourceAssignments.length,0);
  assert.ok(estimates.every(a=>a.estimated&&a.basis==='configured_scenario_estimate'&&a.confidence==='low'&&a.purpose==='academic'));
  assert.equal(day.agents,base.agents);assert.equal(new Set(estimates.map(a=>a.agentId)).size,estimates.length);
  const events=day.stays.filter(s=>s.location==='class').flatMap(s=>[[s.start,1],[s.end,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  let count=0;for(const[,delta]of events){count+=delta;assert.ok(count<=5);}
});

test('estimated purpose-specific restricted activities require profiles and never override known closures',()=>{
  const {base,data}=fixture();data.locations.class.meetings=[];
  base.agents=Array.from({length:100},(_,i)=>({id:`restricted-estimate-${i}`,home:'home',residency:'resident',campus:'main',studentLevel:'undergraduate',model:0}));
  const gym=base.locations.find(l=>l.id==='gym');gym.estimatedProfile=profile('rowing');
  data.locations.gym.hoursStatus='restricted';data.locations.gym.hours=[];
  const monday=buildSourceDay(base,data,0);assert.ok(monday.sourceActivities.some(a=>a.kind==='estimated'&&a.locationId==='gym'));
  assert.ok(!monday.sourceActivities.some(a=>a.kind==='gym'&&a.locationId==='gym'));
  const blocked=fixture();blocked.data.locations.class.meetings=[];
  blocked.base.locations.find(l=>l.id==='class').estimatedProfile=profile('research');
  blocked.data.locations.class.hours=[{date:'2026-10-19',windows:[],text:'Closed',sourceUrl:'source',qualifier:null}];
  assert.equal(buildSourceDay(blocked.base,blocked.data,0).sourceActivities.filter(a=>a.kind==='estimated').length,0);
});

test('all configured estimated buildings receive weekly activity without adding people or fake courses',async()=>{
  const {buildPopulation}=await import('../src/sim/population.ts');
  const read=name=>JSON.parse(readFileSync(new URL(`../public/data/${name}.json`,import.meta.url)));
  const source=read('campus-data'),base=buildPopulation(read('demo-day'),source,read('population'));
  const {eligibleStudentLevels,countsTowardDegreeLoad}=await import('../src/sim/courseEligibility.ts');
  const studentLevels=new Map(base.agents.map(agent=>[agent.id,agent.studentLevel]));
  const expected=base.locations.filter(l=>l.estimatedProfile).map(l=>l.id),seen=new Set();
  const physicalRooms=new Map(),roomForMeeting=new Map();
  for(const location of Object.values(source.locations))for(const meeting of location.meetings){
    if(meeting.calendarRestricted)continue;
    const key=`${meeting.buildingCode??location.buildingCodes[0]??location.id}:${meeting.roomCode.trim().toUpperCase()}`;
    roomForMeeting.set(meeting.id,key);
    if(!physicalRooms.has(key))physicalRooms.set(key,{known:null});
    if(meeting.roomCapacity!==null)physicalRooms.get(key).known=Math.min(physicalRooms.get(key).known??Infinity,meeting.roomCapacity);
  }

  assert.ok(expected.length>0);
  for(let weekday=0;weekday<7;weekday++) {
    const day=buildSourceDay(base,source,weekday);validate(day);
    assert.equal(day.agents.length,36977);
    const roomEvents=new Map();
    for(const assignment of day.sourceAssignments){
      assert.ok(countsTowardDegreeLoad(assignment.courseCode));
      assert.ok(eligibleStudentLevels(assignment.courseCode).includes(studentLevels.get(assignment.agentId)));
      const room=roomForMeeting.get(assignment.meetingId),events=roomEvents.get(room)??[];
      events.push([assignment.startSec,1],[assignment.endSec,-1]);roomEvents.set(room,events);
    }
    for(const[room,events]of roomEvents){
      let present=0;const limit=physicalRooms.get(room).known??24;
      for(const[time,delta]of events.sort((a,b)=>a[0]-b[0]||a[1]-b[1])){present+=delta;assert.ok(present<=limit,`${room} at weekday${weekday} second${time}: ${present}>${limit}`);}
    }

    for(const activity of day.sourceActivities.filter(a=>a.kind==='estimated')) {
      seen.add(activity.locationId);assert.ok(activity.estimated);assert.ok(activity.basis&&activity.note);
      assert.ok(!day.sourceAssignments.some(a=>a.agentId===activity.agentId&&a.locationId===activity.locationId&&a.startSec===activity.startSec));
    }
  }
  for(const id of expected)assert.ok(seen.has(id),`${id} has a weekly estimated activity`);
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

test('dated sections run only on inclusive valid dates within the reference week',()=>{
  const {base,data}=fixture();
  const intervals=[0,2,4].map(weekday=>({weekday,startSec:weekday*86400+9*3600,endSec:weekday*86400+10*3600}));
  data.locations.class.meetings=[
    meeting('active',0,9*3600,10*3600,{intervals,validFrom:'2026-10-21',validTo:'2026-10-23'}),
    meeting('ended',0,11*3600,12*3600,{validTo:'2026-10-18'}),
    meeting('future',0,13*3600,14*3600,{validFrom:'2026-10-26'}),
  ];
  const monday=buildSourceDay(base,data,0), wednesday=buildSourceDay(base,data,2), friday=buildSourceDay(base,data,4);
  assert.equal(monday.sourceAssignments.length,0);
  assert.ok(wednesday.sourceAssignments.length>0);
  assert.deepEqual(wednesday.sourceAssignments,friday.sourceAssignments);
  assert.ok(wednesday.sourceAssignments.every(row=>row.meetingId==='active'));
  for(const day of [monday,wednesday,friday]) validate(day);
});

test('database section keys keep same-label sessions as separate enrollment options',()=>{
  const {base,data}=fixture();
  data.locations.class.meetings=[
    meeting('session1',0,9*3600,10*3600,{courseCode:'CAS MA 123',sourceSectionKey:'UGRD:2268:1:A1'}),
    meeting('session2',0,11*3600,12*3600,{courseCode:'CAS MA 123',sourceSectionKey:'UGRD:2268:2:A1'}),
  ];
  const day=buildSourceDay(base,data,0);
  assert.equal(day.sourceStats.eligibleWeeklySections,2);
  assert.ok(day.sourceAssignments.length>0);
  for(const agent of base.agents) assert.equal(day.sourceAssignments.filter(row=>row.agentId===agent.id).length,1);
  validate(day);
  const publicData=structuredClone(data);
  for(const row of publicData.locations.class.meetings) delete row.sourceSectionKey;
  const publicDay=buildSourceDay(base,publicData,0);
  assert.equal(publicDay.sourceStats.eligibleWeeklySections,1);
  for(const agent of base.agents) assert.equal(publicDay.sourceAssignments.filter(row=>row.agentId===agent.id).length,2);
});

test('Registrar substitute weekday moves attendance without changing class clock time or adding Tuesday classes',()=>{
  const {base,data}=fixture();
  data.term='FALL 2026'; data.referenceWeekStart='2026-10-12';
  data.academicCalendar=JSON.parse(readFileSync(new URL('../../data-pipeline/output/academic_calendar.json',import.meta.url))).calendar;
  data.locations.class.meetings=[
    meeting('monday-class',0,9*3600,10*3600,{courseCode:'CAS MA 123'}),
    meeting('tuesday-class',1,11*3600,12*3600,{courseCode:'CAS MA 124'}),
  ];
  const monday=buildSourceDay(base,data,0),tuesday=buildSourceDay(base,data,1);
  assert.equal(monday.sourceAssignments.length,0);
  assert.ok(tuesday.sourceAssignments.length>0);
  assert.ok(tuesday.sourceAssignments.every(row=>row.meetingId==='monday-class'&&row.startSec===9*3600&&row.endSec===10*3600));
  validate(monday);validate(tuesday);
});

test('FitRec observations drive gym arrival timing while published closure still wins', () => {
  const {base,data}=fixture();
  base.locations.find(row=>row.id==='gym').id='fitrec';
  base.walkRoutes=Object.fromEntries(Object.entries(base.walkRoutes).map(([key,value])=>[key.split('>').map(id=>id==='gym'?'fitrec':id).join('>'),value]));
  data.locations.fitrec={...data.locations.gym,id:'fitrec'};
  delete data.locations.gym;
  data.locations.class.meetings=[];
  base.agents=Array.from({length:100},(_,i)=>({...base.agents[0],id:`fitrec-${i}`}));
  data.fitrecUsage={metric:'visits',observations:[{date:'2026-10-19',hour:10,visits:200}]};
  const day=buildSourceDay(base,data,0);
  const visits=day.sourceActivities.filter(row=>row.locationId==='fitrec');
  assert.ok(visits.length>0);
  assert.ok(visits.every(row=>row.startSec>=10*3600&&row.startSec<11*3600));
  validate(day);
  const closed=structuredClone(data);
  closed.locations.fitrec.hours=[{date:'2026-10-19',windows:[],text:'Closed',sourceUrl:'source',qualifier:null}];
  assert.equal(buildSourceDay(base,closed,0).sourceActivities.filter(row=>row.locationId==='fitrec').length,0);
});
