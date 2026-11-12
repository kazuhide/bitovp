#!/usr/bin/env node
/** Real isolated snap QA. Native pointer/keyboard input; preview-only writes. */
import assert from "node:assert/strict";
import {mkdir, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium, expect} from "@playwright/test";
import {parseOptions, requestAllowed} from "./local-browser-qa.mjs";

const origin="http://127.0.0.1:3192";
const labels={editor:"入力タイムライン",video:"入力タイムラインのプレビュー",position:"シーケンスの再生位置",snap:"境界にスナップ"};
const clipEnd=clip=>clip.startMs+clip.outMs-clip.inMs;

export function assertIndependentTrim(before,after,{track,id,edge,expectedMs}) {
 assert.equal(before.schemaVersion,2);assert.equal(after.schemaVersion,2);
 assert.equal(after.id,before.id);assert.equal(after.durationMs,before.durationMs,"Trim changed program duration");
 assert.equal(after.audioEnabled,before.audioEnabled,"Trim changed audio enabled state");
 const key=track==="video"?"videoClips":"audioClips",opposite=track==="video"?"audioClips":"videoClips";
 assert.deepEqual(after[opposite],before[opposite],"Trim changed the opposite track");
 const previous=before[key].find(clip=>clip.id===id),next=after[key].find(clip=>clip.id===id);
 assert.ok(previous&&next,"Trim lost the selected clip");
 assert.equal(next.sourceKey,previous.sourceKey,"Trim changed the selected source");
 assert.ok(Number.isSafeInteger(expectedMs),"Expected boundary must be an integer millisecond");
 if(edge==="in") {
  assert.equal(next.startMs,expectedMs,"Start boundary did not align exactly");
  assert.equal(next.inMs,previous.inMs+expectedMs-previous.startMs,"Trim changed source time incorrectly");
  assert.equal(next.outMs,previous.outMs,"Start trim changed source out");
  assert.equal(clipEnd(next),clipEnd(previous),"Start trim moved the other boundary");
 } else {
  assert.equal(edge,"out");
  assert.equal(clipEnd(next),expectedMs,"End boundary did not align exactly");
  assert.equal(next.startMs,previous.startMs,"End trim moved the other boundary");
  assert.equal(next.inMs,previous.inMs,"End trim changed source in");
 }
 assert.ok(next.inMs>=0&&next.outMs>next.inMs&&clipEnd(next)<=after.durationMs);
}

