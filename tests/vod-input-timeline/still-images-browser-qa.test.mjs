import assert from "node:assert/strict";
import {test} from "node:test";
import {assertImageAppend,assertPreparedStill,runStillImagesBrowserQa,stillImageFixture,stillOutputPrefix,stillRequestAllowed} from "./still-images-browser-qa.mjs";
const origin="http://127.0.0.1:3192",id="20000000-0000-4000-8000-000000000001";
const source={key:"qa_image",credentialId:stillImageFixture.credentialId,bucket:stillImageFixture.bucket,objectKey:stillImageFixture.objectKey};
const body={kind:"IMAGE_PREPARE",source,durationMs:5000,output:{credentialId:source.credentialId,bucket:source.bucket,prefix:stillOutputPrefix}};
test("still QA permits only two bounded preparations in its dedicated source/output namespace",async()=>{
 assert.equal(stillRequestAllowed(origin+"/api/vod/input-previews","POST",body),true);
 for(const patch of [{durationMs:60000},{sourceIdentity:{etag:"x"}},{source:{...source,key:null}},{source:{...source,objectKey:"private/image.png"}},{source:{...source,signedUrl:"https://private.invalid"}},{output:{...body.output,prefix:"other/"}},{output:{...body.output,prefix:123}},{output:{...body.output,bucket:"other"}}])assert.equal(stillRequestAllowed(origin+"/api/vod/input-previews","POST",{...body,...patch}),false);
 assert.equal(stillRequestAllowed(origin+"/api/vod/input-favorites","POST",stillImageFixture),true);
 assert.equal(stillRequestAllowed(origin+"/api/vod/input-favorites/"+id,"DELETE",null,new Set([id])),true);assert.equal(stillRequestAllowed(origin+"/api/vod/input-favorites/"+id,"DELETE",null,new Set()),false);
 assert.equal(stillRequestAllowed(origin+"/api/vod/input-previews","POST",{kind:"PROBE",sources:[source]}),false);
 for(const path of ["/api/vod/jobs","/api/settings","/api/credentials"])assert.equal(stillRequestAllowed(origin+path,"POST",{}),false);
 await assert.rejects(runStillImagesBrowserQa({baseURL:"https://bitovp.stream",output:"unused"}));
});
const prepared={source:{...source,key:"img_"+"a".repeat(32),objectKey:stillOutputPrefix+"bitovp-generated-inputs/00000000-0000-4000-8000-000000000001/"+id+"/"+id+".mp4"},facts:{key:"img_"+"a".repeat(32),durationMs:5000,video:{width:1920,height:1080,frameRate:{num:30,den:1}},audio:{sampleRate:48000,channels:2}},requestedDurationMs:5000,sha256:"b".repeat(64)};
test("prepared metadata requires scoped MP4, SHA, requested duration and both real streams",()=>{
 assert.doesNotThrow(()=>assertPreparedStill(prepared,5000));
 assert.throws(()=>assertPreparedStill({...prepared,source:{...prepared.source,objectKey:"other.mp4"}},5000),/prefix/);
 assert.throws(()=>assertPreparedStill({...prepared,facts:{...prepared.facts,audio:null}},5000),/streams/);
 assert.throws(()=>assertPreparedStill({...prepared,facts:{...prepared.facts,durationMs:4999}},5000),/shorter/);
 assert.throws(()=>assertPreparedStill({...prepared,sha256:"invalid"},5000));
});
test("append invariant requires preserved tracks plus matching prepared silent audio",()=>{
 const clip={id,sourceKey:"main",startMs:0,inMs:0,outMs:8000},before={schemaVersion:2,id,audioEnabled:true,durationMs:8000,videoClips:[clip],audioClips:[{...clip}]};
 const image={id:"image",sourceKey:prepared.source.key,startMs:8000,inMs:0,outMs:5000},after={...before,durationMs:13000,videoClips:[clip,image],audioClips:[{...clip},{...image}]};
 assert.doesNotThrow(()=>assertImageAppend(before,after,prepared));assert.throws(()=>assertImageAppend(before,{...after,audioClips:[clip]},prepared),/audio/);assert.throws(()=>assertImageAppend(before,{...after,durationMs:12000},prepared),/duration/);
});
