#!/usr/bin/env node
/** Native positioning QA in owned, isolated Chromium; synthetic draft setup only. */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {isDeepStrictEqual} from "node:util";
import {chromium,expect} from "@playwright/test";
import {parseOptions,requestAllowed} from "./local-browser-qa.mjs";

const origin="http://127.0.0.1:3192";
const draftKey='bitovp.wizard-draft:["00000000-0000-4000-8000-000000000001","main:none","vod","new"]';
const labels={editor:"入力タイムライン",video:"入力タイムラインのプレビュー",position:"シーケンスの再生位置"};
const clipId=n=>`20000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const end=clip=>clip.startMs+clip.outMs-clip.inMs;
const trackKey=track=>track==="video"?"videoClips":"audioClips";
export function positioningFixture(kind="gapped") {
 assert.ok(["gapped","paired"].includes(kind));
 const clip=(id,sourceKey,startMs,inMs,outMs)=>({id:clipId(id),sourceKey,startMs,inMs,outMs});
 const document=kind==="gapped"
  ?{schemaVersion:2,id:randomUUID(),durationMs:34000,audioEnabled:true,videoClips:[clip(1,"main",0,0,7689),clip(2,"main",11347,0,8000),clip(3,"main",19347,1347,8000)],audioClips:[clip(4,"main",0,0,7689),clip(5,"main",11347,0,6653),clip(6,"wav",26000,0,8000)]}
  :{schemaVersion:2,id:randomUUID(),durationMs:21994,audioEnabled:true,videoClips:[clip(11,"main",0,0,8000),clip(12,"b",8000,0,5994)],audioClips:[clip(11,"main",0,0,8000),clip(12,"b",8000,0,5994),clip(13,"wav",13994,0,8000)]};
 const input=(key,path)=>({key,inputKey:"main",kind:"S3",credentialId:"928d0a9c-3217-4d54-ad2f-8eaa946274c8",bucket:"bitovp-editing-preview",path,name:"VOD timeline local S3 (synthetic only)"});
 return {document,record:{version:1,kind:"vod",step:1,savedAt:Date.now(),value:{inputFiles:[input("main","fixtures/vod-timeline/v1/a.mp4"),input("b","fixtures/vod-timeline/v1/b.mp4"),input("wav","fixtures/vod-timeline/v2/c.wav")],inputTimeline:document}}};
}
function outsideCoverage(clips,durationMs,excluded) {
 const cuts=[0,durationMs,...excluded.flat()].sort((a,b)=>a-b),result=[];
 for(let i=1;i<cuts.length;i++){
  const low=cuts[i-1],high=cuts[i];if(high<=low||excluded.some(([a,b])=>low>=a&&high<=b))continue;
  for(const clip of clips){
   const start=Math.max(low,clip.startMs),stop=Math.min(high,end(clip));
   if(stop>start)result.push({sourceKey:clip.sourceKey,startMs:start,endMs:stop,inMs:clip.inMs+start-clip.startMs,outMs:clip.inMs+stop-clip.startMs});
  }
 }
 return result;
}
export function assertClipPosition(before,after,{track,id,startMs}) {
 assert.equal(after.schemaVersion,2);assert.equal(before.schemaVersion,2);
 assert.equal(after.id,before.id);assert.equal(after.durationMs,before.durationMs,"Position changed program duration");
 assert.equal(after.audioEnabled,before.audioEnabled,"Position changed audio enabled state");
 const key=trackKey(track),opposite=trackKey(track==="video"?"audio":"video");
 assert.deepEqual(after[opposite],before[opposite],"Position changed the opposite track");
 const old=before[key].find(clip=>clip.id===id),moved=after[key].find(clip=>clip.id===id);assert.ok(old&&moved,"Position lost the selected clip");
 assert.equal(moved.startMs,startMs,"Position did not reach the requested start");
 assert.deepEqual({sourceKey:moved.sourceKey,inMs:moved.inMs,outMs:moved.outMs},{sourceKey:old.sourceKey,inMs:old.inMs,outMs:old.outMs},"Position changed the source range");
 assert.ok(Number.isSafeInteger(startMs)&&startMs>=0&&end(moved)<=after.durationMs);
 const excluded=[[old.startMs,end(old)],[moved.startMs,end(moved)]];
 assert.deepEqual(outsideCoverage(after[key],after.durationMs,excluded),outsideCoverage(before[key],before.durationMs,excluded),"Position changed coverage outside the old/new intervals");
}
const sameDocument=(a,b)=>isDeepStrictEqual(a,b);
function project(report,id){return report.requests.findLast(r=>r.kind==="PREVIEW"&&r.document.id===id)?.document;}
async function waitDocument(session,predicate){await expect.poll(()=>predicate(project(session.report,session.fixture.document.id)),{timeout:15000}).toBe(true);return structuredClone(project(session.report,session.fixture.document.id));}
function body(session,track,id){return session.editor.locator(`button[data-clip-track="${track}"][data-clip-id="${id}"]`);}
async function pixels(session,track,id){const clip=project(session.report,session.fixture.document.id)?.[trackKey(track)].find(c=>c.id===id)??session.fixture.document[trackKey(track)].find(c=>c.id===id);const b=await body(session,track,id).boundingBox();assert.ok(b&&clip);return b.width/(clip.outMs-clip.inMs);}
async function shownStart(session,track,id){const b=await body(session,track,id).boundingBox(),c=await session.editor.getByTestId("input-timeline-track").boundingBox();assert.ok(b&&c);return Math.round((b.x-c.x)/await pixels(session,track,id));}
async function mediaReady(session,expectedDuration){
 await expect(session.editor.getByText("プレビュー準備完了",{exact:true})).toBeVisible({timeout:120000});
 const video=session.editor.getByLabel(labels.video,{exact:true});await expect.poll(()=>video.evaluate(e=>e.readyState),{timeout:30000}).toBeGreaterThanOrEqual(2);
 if(expectedDuration!==undefined)assert.ok(Math.abs(await video.evaluate(e=>e.duration)-expectedDuration)<.12,"Actual MP4 duration differs from preview range");return video;
}
async function guide(session,time){const g=session.editor.getByTestId("input-timeline-snap-guide");if(time===null)await expect(g).toHaveCount(0);else await expect(g).toHaveAttribute("data-snap-ms",String(time));return g;}
async function selectTrack(session,track){await session.editor.getByRole("button",{name:track==="video"?"V1を選択":"A1を選択",exact:true}).click();await session.editor.getByRole("slider",{name:"時間目盛り",exact:true}).press("Home");}
async function beginBody(session,track,id,startMs,{alt=false,unlink=true}={}) {
 if(unlink)await selectTrack(session,track);
 const target=body(session,track,id);await target.scrollIntoViewIfNeeded();const box=await target.boundingBox();assert.ok(box);
 const scale=await pixels(session,track,id),old=project(session.report,session.fixture.document.id)[trackKey(track)].find(c=>c.id===id),x=box.x+box.width/2,y=box.y+box.height/2;
 if(alt)await session.page.keyboard.down("Alt");
 await session.page.mouse.move(x,y);await session.page.mouse.down();await session.page.mouse.move(x+(startMs-old.startMs)*scale,y,{steps:5});
 return {target,x,y,scale,oldStartMs:old.startMs,move:async value=>session.page.mouse.move(x+(value-old.startMs)*scale,y,{steps:3})};
}
async function undo(session,before,keyboard=false){
 if(keyboard)await session.page.keyboard.press(process.platform==="darwin"?"Meta+z":"Control+z");else await session.editor.getByRole("button",{name:"元に戻す",exact:true}).click();
 await waitDocument(session,next=>sameDocument(next,before));await mediaReady(session);
}
async function commitMove(session,before,edit){await session.page.mouse.up();await session.page.keyboard.up("Alt");await guide(session,null);const after=await waitDocument(session,next=>next?.[trackKey(edit.track)].some(c=>c.id===edit.id&&c.startMs===edit.startMs));assertClipPosition(before,after,edit);await mediaReady(session);return after;}
async function moveCase(session,kind,track,id,raw,expected=raw,options={}) {
 const before=structuredClone(project(session.report,session.fixture.document.id)),count=session.report.requests.length;
 await beginBody(session,track,id,raw,options);await guide(session,options.guideMs??null);
 await expect.poll(()=>shownStart(session,track,id)).toBe(expected);assert.equal(session.report.requests.length,count,"Staged drag dispatched a preview before pointer-up");
 const after=await commitMove(session,before,{track,id,startMs:expected});session.report.cases.push({kind,before,after});await undo(session,before);
}
async function openFixture(browser,report,kind){
 const fixture=positioningFixture(kind),context=await browser.newContext({baseURL:origin,viewport:{width:1440,height:1000},locale:"ja-JP",serviceWorkers:"block"});
 await context.addCookies([{name:"ovp-locale",value:"ja",url:origin}]);
 await context.addInitScript(({key,record,marker})=>{if(location.origin==="http://127.0.0.1:3192"&&!sessionStorage.getItem(marker)){localStorage.setItem(key,JSON.stringify(record));sessionStorage.setItem(marker,"1");}},{key:draftKey,record:fixture.record,marker:"bitovp-positioning-fixture:"+fixture.document.id});
 await context.route("**/*",async route=>{const r=route.request();if(!requestAllowed(r.url(),r.method(),origin)){report.blocked.push({method:r.method(),path:new URL(r.url()).pathname});return route.abort();}if(r.method()==="POST"){const value=JSON.parse(r.postData()??"null");report.requests.push(value);report.requestTimes.push({at:Date.now(),kind:value?.kind,fixture:kind});}return route.continue();});
 const page=await context.newPage();page.on("pageerror",e=>report.consoleErrors.push(e.message));page.on("console",m=>{if(m.type()==="error")report.consoleErrors.push(m.text());});page.on("response",r=>{if(r.status()>=400)report.httpErrors.push({path:new URL(r.url()).pathname,status:r.status()});});
 const session={browser,context,page,editor:page.getByRole("region",{name:labels.editor,exact:true}),fixture,report};
 await page.goto("/vod/new");await page.getByRole("button",{name:"復元",exact:true}).click();await expect(session.editor).toBeVisible();await mediaReady(session);
 await waitDocument(session,next=>sameDocument(next,fixture.document));report.fixtures.push({kind,document:fixture.document,setup:"Owned isolated-context synthetic wizard draft; native Restore; real metadata and MP4; no real-profile/token reads"});return session;
}
async function independentMoves(session){
 console.log("Position QA: same-order gaps, overwrite, source invariance and both-edge snapping");
 await moveCase(session,"same-order-video-gap","video",clipId(2),10347);
 await moveCase(session,"same-order-audio-gap-11658ms","audio",clipId(5),7689,7689,{guideMs:7689});
 await moveCase(session,"same-track-overwrite-single-undo","video",clipId(2),7000);
 await moveCase(session,"start-edge-snap","video",clipId(2),7839,7689,{guideMs:7689});
 await moveCase(session,"end-edge-snap","video",clipId(2),9850,10000,{guideMs:18000});
 await moveCase(session,"alt-bypasses-position-snap","video",clipId(2),9850,9850,{alt:true});
}
async function clickAndCancel(session){
 console.log("Position QA: click jitter, activated return, Escape and focus");
 const {page,editor}=session,before=structuredClone(project(session.report,session.fixture.document.id));
 await selectTrack(session,"video");const target=body(session,"video",clipId(2));await target.scrollIntoViewIfNeeded();let box=await target.boundingBox();assert.ok(box);
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+2,box.y+box.height/2);await page.mouse.up();
 await expect.poll(()=>shownStart(session,"video",clipId(2))).toBe(11347);assert.deepEqual(project(session.report,session.fixture.document.id),before);
 await editor.getByRole("slider",{name:"時間目盛り",exact:true}).press("Home");
 const drag=await beginBody(session,"video",clipId(2),11647);await drag.move(11347);await page.mouse.up();
 await expect(editor.getByRole("slider",{name:labels.position,exact:true})).toHaveValue("0");assert.deepEqual(project(session.report,session.fixture.document.id),before,"Activated return changed document");
 await beginBody(session,"video",clipId(2),7000);await expect.poll(()=>shownStart(session,"video",clipId(2))).toBe(7000);
 await page.keyboard.press("Escape");await page.mouse.up();await guide(session,null);
 await expect.poll(()=>shownStart(session,"video",clipId(2))).toBe(11347);assert.deepEqual(project(session.report,session.fixture.document.id),before,"Escape committed the staged move");
 await expect(target).toBeFocused();session.report.clickAndCancel={jitterPx:2,activationPx:12,returnSeekMs:0,escapeRestored:true,focusedClip:clipId(2)};
}
async function unselectedTrim(session,id){
 await selectTrack(session,"audio");await body(session,"audio",clipId(4)).click();
 const target=body(session,"video",id);await expect(target).toHaveAttribute("aria-pressed","false");await target.scrollIntoViewIfNeeded();await target.hover();
 const handle=target.locator("..").locator('[role="slider"][aria-label^="開始を調整,"]');await expect(handle).toBeVisible();
 await expect.poll(()=>handle.evaluate(e=>Number(getComputedStyle(e).opacity))).toBeGreaterThan(0);
 return {target,handle};
}
async function headroomAndLimits(session){
 console.log("Position QA: direct unselected edge, positive headroom and source-zero clamp");
 const {page}=session,before=structuredClone(project(session.report,session.fixture.document.id));
 let {handle}=await unselectedTrim(session,clipId(3)),box=await handle.boundingBox();assert.ok(box);let scale=await pixels(session,"video",clipId(3));
 let x=box.x+box.width/2,y=box.y+box.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+(18150-19347)*scale,y,{steps:4});await guide(session,18000);
 await page.mouse.up();const after=await waitDocument(session,next=>next?.videoClips.some(c=>c.id===clipId(3)&&c.startMs===18000&&c.inMs===0));
 assert.deepEqual(after.audioClips,before.audioClips);assert.equal(after.durationMs,34000);assert.equal(end(after.videoClips.find(c=>c.id===clipId(3))),26000);
 session.report.headroom={before,after,unselectedDirectDrag:true};await mediaReady(session);await undo(session,before);
 ({handle}=await unselectedTrim(session,clipId(2)));box=await handle.boundingBox();assert.ok(box);scale=await pixels(session,"video",clipId(2));
 const title=await handle.getAttribute("title"),cursor=await handle.evaluate(e=>getComputedStyle(e).cursor);assert.ok(title?.trim(),"Source-zero handle needs its limit hint");
 x=box.x+box.width/2;y=box.y+box.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x-500*scale,y,{steps:3});await expect(handle).toHaveAttribute("aria-valuenow","0");await page.mouse.up();
 await expect.poll(()=>shownStart(session,"video",clipId(2))).toBe(11347);assert.deepEqual(project(session.report,session.fixture.document.id),before,"Source-zero trim changed the document");
 session.report.sourceStartLimit={sourceInMs:0,startMs:11347,title,cursor};
}
async function playback(session){
 console.log("Position QA: actual whole-sequence 34-second MP4");
 await session.editor.getByRole("checkbox",{name:"全体をプレビュー",exact:true}).check();
 await expect.poll(()=>session.report.requests.findLast(r=>r.kind==="PREVIEW"&&r.document.id===session.fixture.document.id)?.range.durationMs).toBe(34000);
 const video=await mediaReady(session,34);await session.editor.getByRole("slider",{name:labels.position,exact:true}).press("Home");
 const frames=await video.evaluate(e=>e.getVideoPlaybackQuality().totalVideoFrames);await session.editor.getByRole("button",{name:"再生・一時停止",exact:true}).click();
 await expect.poll(()=>video.evaluate((e,n)=>!e.paused&&e.currentTime>.3&&e.getVideoPlaybackQuality().totalVideoFrames>=n+3,frames),{timeout:5000}).toBe(true);
 await session.editor.getByRole("button",{name:"再生・一時停止",exact:true}).click();await expect.poll(()=>video.evaluate(e=>e.paused&&!e.seeking)).toBe(true);
 session.report.playback=await video.evaluate(e=>({duration:e.duration,readyState:e.readyState,decodedFrames:e.getVideoPlaybackQuality().totalVideoFrames,currentTime:e.currentTime}));
}
async function pairedTargets(browser,report){
 console.log("Position QA: actual-target paired pointer, keyboard and reorder buttons");
 const session=await openFixture(browser,report,"paired"),before=structuredClone(project(report,session.fixture.document.id));
 try {
  const {page,editor}=session;
  const assertPair=async kind=>{
   const after=await waitDocument(session,next=>next?.videoClips[0].id===clipId(12));
   assert.deepEqual(after.videoClips,after.audioClips.slice(0,2),"Actual paired target moved only one track");assert.deepEqual(after.audioClips[2],before.audioClips[2]);assert.equal(after.durationMs,before.durationMs);
   report.paired.push({kind,before,after});await undo(session,before,kind==="pointer");
  };
  await body(session,"audio",clipId(13)).click();
  await beginBody(session,"video",clipId(11),8000,{unlink:false});await page.mouse.up();await assertPair("pointer");
  await body(session,"audio",clipId(13)).click();await body(session,"video",clipId(12)).focus();await body(session,"video",clipId(12)).press("Alt+ArrowLeft");await assertPair("Alt+ArrowLeft");
  await body(session,"video",clipId(12)).click();await editor.getByRole("button",{name:"前へ移動",exact:true}).click();await assertPair("move-earlier");
  await body(session,"video",clipId(11)).click();await editor.getByRole("button",{name:"後へ移動",exact:true}).click();await assertPair("move-later");
 } finally {await session.context.close();}
}
async function screenshots(session,output){
 console.log("Position QA: D34 gaps and snap guides across 3 themes / 4 viewports");
 const {page,context,editor,report}=session;
 for(const theme of ["neon","paper","high-contrast"]){
  if(theme!=="neon"){
   await context.addCookies([{name:"bitovp-theme",value:theme,url:origin}]);await page.reload();await page.getByRole("button",{name:"復元",exact:true}).click();await mediaReady(session);
   await editor.getByRole("checkbox",{name:"全体をプレビュー",exact:true}).check();await mediaReady(session,34);
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme",theme);await editor.getByRole("combobox",{name:"タイムラインのズーム",exact:true}).selectOption("0.25");
  for(const width of [320,768,1024,1440]){
   await page.setViewportSize({width,height:1000});await page.evaluate(async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});
   await beginBody(session,"video",clipId(2),7839);const line=await guide(session,7689),bounds=await line.boundingBox(),labelBounds=await line.locator("span").boundingBox(),viewportBounds=await editor.getByTestId("input-timeline-track").locator("..").boundingBox();assert.ok(bounds&&labelBounds&&viewportBounds);
   const layout=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,page:document.documentElement.scrollWidth}));report.layouts.push({theme,width,...layout,guideMs:7689,guideBounds:bounds,labelBounds,viewportBounds});
   assert.ok(layout.page<=layout.viewport+1,"Page overflows at "+theme+"/"+width);assert.ok(bounds.x>=viewportBounds.x-1&&bounds.x<=viewportBounds.x+viewportBounds.width+1,"Guide outside viewport");assert.ok(labelBounds.x>=viewportBounds.x-1&&labelBounds.x+labelBounds.width<=viewportBounds.x+viewportBounds.width+1,"Guide label clipped");
   await editor.screenshot({path:resolve(output,theme+"-"+width+".png"),animations:"allow"});await page.keyboard.press("Escape");await page.mouse.up();await guide(session,null);
  }
 }
 await writeFile(resolve(output,"accessibility.yaml"),await editor.ariaSnapshot());
}
export async function runPositioningBrowserQa(options){
 assert.equal(options.baseURL,origin);await mkdir(options.output,{recursive:true});
 const report={baseURL:origin,startedAt:new Date().toISOString(),status:"RUNNING",blocked:[],httpErrors:[],consoleErrors:[],requests:[],requestTimes:[],fixtures:[],cases:[],paired:[],layouts:[]};
 const browser=await chromium.launch({headless:true});let session;
 try {
  session=await openFixture(browser,report,"gapped");await independentMoves(session);await clickAndCancel(session);await headroomAndLimits(session);await playback(session);
  report.pacing={limit:30,windowMs:60000,quietMs:60200,postsBefore:report.requests.length,startedAt:Date.now()};console.log("Position QA: quiet window before paired/visual checks; POSTs="+report.requests.length);
  assert.ok(report.requests.length<30,"First native-edit group exceeds the real POST budget");await session.page.waitForTimeout(30100);await session.page.waitForTimeout(30100);report.pacing.finishedAt=Date.now();assert.equal(report.requests.length,report.pacing.postsBefore,"Unexpected POST during quiet window");
  await pairedTargets(browser,report);await screenshots(session,options.output);
  assert.equal(report.blocked.length,0,"Forbidden request attempted");assert.equal(report.httpErrors.length,0,"HTTP error");assert.equal(report.consoleErrors.length,0,"Console error");report.status="PASSED";
 }catch(error){report.status="FAILED";report.error=error.message;if(session)await session.page.screenshot({path:resolve(options.output,"failure.png"),fullPage:true}).catch(()=>{});throw error;}
 finally {
  if(session){await session.page.keyboard.press("Escape").catch(()=>{});await session.page.keyboard.up("Alt").catch(()=>{});await session.page.mouse.up().catch(()=>{});await session.context.close();}
  report.finishedAt=new Date().toISOString();await writeFile(resolve(options.output,"browser-receipt.json"),JSON.stringify(report,null,2)+"\n");await browser.close();console.log(JSON.stringify({status:report.status,output:options.output,cases:report.cases.length,paired:report.paired.length,screenshots:report.layouts.length,blocked:report.blocked.length}));
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runPositioningBrowserQa(parseOptions(process.argv.slice(2)));
