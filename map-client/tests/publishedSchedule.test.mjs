import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){if(specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier))return next(`${specifier}.ts`,context);throw error}}});
const { PublishedTransit } = await import('../src/transit/publishedSchedule.ts');
const { makeTrack } = await import('../src/transit/tracks.ts');
const origin=[-71.1,42.35], destination=[-71.09,42.35];
function fixture(weekdays=[0],shift=0){
 const track=makeTrack('57',0,[origin,destination],0);
 const data={routes:[{id:'57',name:'57'}],stops:[],areas:[]};
 const schedule={schemaVersion:1,referenceWeekStart:'2026-10-19',dates:[],priorDate:'2026-10-18',feed:{},sourceUrl:'source',stops:{a:{position:origin,mapStopId:'a'},b:{position:destination,mapStopId:'b'}},trips:[{id:'trip',route:'57',direction:0,weekdays,stops:[{stop:'a',arrival:32400+shift,departure:32460+shift},{stop:'b',arrival:32700+shift,departure:32760+shift}]}]};
 return {schedule,track,transit:new PublishedTransit(data,[track],schedule),data};
}
test('published anchors determine dwell and travel time, not heuristic speed',()=>{
 const {transit,track}=fixture();transit.setTime(32430,0);assert.equal(transit.positionsAt()[0].status,'STOPPED_AT');assert.equal(transit.positionsAt()[0].sTo,0);
 transit.setTime(32580,0);assert.equal(transit.positionsAt()[0].status,'IN_TRANSIT_TO');assert.ok(Math.abs(transit.positionsAt()[0].sTo-track.length/2)<1e-6);
 transit.setTime(32730,0);assert.equal(transit.positionsAt()[0].sTo,track.length);
 transit.setTime(32800,0);assert.equal(transit.positionsAt().length,0);
 transit.setTime(32580,6);assert.equal(transit.positionsAt().length,0);
});
test('previous service-day 25-hour trips appear after midnight',()=>{
 const {transit}=fixture([-1],16*3600);transit.setTime(3600+120,0);assert.equal(transit.positionsAt().length,1);assert.equal(transit.inService('57'),true);
 transit.setTime(3600+120,1);assert.equal(transit.positionsAt().length,0);
});
test('off-route anchors break the run rather than bridging disconnected geometry',()=>{
 const {schedule,data,track}=fixture();schedule.stops.x={position:[-72,42.35],mapStopId:null};
 schedule.trips[0].stops.splice(1,0,{stop:'x',arrival:32500,departure:32500});
 const transit=new PublishedTransit(data,[track],schedule);transit.setTime(32580,0);assert.equal(transit.positionsAt().length,0);
});
test('paused simulation keeps arrival countdown tied to simulation time',()=>{
 const {transit}=fixture();const original=Date.now;let now=100000;Date.now=()=>now;
 try {transit.setTime(32430,0);const first=transit.nextArrivals('b')[0].time-now;now+=300000;transit.setTime(32430,0);assert.equal(transit.nextArrivals('b')[0].time-now,first);}finally{Date.now=original}
});


test('date-aware playback refuses weekday reuse outside the collected dates', () => {
 const {transit, schedule}=fixture();
 schedule.dates=['2026-10-19']; schedule.feed={start:'20261001',end:'20261031'};
 transit.setTime(32430,0,'2026-10-19');assert.equal(transit.positionsAt().length,1);
 transit.setTime(32430,0,'2026-10-26');assert.equal(transit.positionsAt().length,0);
 assert.deepEqual(transit.state.arrivals,[]);assert.equal(transit.inService('57'),undefined);
});

test('historical shuttle baseline cannot load as a current published timetable', async () => {
 const {loadPublishedSchedule}=await import('../src/transit/publishedSchedule.ts');
 const original=globalThis.fetch;
 globalThis.fetch=async()=>({ok:true,json:async()=>({schemaVersion:1,trips:[],stops:{},dates:Array(7).fill('2026-10-19'),feed:{start:'20240830',end:'20251231'}})});
 try { await assert.rejects(loadPublishedSchedule(),/historical baseline/); } finally {globalThis.fetch=original;}
});
