#!/usr/bin/env node
/** Native still-image placement QA; owned fixture, registry ID and output prefix only. */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {isDeepStrictEqual} from "node:util";
import {chromium,expect} from "@playwright/test";
import {parseOptions,requestAllowed} from "./local-browser-qa.mjs";
import {assertTrackOverwrite} from "./av-browser-qa.mjs";

const origin="http://127.0.0.1:3192",credentialId="928d0a9c-3217-4d54-ad2f-8eaa946274c8",bucket="bitovp-editing-preview";
export const stillImageFixture={credentialId,bucket,objectKey:"fixtures/vod-favorites/v1/qa-logo.png",label:"QA静止画 V1",kind:"IMAGE"};
export const stillOutputPrefix="fixtures/vod-still-images-qa/v1/";
const videoKey="fixtures/vod-favorites/v1/qa-video.mp4",favoritePath="/api/vod/input-favorites";
const uuid="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const generated=new RegExp("^"+stillOutputPrefix+"bitovp-generated-inputs/00000000-0000-4000-8000-000000000001/"+uuid+"/"+uuid+"\\.mp4$");
const draftKey='bitovp.wizard-draft:["00000000-0000-4000-8000-000000000001","main:none","vod","new"]';
const keys=(value,list)=>!!value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join(",")===list.split(",").sort().join(",");
const ownedStorage=value=>value?.credentialId===credentialId&&value.bucket===bucket;
export function stillRequestAllowed(url,method,body=null,ownedIds=new Set()){
 const u=new URL(url);if(u.origin!==origin||u.username||u.password||u.hash)return false;
 if(method==="POST"&&u.pathname===favoritePath)return !u.search&&keys(body,"credentialId,bucket,objectKey,label,kind")&&Object.keys(stillImageFixture).every(k=>body[k]===stillImageFixture[k]);
 if(method==="DELETE"&&u.pathname.startsWith(favoritePath+"/")){const id=u.pathname.slice(favoritePath.length+1);return !u.search&&new RegExp("^"+uuid+"$").test(id)&&ownedIds.has(id);}
 if(method==="POST"&&u.pathname==="/api/vod/input-previews"){
  if(body?.kind==="IMAGE_PREPARE")return !u.search&&keys(body,"kind,source,durationMs,output")&&[3000,5000].includes(body.durationMs)&&keys(body.source,"key,credentialId,bucket,objectKey")&&typeof body.source.key==="string"&&/^[a-zA-Z0-9_-]{1,80}$/.test(body.source.key)&&ownedStorage(body.source)&&body.source.objectKey===stillImageFixture.objectKey&&keys(body.output,"credentialId,bucket,prefix")&&ownedStorage(body.output)&&typeof body.output.prefix==="string"&&body.output.prefix.replace(/\/+$/,"")===stillOutputPrefix.replace(/\/+$/,"");
  if(body?.kind==="PROBE")return Array.isArray(body.sources)&&body.sources.length>0&&body.sources.every(s=>keys(s,"key,credentialId,bucket,objectKey")&&ownedStorage(s)&&typeof s.objectKey==="string"&&(s.objectKey===videoKey||generated.test(s.objectKey)));
  return body?.kind==="PREVIEW";
 }
 return requestAllowed(url,method,origin);
}
export function assertPreparedStill(prepared,durationMs){
 assert.ok(prepared&&prepared.source&&prepared.facts,"Missing prepared metadata");
 assert.equal(prepared.requestedDurationMs,durationMs);assert.match(prepared.sha256,/^[0-9a-f]{64}$/);
 assert.ok(ownedStorage(prepared.source)&&generated.test(prepared.source.objectKey),"Prepared MP4 is outside the owned output prefix");
 assert.match(prepared.source.key,/^img_[0-9a-f]{32}$/);assert.equal(prepared.facts.key,prepared.source.key);
 assert.ok(prepared.facts.video&&prepared.facts.audio,"Prepared still must have real video and silent-audio streams");
 assert.equal(prepared.facts.video.width,1920);assert.equal(prepared.facts.video.height,1080);assert.deepEqual(prepared.facts.video.frameRate,{num:30,den:1});
 assert.ok(prepared.facts.durationMs>=durationMs,"Prepared source is shorter than its requested placement");
}
export function assertImageAppend(before,after,prepared){
 assert.equal(after.schemaVersion,2);assert.equal(after.id,before.id);assert.equal(after.durationMs,before.durationMs+prepared.requestedDurationMs,"Image append changed duration incorrectly");
 assert.deepEqual(after.videoClips.slice(0,-1),before.videoClips,"Image append changed existing video");assert.deepEqual(after.audioClips.slice(0,-1),before.audioClips,"Image append changed existing audio");
 const v=after.videoClips.at(-1),a=after.audioClips.at(-1);assert.deepEqual(v,a,"Image append must add its prepared silent audio with the video");
 assert.equal(v.sourceKey,prepared.source.key);assert.equal(v.startMs,before.durationMs);assert.equal(v.inMs,0);assert.equal(v.outMs,prepared.requestedDurationMs);
}
function initialRecord(){
 const clip={id:randomUUID(),sourceKey:"main",startMs:0,inMs:0,outMs:8000},document={schemaVersion:2,id:randomUUID(),audioEnabled:true,durationMs:8000,videoClips:[clip],audioClips:[{...clip}]};
 return {version:1,kind:"vod",step:1,savedAt:Date.now(),value:{inputFiles:[{key:"main",inputKey:"main",kind:"S3",credentialId,bucket,path:videoKey,name:"Still-image QA video"}],inputTimeline:document,output:{credentialId,kind:"S3",bucket,basePath:stillOutputPrefix,name:"Still-image QA output",publicRead:false}}};
}
const editor=page=>page.getByRole("region",{name:"入力タイムライン",exact:true});
const project=(report,id)=>report.requests.findLast(r=>r.kind==="PREVIEW"&&r.document.id===id)?.document;
async function waitProject(report,id,predicate){await expect.poll(()=>predicate(project(report,id)),{timeout:15000}).toBe(true);return structuredClone(project(report,id));}
async function ready(page,duration){const e=editor(page);await expect(e.getByText("プレビュー準備完了",{exact:true})).toBeVisible({timeout:120000});const video=e.getByLabel("入力タイムラインのプレビュー",{exact:true});await expect.poll(()=>video.evaluate(v=>v.readyState),{timeout:30000}).toBeGreaterThanOrEqual(2);assert.ok(Math.abs(await video.evaluate(v=>v.duration)-duration)<.12,"Actual MP4 duration differs from the edited range");return video;}
async function draftSnapshot(page){return page.evaluate(key=>{const value=JSON.parse(localStorage.getItem(key)??"null")?.value;return value?{inputTimeline:value.inputTimeline,inputFiles:(value.inputFiles??[]).map(f=>Object.fromEntries(["key","inputKey","kind","credentialId","bucket","path","purpose","displayName"].filter(k=>k in f).map(k=>[k,f[k]]))),output:Object.fromEntries(["credentialId","kind","bucket","basePath"].map(k=>[k,value.output?.[k]]))}:null;},draftKey);}
async function registerImage(page,report){
 await editor(page).getByRole("button",{name:"固定素材を追加",exact:true}).click();const picker=page.getByRole("dialog").filter({has:page.locator("#picker-credential")});
 await picker.locator("#picker-credential").selectOption({label:"VOD timeline local S3 (synthetic only)"});await picker.locator("#picker-bucket").selectOption(bucket);
 for(const folder of ["fixtures/","vod-favorites/","v1/"])await picker.getByRole("button",{name:folder,exact:true}).click();
 await picker.getByRole("row").filter({has:page.getByText("qa-logo.png",{exact:true})}).getByRole("button",{name:"入力に使う",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"固定素材を保存",exact:true});await dialog.getByRole("textbox",{name:"表示名",exact:true}).fill(stillImageFixture.label);await expect(dialog.getByRole("combobox",{name:"素材の種類",exact:true})).toHaveValue("IMAGE");await dialog.getByRole("button",{name:"保存",exact:true}).click();await expect(dialog).toBeHidden();await expect.poll(()=>!!report.favorite).toBe(true);
 await expect(editor(page).getByRole("button",{name:stillImageFixture.label+"をV1に配置",exact:true})).toBeEnabled();
}
async function placeImage(page,report,durationSeconds,method){
 const preparedBefore=report.prepared.length;await editor(page).getByRole("button",{name:stillImageFixture.label+"をV1に配置",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"画像をV1に配置",exact:true}),duration=dialog.getByRole("spinbutton",{name:"表示時間（秒）",exact:true}),place=dialog.getByRole("button",{name:"配置",exact:true});
 await expect(duration).toHaveValue("5");
 for(const invalid of ["0","61"]){await duration.fill(invalid);await duration.press("Tab");await expect(place).toBeDisabled();}
 await duration.fill(String(durationSeconds));await duration.press("Tab");await dialog.getByRole("combobox",{name:"配置方法",exact:true}).selectOption(method);
 if(method==="overwrite"){await duration.fill("7");await duration.press("Tab");await expect(place).toBeDisabled();await duration.fill(String(durationSeconds));await duration.press("Tab");}
 await dialog.getByRole("button",{name:"保存先を選択",exact:true}).click();const picker=page.getByRole("dialog").filter({has:page.locator("#picker-credential")});
 await expect(picker.locator("#picker-credential")).toHaveValue(credentialId);await expect(picker.locator("#picker-bucket")).toHaveValue(bucket);
 for(const folder of ["fixtures/","vod-still-images-qa/","v1/"])await picker.getByRole("button",{name:folder,exact:true}).click();
 await picker.getByRole("button",{name:/^現在のプレフィックスを/}).click();await expect(picker).toBeHidden();await expect(place).toBeEnabled();
 await place.click();await expect(dialog).toBeHidden({timeout:120000});await expect.poll(()=>report.prepared.length,{timeout:120000}).toBeGreaterThan(preparedBefore);
 const prepared=report.prepared.at(-1);assertPreparedStill(prepared,durationSeconds*1000);return prepared;
}
async function yellowFrame(page,video,{timelineMs}={}){
 if(timelineMs!==undefined)await editor(page).getByRole("slider",{name:"時間目盛り",exact:true}).click({position:{x:timelineMs*.04,y:14},modifiers:["Alt"]});
 await expect.poll(()=>video.evaluate((v,target)=>!v.seeking&&v.readyState>=2&&(target===null||Math.abs(v.currentTime-target)<.12),timelineMs===undefined?null:timelineMs/1000)).toBe(true);
 const pixel=await video.evaluate(v=>{const c=new OffscreenCanvas(1,1),x=c.getContext("2d");x.drawImage(v,v.videoWidth/2,v.videoHeight/2,1,1,0,0,1,1);return [...x.getImageData(0,0,1,1).data];});
 assert.ok(pixel[0]>150&&pixel[1]>150&&pixel[2]<80,"Prepared yellow still did not decode in the actual MP4");return pixel;
}
async function playFrames(page,video){const before=await video.evaluate(v=>v.getVideoPlaybackQuality().totalVideoFrames);await editor(page).getByRole("button",{name:"再生・一時停止",exact:true}).click();await expect.poll(()=>video.evaluate((v,n)=>!v.paused&&v.getVideoPlaybackQuality().totalVideoFrames>=n+3,before),{timeout:5000}).toBe(true);await editor(page).getByRole("button",{name:"再生・一時停止",exact:true}).click();await expect.poll(()=>video.evaluate(v=>v.paused&&!v.seeking)).toBe(true);return video.evaluate(v=>({duration:v.duration,width:v.videoWidth,height:v.videoHeight,decodedFrames:v.getVideoPlaybackQuality().totalVideoFrames,readyState:v.readyState}));}
async function history(page,report,id,expected,kind){const count=report.requests.filter(r=>r.kind==="IMAGE_PREPARE").length;await editor(page).getByRole("button",{name:kind==="undo"?"元に戻す":"やり直す",exact:true}).click();await waitProject(report,id,next=>isDeepStrictEqual(next,expected));await ready(page,expected.durationMs/1000);assert.equal(report.requests.filter(r=>r.kind==="IMAGE_PREPARE").length,count,"History unexpectedly re-prepared the image");}
async function sourceAudition(page,report,prepared){
 const selector=`span[title="${prepared.source.objectKey}"]`,label=editor(page).locator(selector),row=editor(page).locator("li").filter({has:page.locator(selector)});await expect(row).toHaveCount(1);await expect(label).toContainText(stillImageFixture.label);await row.locator("button[aria-pressed]").click();
 const video=await ready(page,prepared.requestedDurationMs/1000),pixel=await yellowFrame(page,video),playback=await playFrames(page,video);report.sourceAudition={source:prepared.source,pixel,...playback};await editor(page).getByRole("button",{name:"シーケンス",exact:true}).click();
}
async function appendAndOverwrite(page,report,id,before){
 console.log("Still QA: default five-second append, real MP4 and single-step history");
 const append=await placeImage(page,report,5,"append"),appended=await waitProject(report,id,next=>next?.durationMs===13000);assertImageAppend(before,appended,append);
 let video=await ready(page,13);report.append={before,after:appended,prepared:append,pixel:await yellowFrame(page,video,{timelineMs:9000}),playback:await playFrames(page,video)};
 await sourceAudition(page,report,append);await ready(page,13);await history(page,report,id,before,"undo");
 await expect.poll(async()=>!!(await draftSnapshot(page))?.inputFiles.some(f=>f.key===append.source.key&&f.path===append.source.objectKey)).toBe(true);
 await history(page,report,id,appended,"redo");await history(page,report,id,before,"undo");
 console.log("Still QA: three-second V1 overwrite while A1 remains unchanged");
 await editor(page).getByRole("slider",{name:"時間目盛り",exact:true}).click({position:{x:80,y:14},modifiers:["Alt"]});await expect(editor(page).getByRole("slider",{name:"シーケンスの再生位置",exact:true})).toHaveValue("2000");
 const overwrite=await placeImage(page,report,3,"overwrite"),overwritten=await waitProject(report,id,next=>next?.videoClips.some(c=>c.sourceKey===overwrite.source.key));
 assertTrackOverwrite(before,overwritten,{track:"video",startMs:2000,endMs:5000,sourceKey:overwrite.source.key,inMs:0});
 video=await ready(page,8);report.overwrite={before,after:overwritten,prepared:overwrite,pixel:await yellowFrame(page,video,{timelineMs:3000}),playback:await playFrames(page,video)};
 await history(page,report,id,before,"undo");await history(page,report,id,overwritten,"redo");
 const snapshot=await draftSnapshot(page);for(const prepared of [append,overwrite])assert.ok(snapshot.inputFiles.some(f=>f.key===prepared.source.key&&f.path===prepared.source.objectKey),"Undo/redo dropped the permanent prepared source reference");
}
async function restoreAndScreens(page,context,report,output){
 console.log("Still QA: persistent prepared inputs and three themes / four viewports");
 const before=await draftSnapshot(page);
 for(const theme of ["neon","paper","high-contrast"]){
  if(theme!=="neon")await context.addCookies([{name:"bitovp-theme",value:theme,url:origin}]);
  const count=report.requests.filter(r=>r.kind==="PROBE").length;await page.reload();await page.getByRole("button",{name:"復元",exact:true}).click();const video=await ready(page,8);
  assert.ok(report.requests.filter(r=>r.kind==="PROBE").length>count,"Prepared assets were not re-PROBE'd after Restore");const after=await draftSnapshot(page);assert.deepEqual(after,before,"Restore lost prepared source references or the edit document");
  const sourceLabels=[];for(const prepared of report.prepared){const label=editor(page).locator(`span[title="${prepared.source.objectKey}"]`);await expect(label).toContainText(stillImageFixture.label);sourceLabels.push({key:prepared.source.key,label:await label.innerText()});}
  const pixel=await yellowFrame(page,video,{timelineMs:3000});report.restores.push({theme,pixel,sourceKeys:after.inputFiles.map(f=>f.key),sourceLabels});await expect(page.locator("html")).toHaveAttribute("data-theme",theme);
  for(const width of [320,768,1024,1440]){await page.setViewportSize({width,height:1000});await page.evaluate(async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});const layout=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,page:document.documentElement.scrollWidth}));report.layouts.push({theme,width,...layout});assert.ok(layout.page<=layout.viewport+1,"Still-image layout overflows at "+theme+"/"+width);await editor(page).screenshot({path:resolve(output,theme+"-"+width+".png"),animations:"allow"});}
 }
 await writeFile(resolve(output,"accessibility.yaml"),await editor(page).ariaSnapshot());
}
export async function runStillImagesBrowserQa(options){
 assert.equal(options.baseURL,origin);await mkdir(options.output,{recursive:true});const record=initialRecord(),id=record.value.inputTimeline.id;
 const report={baseURL:origin,setup:"Owned isolated-context synthetic A8 draft and non-secret output destination; native Restore, storage picker, placement and history",startedAt:new Date().toISOString(),status:"RUNNING",blocked:[],httpErrors:[],consoleErrors:[],responseErrors:[],requests:[],tasks:[],prepared:[],restores:[],layouts:[]};
 const ownedIds=new Set(),browser=await chromium.launch({headless:true}),context=await browser.newContext({baseURL:origin,viewport:{width:1440,height:1000},locale:"ja-JP",serviceWorkers:"block"});await context.addCookies([{name:"ovp-locale",value:"ja",url:origin}]);
 await context.addInitScript(({key,record,marker})=>{if(location.origin==="http://127.0.0.1:3192"&&!sessionStorage.getItem(marker)){localStorage.setItem(key,JSON.stringify(record));sessionStorage.setItem(marker,"1");}},{key:draftKey,record,marker:"bitovp-still-image-fixture:"+id});
 await context.route("**/*",async route=>{const r=route.request(),body=r.method()==="POST"?JSON.parse(r.postData()??"null"):null;if(!stillRequestAllowed(r.url(),r.method(),body,ownedIds)){report.blocked.push({method:r.method(),path:new URL(r.url()).pathname,kind:body?.kind});return route.abort();}if(r.method()==="POST")report.requests.push(body);return route.continue();});
 const page=await context.newPage();page.on("pageerror",e=>report.consoleErrors.push(e.message));page.on("console",m=>{if(m.type()==="error")report.consoleErrors.push(m.text());});
 page.on("response",async r=>{
  const path=new URL(r.url()).pathname;if(r.status()>=400)report.httpErrors.push({path,status:r.status()});if(!r.ok())return;
  if(path===favoritePath&&r.request().method()==="POST"){const value=await r.json().catch(()=>null);if(value?.favorite?.objectKey!==stillImageFixture.objectKey)report.responseErrors.push("Unexpected saved favorite");else{report.favorite=value.favorite;ownedIds.add(value.favorite.id);}}
  if(path===favoritePath&&r.request().method()==="GET"&&!report.initialFavorites){const value=await r.json().catch(()=>null);if(Array.isArray(value?.favorites))report.initialFavorites=value.favorites.filter(f=>f.objectKey===stillImageFixture.objectKey).map(f=>f.id);}
  if(path.startsWith(favoritePath+"/")&&r.request().method()==="DELETE"&&r.status()===204)report.favoriteRemoved=true;
  if(/^\/api\/vod\/input-previews(?:\/[0-9a-f-]{36})?$/.test(path)){const value=await r.json().catch(()=>null),task=value?.task;if(task){report.tasks.push({id:task.id,kind:task.kind,status:task.status});const prepared=task.result?.prepared;if(prepared){if(typeof prepared.source?.key!=="string")report.responseErrors.push("Prepared task response is missing its source key");else if(!report.prepared.some(p=>p.source.key===prepared.source.key))report.prepared.push(prepared);}}}
 });
 try{
  await page.goto("/vod/new");await page.getByRole("button",{name:"復元",exact:true}).click();await expect(editor(page)).toBeVisible();await ready(page,8);await expect.poll(()=>!!report.initialFavorites).toBe(true);assert.equal(report.initialFavorites.length,0,"The owned image favorite already exists; preserve it and clean the earlier test first");
  const before=await waitProject(report,id,next=>isDeepStrictEqual(next,record.value.inputTimeline));await registerImage(page,report);await appendAndOverwrite(page,report,id,before);
  report.pacing={limit:30,windowMs:60000,quietMs:60200,postsBefore:report.requests.length,startedAt:Date.now()};assert.ok(report.requests.filter(r=>["PROBE","PREVIEW","IMAGE_PREPARE"].includes(r.kind)).length<30,"Image edit group exceeds the real POST budget");console.log("Still QA: quiet window before Restore and layout checks; POSTs="+report.requests.length);await page.waitForTimeout(30100);await page.waitForTimeout(30100);report.pacing.finishedAt=Date.now();assert.equal(report.requests.length,report.pacing.postsBefore,"Unexpected POST during quiet window");
  await restoreAndScreens(page,context,report,options.output);await editor(page).getByRole("button",{name:stillImageFixture.label+"を固定素材から外す",exact:true}).click();await expect.poll(()=>report.favoriteRemoved===true).toBe(true);await ready(page,8);
  assert.equal(report.requests.filter(r=>r.kind==="IMAGE_PREPARE").length,2,"Expected exactly two image preparations");for(const r of report.requests.filter(r=>r.kind==="PROBE"))assert.ok(r.sources.every(s=>s.objectKey!==stillImageFixture.objectKey),"Original PNG entered AV PROBE");
  assert.equal(report.blocked.length,0,"Forbidden request attempted");assert.equal(report.httpErrors.length,0,"HTTP error");assert.equal(report.consoleErrors.length,0,"Console error");assert.equal(report.responseErrors.length,0,"Response error");report.status="PASSED";
 }catch(error){report.status="FAILED";report.error=error.message;await page.screenshot({path:resolve(options.output,"failure.png"),fullPage:true}).catch(()=>{});throw error;}
 finally{
  await page.keyboard.press("Escape").catch(()=>{});
  if(report.favorite&&!report.favoriteRemoved){const remove=editor(page).getByRole("button",{name:stillImageFixture.label+"を固定素材から外す",exact:true});if(await remove.count()&&await remove.isEnabled())await remove.click().catch(()=>{});}
  report.finishedAt=new Date().toISOString();report.generatedAssetsRetained=report.prepared.map(p=>p.source);await writeFile(resolve(options.output,"browser-receipt.json"),JSON.stringify(report,null,2)+"\n");await context.close();await browser.close();console.log(JSON.stringify({status:report.status,output:options.output,prepared:report.prepared.length,screenshots:report.layouts.length,blocked:report.blocked.length}));
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runStillImagesBrowserQa(parseOptions(process.argv.slice(2)));
