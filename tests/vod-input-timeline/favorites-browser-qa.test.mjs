import assert from "node:assert/strict";
import {test} from "node:test";
import {assertFavoriteCopyPreserved,assertNoImageProbes,favoriteFixtures,favoriteRequestAllowed,runFavoritesBrowserQa} from "./favorites-browser-qa.mjs";
const origin="http://127.0.0.1:3192",id="20000000-0000-4000-8000-000000000001";
const body=f=>Object.fromEntries(["credentialId","bucket","kind","label","objectKey"].map(k=>[k,f[k]]));
test("favorites QA permits only its three exact references and IDs returned to this run",async()=>{
 for(const f of favoriteFixtures)assert.equal(favoriteRequestAllowed(origin+"/api/vod/input-favorites","POST",body(f)),true);
 for(const patch of [{objectKey:"other/object.mp4"},{bucket:"private-bucket"},{credentialId:id},{label:"other label"},{kind:"IMAGE"},{orgId:id}])
  assert.equal(favoriteRequestAllowed(origin+"/api/vod/input-favorites","POST",{...body(favoriteFixtures[0]),...patch}),false);
 assert.equal(favoriteRequestAllowed(origin+"/api/vod/input-favorites/"+id,"DELETE",null,new Set([id])),true);
 assert.equal(favoriteRequestAllowed(origin+"/api/vod/input-favorites/"+id,"DELETE",null,new Set()),false);
 for(const path of ["/api/vod/jobs","/api/settings","/api/credentials","/api/live-channels"])
  assert.equal(favoriteRequestAllowed(origin+path,"POST",{}),false);
 assert.equal(favoriteRequestAllowed("https://bitovp.stream/api/vod/input-favorites","POST",body(favoriteFixtures[0])),false);
 assert.equal(favoriteRequestAllowed(origin+"/api/vod/input-favorites?orgId=other","POST",body(favoriteFixtures[0])),false);
 assert.equal(favoriteRequestAllowed("http://user@127.0.0.1:3192/api/vod/input-favorites","POST",body(favoriteFixtures[0])),false);
 assert.equal(favoriteRequestAllowed(origin+"/api/vod/input-favorites/"+id+"?all=true","DELETE",null,new Set([id])),false);
 assert.equal(favoriteRequestAllowed(origin+"/api/vod/input-previews","POST",{kind:"PROBE"}),true);
 await assert.rejects(runFavoritesBrowserQa({baseURL:"https://bitovp.stream",output:"unused"}));
});
test("image exclusion assertion detects PNG and FILTER_IMAGE contamination",()=>{
 assert.doesNotThrow(()=>assertNoImageProbes([{kind:"PROBE",sources:[{objectKey:favoriteFixtures[0].objectKey}]}]));
 assert.throws(()=>assertNoImageProbes([{kind:"PROBE",sources:[{objectKey:favoriteFixtures[2].objectKey}]}]),/logo entered/);
 assert.throws(()=>assertNoImageProbes([{kind:"PROBE",sources:[{objectKey:"other.png",purpose:"FILTER_IMAGE"}]}]),/FILTER_IMAGE/);
});
test("favorite-copy assertion protects references, timeline and output logo",()=>{
 const original={inputFiles:[{key:"copy",path:"fixture.png",purpose:"FILTER_IMAGE"}],inputTimeline:{videoClips:[{id:"v"}]},logo:{imagePath:"fixture.png",filterKey:"logo",attachments:[{id:"wz-v-0-x-flt-0",value:"logo",position:0}]}};
 assert.doesNotThrow(()=>assertFavoriteCopyPreserved(original,structuredClone(original)));
 for(const field of ["inputFiles","inputTimeline","logo"])assert.throws(()=>assertFavoriteCopyPreserved(original,{...original,[field]:null}),/Favorite removal/);
 assert.throws(()=>assertFavoriteCopyPreserved(original,{...original,inputFiles:[{key:"copy",path:"fixture.png"}]}),/input references/);
 assert.throws(()=>assertFavoriteCopyPreserved(original,{...original,logo:{...original.logo,attachments:[]}}),/output logo/);
});
