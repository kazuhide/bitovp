import assert from "node:assert/strict";
import {test} from "node:test";
import {assertIndependentTrim, runSnappingBrowserQa} from "./snapping-browser-qa.mjs";
import {parseOptions, requestAllowed} from "./local-browser-qa.mjs";

const original={schemaVersion:2,id:"project",audioEnabled:true,durationMs:8000,videoClips:[{id:"v",sourceKey:"a",startMs:0,inMs:0,outMs:8000}],audioClips:[{id:"a",sourceKey:"a",startMs:0,inMs:0,outMs:8000}]};
const trimmed={...original,audioClips:[{...original.audioClips[0],outMs:4000}]};
const edit={track:"audio",id:"a",edge:"out",expectedMs:4000};
test("snap QA detects a false alignment or an edit to the opposite track",()=>{
 assert.doesNotThrow(()=>assertIndependentTrim(original,trimmed,edit));
 assert.throws(()=>assertIndependentTrim(original,{...trimmed,videoClips:[{...original.videoClips[0],outMs:7000}]},edit),/opposite track/);
 assert.throws(()=>assertIndependentTrim(original,{...trimmed,audioClips:[{...trimmed.audioClips[0],outMs:3999}]},edit),/boundary/);
 assert.throws(()=>assertIndependentTrim(original,{...trimmed,durationMs:9000},edit),/duration/);
 assert.throws(()=>assertIndependentTrim(original,{...trimmed,audioEnabled:false},edit),/audio enabled/);
 assert.throws(()=>assertIndependentTrim(original,{...trimmed,audioClips:[{...trimmed.audioClips[0],sourceKey:"b"}]},edit),/source/);
 const startTrimmed={...original,audioClips:[{...original.audioClips[0],startMs:4000,inMs:4000}]};
 assert.doesNotThrow(()=>assertIndependentTrim(original,startTrimmed,{...edit,edge:"in"}));
 assert.throws(()=>assertIndependentTrim(original,{...startTrimmed,audioClips:[{...startTrimmed.audioClips[0],inMs:3999}]},{...edit,edge:"in"}),/source time/);
});
test("snap browser QA permits only the isolated origin and preview-task writes",async()=>{
 for(const url of ["https://bitovp.stream","http://localhost:3192","http://127.0.0.1:3192/private"])
  assert.throws(()=>parseOptions(["--base-url",url]));
 const origin=parseOptions([]).baseURL;
 assert.equal(requestAllowed(origin+"/api/vod/input-previews","POST",origin),true);
 for(const path of ["/api/vod/jobs","/api/settings","/api/credentials","/api/live-channels"])
  assert.equal(requestAllowed(origin+path,"POST",origin),false);
 assert.equal(requestAllowed("https://example.com/api/vod/input-previews","POST",origin),false);
 await assert.rejects(runSnappingBrowserQa({baseURL:"https://bitovp.stream",output:"unused"}));
});