async function addSource(page,editor,filename,version="v1") {
 await editor.getByRole("button",{name:"素材を追加",exact:true}).click();
 const picker=page.getByRole("dialog",{name:"入力オブジェクトを選択"});
 await picker.locator("#picker-credential").selectOption({label:"VOD timeline local S3 (synthetic only)"});
 await picker.locator("#picker-bucket").selectOption("bitovp-editing-preview");
 for(const folder of ["fixtures/","vod-timeline/",version+"/"])await picker.getByRole("button",{name:folder,exact:true}).click();
 await picker.getByRole("row").filter({has:page.getByText(filename,{exact:true})}).getByRole("button",{name:"入力に使う",exact:true}).click();
 await expect(picker).toBeHidden();
 await expect(editor.getByRole("button",{name:filename+"をタイムラインへ追加"})).toBeEnabled({timeout:120000});
}
async function mediaReady(editor) {
 await expect(editor.getByText("プレビュー準備完了",{exact:true})).toBeVisible({timeout:120000});
 const video=editor.getByLabel(labels.video,{exact:true});
 await expect.poll(()=>video.evaluate(element=>element.readyState),{timeout:30000}).toBeGreaterThanOrEqual(2);
 await expect.poll(()=>video.evaluate(element=>element.duration),{timeout:30000}).toBeCloseTo(8,1);
 return video;
}
function project(report,id) {
 return report.requests.findLast(request=>request.kind==="PREVIEW"&&request.document.id===id)?.document;
}
async function waitProject(report,id,predicate) {
 await expect.poll(()=>predicate(project(report,id)),{timeout:15000}).toBe(true);
 return structuredClone(project(report,id));
}
function handle(editor,track,edge,index=1) {
 return editor.getByRole("slider",{name:`${edge==="in"?"開始":"終了"}を調整, a.mp4, ${track==="audio"?"音声クリップ":"クリップ"} ${index}`,exact:true});
}
async function select(page,editor,track,index=1) {
 await editor.getByRole("button",{name:track==="audio"?"A1を選択":"V1を選択",exact:true}).click();
 await editor.getByRole("button",{name:`${track==="audio"?"音声クリップ":"クリップ"} ${index}, a.mp4`,exact:true}).click();
 await editor.getByRole("slider",{name:"時間目盛り",exact:true}).press("Home");
}
async function beginTrim(page,editor,track,edge,index,fromMs,toMs) {
 const target=handle(editor,track,edge,index);
 await target.scrollIntoViewIfNeeded();
 const bounds=await target.boundingBox();assert.ok(bounds);
 const first=await editor.getByRole("button",{name:"クリップ 1, a.mp4",exact:true}).boundingBox();assert.ok(first);
 const pixelsPerMs=first.width/4000;
 const x=bounds.x+bounds.width/2,y=bounds.y+bounds.height/2;
 await page.mouse.move(x,y);await page.mouse.down();
 await page.mouse.move(x+(toMs-fromMs)*pixelsPerMs,y);
 return {target,pixelsPerMs,x,y,fromMs,move:async ms=>page.mouse.move(x+(ms-fromMs)*pixelsPerMs,y)};
}
async function guide(editor,time) {
 const line=editor.getByTestId("input-timeline-snap-guide");
 if(time===null)await expect(line).toHaveCount(0);
 else await expect(line).toHaveAttribute("data-snap-ms",String(time));
 return line;
}
async function undo(editor,report,id,before) {
 await editor.getByRole("button",{name:"元に戻す",exact:true}).click();
 await waitProject(report,id,next=>JSON.stringify(next)===JSON.stringify(before));
 await mediaReady(editor);
}
async function releaseAndCheck(page,editor,report,id,before,edit) {
 await page.mouse.up();await guide(editor,null);
 const after=await waitProject(report,id,next=>{
  const clip=next?.[edit.track==="video"?"videoClips":"audioClips"].find(item=>item.id===edit.id);
  return clip&&(edit.edge==="in"?clip.startMs:clipEnd(clip))===edit.expectedMs;
 });
 assertIndependentTrim(before,after,edit);await mediaReady(editor);
 return after;
}
async function snapTrims(page,editor,report,id) {
 console.log("Snap QA: independent A1 end/start, hysteresis, toggle and Alt");
 await select(page,editor,"audio");const before=structuredClone(project(report,id)),audioId=before.audioClips[0].id;
 let drag=await beginTrim(page,editor,"audio","out",1,8000,4150);
 const line=await guide(editor,4000);
 await expect(drag.target).toHaveAttribute("aria-valuenow","4000");
 await editor.screenshot({path:resolve(report.output,"audio-out-snapped.png"),animations:"allow"});
 report.guide={timeMs:4000,text:await line.innerText(),bounds:await line.boundingBox()};
 report.cases.push({kind:"audio-out",before,after:await releaseAndCheck(page,editor,report,id,before,{track:"audio",id:audioId,edge:"out",expectedMs:4000})});
 await undo(editor,report,id,before);
 drag=await beginTrim(page,editor,"audio","in",1,0,3850);await guide(editor,4000);
 report.cases.push({kind:"audio-in",before,after:await releaseAndCheck(page,editor,report,id,before,{track:"audio",id:audioId,edge:"in",expectedMs:4000})});
 await undo(editor,report,id,before);
 drag=await beginTrim(page,editor,"audio","out",1,8000,4150);await guide(editor,4000);
 await drag.move(4250);await guide(editor,4000);await expect(drag.target).toHaveAttribute("aria-valuenow","4000");
 await drag.move(4325);await guide(editor,null);await expect(drag.target).toHaveAttribute("aria-valuenow","4325");
 await page.keyboard.press("Escape");await page.mouse.up();await guide(editor,null);
 assert.deepEqual(project(report,id),before,"Canceled hysteresis edit committed");report.hysteresis={capturePx:6,retainedPx:10,releasedPx:13,canceled:true};
 const toggle=editor.getByRole("button",{name:labels.snap,exact:true});
 await toggle.click();await expect(toggle).toHaveAttribute("aria-pressed","false");
 for(const kind of ["toggle-off","alt-held"]) {
  if(kind==="alt-held"){await toggle.click();await page.keyboard.down("Alt");}
  try {
   drag=await beginTrim(page,editor,"audio","out",1,8000,4150);await guide(editor,null);
   await expect(drag.target).toHaveAttribute("aria-valuenow","4150");
   report.cases.push({kind,before,after:await releaseAndCheck(page,editor,report,id,before,{track:"audio",id:audioId,edge:"out",expectedMs:4150})});
  } finally {await page.keyboard.up("Alt");}
  await undo(editor,report,id,before);
 }
 await expect(toggle).toHaveAttribute("aria-pressed","true");
 drag=await beginTrim(page,editor,"audio","out",1,8000,4150);await guide(editor,4000);
 await page.keyboard.down("Alt");await guide(editor,null);await expect(drag.target).toHaveAttribute("aria-valuenow","4150");
 await page.keyboard.up("Alt");await guide(editor,4000);await expect(drag.target).toHaveAttribute("aria-valuenow","4000");
 report.cases.push({kind:"alt-mid-gesture",before,after:await releaseAndCheck(page,editor,report,id,before,{track:"audio",id:audioId,edge:"out",expectedMs:4000})});
 await undo(editor,report,id,before);
 console.log("Snap QA: constant screen-distance capture at 4x zoom");
 await editor.getByRole("combobox",{name:"タイムラインのズーム",exact:true}).selectOption("4");
 for(const [raw,expected] of [[4040,4000],[4100,4100]]) {
  drag=await beginTrim(page,editor,"audio","out",1,8000,raw);await guide(editor,expected===4000?4000:null);
  report.cases.push({kind:"zoom-4-raw-"+raw,before,after:await releaseAndCheck(page,editor,report,id,before,{track:"audio",id:audioId,edge:"out",expectedMs:expected})});
  await undo(editor,report,id,before);
 }
 await editor.getByRole("combobox",{name:"タイムラインのズーム",exact:true}).selectOption("1");
}
async function splitAt(editor,ms,modifiers=[]) {
 await editor.getByRole("slider",{name:"時間目盛り",exact:true}).click({position:{x:ms*.04,y:14},modifiers});
 await editor.getByRole("button",{name:"再生位置で分割",exact:true}).click();
}
async function reverseAndPrecise(page,editor,report,id) {
 console.log("Snap QA: V1 start/end follow A1 and precise edits bypass snapping");
 const base=structuredClone(project(report,id));
 await select(page,editor,"audio");await splitAt(editor,5000);
 const before=await waitProject(report,id,next=>next?.audioClips.length===2);
 for(const [edge,index,from,raw] of [["out",1,4000,4850],["in",2,4000,5150]]) {
  await select(page,editor,"video",index);
  const clip=before.videoClips[index-1];
  await beginTrim(page,editor,"video",edge,index,from,raw);await guide(editor,5000);
  report.cases.push({kind:"video-"+edge,before,after:await releaseAndCheck(page,editor,report,id,before,{track:"video",id:clip.id,edge,expectedMs:5000})});
  await undo(editor,report,id,before);
 }
 await undo(editor,report,id,base);await select(page,editor,"audio");
 const end=handle(editor,"audio","out");await end.press("ArrowLeft");
 const keyboard=await waitProject(report,id,next=>next?.audioClips[0]?.outMs===7999);
 assertIndependentTrim(base,keyboard,{track:"audio",id:base.audioClips[0].id,edge:"out",expectedMs:7999});
 await guide(editor,null);await undo(editor,report,id,base);
 const input=editor.getByRole("spinbutton",{name:"開始（秒）",exact:true});
 await input.fill("3.9");await input.press("Tab");
 const numeric=await waitProject(report,id,next=>next?.audioClips[0]?.startMs===3900);
 assertIndependentTrim(base,numeric,{track:"audio",id:base.audioClips[0].id,edge:"in",expectedMs:3900});
 await undo(editor,report,id,base);
 const position=editor.getByRole("slider",{name:labels.position,exact:true});
 await position.press("Home");await position.press("ArrowRight");await expect(position).toHaveValue("1");
 report.precise={keyboardOutMs:7999,numericInMs:3900,sliderMs:Number(await position.inputValue())};
 console.log("Snap QA: ruler snap feeds the exact split and plays actual MP4");
 const ruler=editor.getByRole("slider",{name:"時間目盛り",exact:true});
 await ruler.click({position:{x:4150*.04,y:14},modifiers:["Alt"]});await expect(position).toHaveValue("4150");
 await ruler.click({position:{x:4150*.04,y:14}});await expect(position).toHaveValue("4000");
 await editor.getByRole("button",{name:"再生位置で分割",exact:true}).click();
 const split=await waitProject(report,id,next=>next?.audioClips.length===2);
 assert.equal(clipEnd(split.audioClips[0]),4000);assert.equal(split.audioClips[1].startMs,4000);
 assert.deepEqual(split.videoClips,base.videoClips);report.rulerSplit={rawMs:4150,altMs:4150,snappedMs:4000,document:split};
 const video=await mediaReady(editor);await position.press("Home");
 const frames=await video.evaluate(element=>element.getVideoPlaybackQuality().totalVideoFrames);
 await editor.getByRole("button",{name:"再生・一時停止",exact:true}).click();
 await expect.poll(()=>video.evaluate((element,n)=>!element.paused&&element.currentTime>.3&&element.getVideoPlaybackQuality().totalVideoFrames>=n+3,frames),{timeout:5000}).toBe(true);
 await editor.getByRole("button",{name:"再生・一時停止",exact:true}).click();
 report.playback=await video.evaluate(element=>({duration:element.duration,readyState:element.readyState,decodedFrames:element.getVideoPlaybackQuality().totalVideoFrames}));
 await expect.poll(()=>video.evaluate(element=>element.paused&&!element.seeking)).toBe(true);
}
async function layouts(page,context,editor,report) {
 console.log("Snap QA: active snap guides in 3 themes and 4 viewport widths");
 for(const theme of ["neon","paper","high-contrast"]) {
  if(theme!=="neon") {
   await context.addCookies([{name:"bitovp-theme",value:theme,url:origin}]);
   await page.reload();await page.getByRole("button",{name:"復元",exact:true}).click();await mediaReady(editor);
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme",theme);
  await select(page,editor,"audio");
  await expect(editor.getByRole("button",{name:labels.snap,exact:true})).toHaveAttribute("aria-pressed","true");
  for(const width of [320,768,1024,1440]) {
   await page.setViewportSize({width,height:1000});
   await page.evaluate(async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});
   await beginTrim(page,editor,"audio","out",1,4000,4150);
   const line=await guide(editor,4000);await expect(line).toBeVisible();
   const bounds=await line.boundingBox(),viewport=await editor.getByTestId("input-timeline-track").locator("..").boundingBox();assert.ok(bounds&&viewport);
   assert.ok(bounds.x>=viewport.x-1&&bounds.x<=viewport.x+viewport.width+1,"Snap guide is outside the scrolled viewport at "+theme+"/"+width);
   await editor.screenshot({path:resolve(report.output,theme+"-"+width+".png"),animations:"allow"});
   const layout=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,page:document.documentElement.scrollWidth}));
   assert.ok(layout.page<=layout.viewport+1,"Page overflows at "+theme+"/"+width);
   report.layouts.push({theme,width,...layout,guideMs:Number(await line.getAttribute("data-snap-ms"))});
   await page.keyboard.press("Escape");await page.mouse.up();await guide(editor,null);
  }
 }
}
export async function runSnappingBrowserQa(options) {
 assert.equal(options.baseURL,origin);await mkdir(options.output,{recursive:true});
 const report={baseURL:origin,output:options.output,startedAt:new Date().toISOString(),status:"RUNNING",blocked:[],httpErrors:[],consoleErrors:[],requests:[],cases:[],layouts:[]};
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({baseURL:origin,viewport:{width:1440,height:1000},locale:"ja-JP",serviceWorkers:"block"});
 await context.addCookies([{name:"ovp-locale",value:"ja",url:origin}]);
 await context.route("**/*",async route=>{
  const request=route.request();
  if(!requestAllowed(request.url(),request.method(),origin)){report.blocked.push({method:request.method(),path:new URL(request.url()).pathname});return route.abort();}
  if(request.method()==="POST")report.requests.push(JSON.parse(request.postData()??"null"));
  return route.continue();
 });
 const page=await context.newPage();
 page.on("pageerror",error=>report.consoleErrors.push(error.message));
 page.on("console",message=>{if(message.type()==="error")report.consoleErrors.push(message.text());});
 page.on("response",response=>{if(response.status()>=400)report.httpErrors.push({path:new URL(response.url()).pathname,status:response.status()});});
 try {
  await page.goto("/vod/new");
  await page.getByRole("navigation",{name:"ウィザードのステップ"}).getByRole("button",{name:/^2\./}).click();
  await page.getByRole("button",{name:"タイムラインで編集",exact:true}).click();
  const editor=page.getByRole("region",{name:labels.editor,exact:true});
  await expect(editor.getByRole("button",{name:labels.snap,exact:true})).toHaveAttribute("aria-pressed","true");
  console.log("Snap QA: preparing real synthetic A/B/WAV through storage picker");
  await addSource(page,editor,"a.mp4");await editor.getByRole("button",{name:"a.mp4をタイムラインへ追加"}).click();await mediaReady(editor);
  const id=report.requests.findLast(request=>request.kind==="PREVIEW").document.id;report.projectId=id;
  await addSource(page,editor,"b.mp4");await addSource(page,editor,"c.wav","v2");await mediaReady(editor);
  await select(page,editor,"video");await splitAt(editor,4000);
  await waitProject(report,id,next=>next?.videoClips.length===2&&next.audioClips.length===1);
  await snapTrims(page,editor,report,id);await reverseAndPrecise(page,editor,report,id);
  await layouts(page,context,editor,report);
  await writeFile(resolve(options.output,"accessibility.yaml"),await editor.ariaSnapshot());
  assert.equal(report.blocked.length,0,"Forbidden request attempted");assert.equal(report.httpErrors.length,0,"HTTP error");assert.equal(report.consoleErrors.length,0,"Browser console error");
  report.status="PASSED";
 } catch(error) {
  report.status="FAILED";report.error=error.message;
  await page.screenshot({path:resolve(options.output,"failure.png"),fullPage:true}).catch(()=>{});throw error;
 } finally {
  await page.keyboard.up("Alt").catch(()=>{});await page.mouse.up().catch(()=>{});
  report.finishedAt=new Date().toISOString();await writeFile(resolve(options.output,"browser-receipt.json"),JSON.stringify(report,null,2)+"\n");
  await context.close();await browser.close();
  console.log(JSON.stringify({status:report.status,output:options.output,cases:report.cases.length,screenshots:report.layouts.length,blocked:report.blocked.length}));
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runSnappingBrowserQa(parseOptions(process.argv.slice(2)));
