import assert from "node:assert/strict";
import {test} from "node:test";
import {assertClipPosition,positioningFixture,runPositioningBrowserQa} from "./positioning-browser-qa.mjs";
import {parseOptions,requestAllowed} from "./local-browser-qa.mjs";

test("native position QA checks source, opposite track, duration and outside coverage",()=>{
 const before=positioningFixture().document,id=before.videoClips[1].id;
 const after={...before,videoClips:before.videoClips.map(c=>c.id===id?{...c,startMs:10347}:c)},edit={track:"video",id,startMs:10347};
 assert.doesNotThrow(()=>assertClipPosition(before,after,edit));
 assert.throws(()=>assertClipPosition(before,{...after,audioClips:[]},edit),/opposite track/);
 assert.throws(()=>assertClipPosition(before,{...after,durationMs:35000},edit),/duration/);
 assert.throws(()=>assertClipPosition(before,{...after,videoClips:after.videoClips.map(c=>c.id===id?{...c,inMs:1}:c)},edit),/source range/);
 assert.throws(()=>assertClipPosition(before,{...after,videoClips:after.videoClips.map(c=>c.id===id?c:{...c,inMs:c.inMs+1})},edit),/outside/);
 assert.throws(()=>assertClipPosition(before,before,edit),/requested start/);
});
test("position fixture reproduces D34 gaps with positive and zero source headroom",()=>{
 const d=positioningFixture().document;
 assert.equal(d.durationMs,34000);assert.equal(d.videoClips[1].startMs,11347);assert.equal(d.videoClips[1].inMs,0);
 assert.equal(d.videoClips[2].startMs,19347);assert.equal(d.videoClips[2].inMs,1347);assert.equal(d.audioClips[2].startMs,26000);
 assert.equal(26000-(7689+6653),11658);
 const pair=positioningFixture("paired").document;assert.deepEqual(pair.videoClips,pair.audioClips.slice(0,2));assert.equal(pair.audioClips[2].sourceKey,"wav");
});
test("position browser QA cannot start outside the owned preview-only origin",async()=>{
 await assert.rejects(runPositioningBrowserQa({baseURL:"https://bitovp.stream",output:"unused"}));
 assert.throws(()=>parseOptions(["--base-url","http://localhost:3192"]));const origin=parseOptions([]).baseURL;
 assert.equal(requestAllowed(origin+"/api/vod/input-previews","POST",origin),true);
 for(const path of ["/api/vod/jobs","/api/credentials","/api/settings","/api/live-channels"])assert.equal(requestAllowed(origin+path,"POST",origin),false);
 assert.equal(requestAllowed("https://example.com/api/vod/input-previews","POST",origin),false);
});
