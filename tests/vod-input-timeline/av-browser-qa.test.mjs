import assert from "node:assert/strict";
import {test} from "node:test";
import {assertTrackOverwrite} from "./av-browser-qa.mjs";
import {parseOptions,requestAllowed} from "./local-browser-qa.mjs";
const original={schemaVersion:2,id:"project",audioEnabled:true,durationMs:8000,videoClips:[{id:"v",sourceKey:"a",startMs:0,inMs:0,outMs:8000}],audioClips:[{id:"a",sourceKey:"a",startMs:0,inMs:0,outMs:8000}]};
const replaced={...original,audioClips:[{id:"left",sourceKey:"a",startMs:0,inMs:0,outMs:2000},{id:"middle",sourceKey:"b",startMs:2000,inMs:1000,outMs:5000},{id:"right",sourceKey:"a",startMs:6000,inMs:6000,outMs:8000}]};
const edit={track:"audio",startMs:2000,endMs:6000,sourceKey:"b",inMs:1000};
test("verifies exact opposite-track identity and selected source time independently",()=>{
 assert.doesNotThrow(()=>assertTrackOverwrite(original,replaced,edit));
 assert.throws(()=>assertTrackOverwrite(original,{...replaced,videoClips:[{...original.videoClips[0],outMs:7000}]},edit),/opposite track/);
 assert.throws(()=>assertTrackOverwrite(original,{...replaced,audioClips:replaced.audioClips.map((clip,index)=>index===2?{...clip,inMs:5000,outMs:7000}:clip)},edit),/outside the selected interval/);
 assert.throws(()=>assertTrackOverwrite(original,{...replaced,durationMs:9000},edit),/duration/);
});
test("AV harness remains restricted to the isolated loopback and preview-only writes",()=>{
 assert.throws(()=>parseOptions(["--base-url","https://example.com"]));
 assert.equal(requestAllowed("http://127.0.0.1:3192/api/vod/jobs","POST","http://127.0.0.1:3192"),false);
 assert.equal(requestAllowed("http://127.0.0.1:3192/api/vod/input-previews","POST","http://127.0.0.1:3192"),true);
 assert.equal(requestAllowed("https://example.com/api/vod/input-previews","POST","http://127.0.0.1:3192"),false);
});
