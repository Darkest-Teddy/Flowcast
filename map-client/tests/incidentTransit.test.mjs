import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (error) {
  if (s.startsWith('.') && !/\.[a-z]+$/i.test(s)) return next(`${s}.ts`, c); throw error;
} } });
const { applyIncident } = await import('../src/sim/incidents.ts');
const { Playback } = await import('../src/sim/playback.ts');
const gate = [-71.001,42], hall = [-71,42], outside = [-70.999,42];
const scenario = { id:'transit-drill', kind:'fire-drill', locationId:'hall', start:100, duration:300 };
function fixture() {
  return { day:'Monday', buildings:[],
    locations:[{id:'hall',name:'Hall',short:'Hall',kind:'classroom',position:hall,capacity:100,building:'hall'},
      {id:'other',name:'Other',short:'Other',kind:'library',position:outside,capacity:100,building:'other'}],
    agents:[{id:'rider',home:'off-campus',model:0,walkSpeed:1}],
    walkRoutes:{'hall>other':{path:[hall,outside],cumulative:[0,100]}},
    trips:[{agent:'rider',from:'off-campus',to:'hall',path:[gate,hall],timestamps:[70,90]},
      {agent:'rider',from:'hall',to:'off-campus',path:[hall,gate],timestamps:[300,330]}],
    stays:[{agent:'rider',location:'off-campus',start:0,end:70},{agent:'rider',location:'hall',start:90,end:300},
      {agent:'rider',location:'off-campus',start:330,end:86400}],
    transitRides:[{agent:'rider',kind:'alight',trip:'inbound',route:'route',direction:0,stop:'stop',time:40,position:gate},
      {agent:'rider',kind:'board',trip:'outbound',route:'route',direction:1,stop:'stop',time:335,waitStart:330,position:gate}] };
}

test('an incident removes a missed departure without changing the prior ride', () => {
  const base=fixture(), saved=JSON.stringify(base), result=applyIncident(base,scenario);
  assert.deepEqual(result.day.transitRides.filter(ride=>ride.cancelledAt===undefined),[base.transitRides[0]]);
  const playback=new Playback(result.day);
  assert.equal(playback.studentsAboard('outbound',500),0);
  assert.deepEqual(playback.waitingAt(331),[]);
  assert.equal(JSON.stringify(base),saved);
});

test('leaving early updates the stop wait for a still-reachable published departure', () => {
  const base=fixture(), result=applyIncident(base,{...scenario,kind:'building-closure',duration:1000});
  const board=result.day.transitRides.find(ride=>ride.kind==='board');
  const walk=result.day.trips.find(trip=>trip.to==='off-campus');
  assert.ok(board);
  assert.equal(board.time,335);
  assert.equal(board.waitStart,walk.timestamps.at(-1));
  assert.ok(board.waitStart<330);
  const playback=new Playback(result.day);
  assert.deepEqual(playback.waitingAt(board.waitStart).map(r=>r.id),['rider']);
  assert.equal(playback.studentsAboard('outbound',335),1);
});

test('a diverted future approach drops its now-unmatched alighting', () => {
  const base=fixture();
  base.agents.push({id:'incoming',home:'off-campus',model:0,walkSpeed:1});
  base.trips.push({agent:'incoming',from:'off-campus',to:'hall',path:[gate,hall],timestamps:[170,200]});
  base.stays.push({agent:'incoming',location:'off-campus',start:0,end:170},
    {agent:'incoming',location:'hall',start:200,end:86400});
  base.transitRides.push({...base.transitRides[0],agent:'incoming',trip:'later',time:140});
  const result=applyIncident(base,scenario);
  assert.ok(result.participants.some(p=>p.agentId==='incoming'));
  assert.equal(result.day.transitRides.find(ride=>ride.agent==='incoming').cancelledAt,100);
  const before=new Playback(base), after=new Playback(result.day);
  assert.equal(after.studentsAboard('later',99),before.studentsAboard('later',99),'past ridership is unchanged');
  assert.equal(after.studentsAboard('later',100),0,'the scenario invalidates the future ride');
});
