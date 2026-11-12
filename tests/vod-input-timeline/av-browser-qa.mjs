#!/usr/bin/env node
/** Real isolated AV overwrite QA: owned Chromium, real API/Worker/FFmpeg/S3 only. */
import assert from "node:assert/strict";
import {mkdir, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium, expect} from "@playwright/test";
import {parseOptions, requestAllowed} from "./local-browser-qa.mjs";

const origin="http://127.0.0.1:3192";
const content={editor:"入力タイムライン",video:"入力タイムラインのプレビュー",play:"再生・一時停止"};
function outsideCoverage(document,track,startMs,endMs) {
 const clips=document[track==="video"?"videoClips":"audioClips"],result=[];
 for(const [low,high] of [[0,startMs],[endMs,document.durationMs]]) for(const clip of clips) {
  const start=Math.max(low,clip.startMs),end=Math.min(high,clip.startMs+clip.outMs-clip.inMs);
  if(end>start)result.push({sourceKey:clip.sourceKey,startMs:start,endMs:end,inMs:clip.inMs+start-clip.startMs,outMs:clip.inMs+end-clip.startMs});
 }
 return result;
}
export function assertTrackOverwrite(before,after,{track,startMs,endMs,sourceKey,inMs}) {
 assert.equal(before.schemaVersion,2);assert.equal(after.schemaVersion,2);
 assert.equal(after.id,before.id);assert.equal(after.durationMs,before.durationMs,"Overwrite changed program duration");
 const opposite=track==="video"?"audioClips":"videoClips";
 assert.deepEqual(after[opposite],before[opposite],"Overwrite changed the opposite track");
 assert.deepEqual(outsideCoverage(after,track,startMs,endMs),outsideCoverage(before,track,startMs,endMs),"Overwrite changed source time outside the selected interval");
 const clips=after[track==="video"?"videoClips":"audioClips"];
 const replacement=clips.find(clip=>clip.startMs===startMs&&clip.sourceKey===sourceKey);
 assert.ok(replacement,"Replacement does not begin at the selected global position");
 assert.equal(replacement.inMs,inMs);assert.equal(replacement.outMs,inMs+endMs-startMs);
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
async function mediaReady(editor,duration) {
 await expect(editor.getByText("プレビュー準備完了",{exact:true})).toBeVisible({timeout:120000});
 const video=editor.getByLabel(content.video,{exact:true});
 await expect.poll(()=>video.evaluate(element=>element.readyState),{timeout:30000}).toBeGreaterThanOrEqual(2);
 await expect.poll(()=>video.evaluate(element=>element.duration),{timeout:30000}).toBeCloseTo(duration,1);
 return video;
}
function sourceKeyFor(report,filename) {
 const reference=report.requests.findLast(request=>request.kind==="PROBE"&&request.sources.some(source=>source.objectKey.endsWith("/"+filename)))?.sources.find(source=>source.objectKey.endsWith("/"+filename));
 assert.ok(reference,"Selected source reference is missing: "+filename);return reference.key;
}
function latestProject(report,id) {
 return report.requests.findLast(request=>request.kind==="PREVIEW"&&request.document.id===id)?.document;
}
async function splitAt(editor,seconds) {
 const ruler=editor.getByRole("slider",{name:"時間目盛り",exact:true});
 await ruler.click({position:{x:seconds*40,y:14}});
 await editor.getByRole("button",{name:"再生位置で分割",exact:true}).click();
}
async function sourceRange(editor,start,end) {
 const input=editor.getByRole("spinbutton",{name:"素材の開始（秒）"});
 await input.fill(String(start));await input.press("Tab");
 const output=editor.getByRole("spinbutton",{name:"素材の終了（秒）"});
 await output.fill(String(end));await output.press("Tab");
}
async function chooseMiddle(editor,track) {
 const label=track==="audio"?"音声クリップ":"クリップ";
 await editor.getByRole("button",{name:label+" 2, a.mp4",exact:true}).click();
}
async function overwrite(editor,filename) {
 await editor.getByRole("button",{name:filename+"をプレビュー",exact:true}).click();
 await sourceRange(editor,1,5);
 await expect(editor.getByRole("button",{name:"選択区間を差し替え",exact:true})).toBeEnabled();
 await editor.getByRole("button",{name:"選択区間を差し替え",exact:true}).click();
 await mediaReady(editor,8);
}
async function playPause(editor,video) {
 const before=await video.evaluate(element=>({frames:element.getVideoPlaybackQuality().totalVideoFrames,duration:element.duration}));
 await editor.getByRole("button",{name:content.play,exact:true}).click();
 await expect.poll(()=>video.evaluate((element,frames)=>!element.paused&&element.currentTime>.3&&element.getVideoPlaybackQuality().totalVideoFrames>=frames+3,before.frames),{timeout:5000}).toBe(true);
 await editor.getByRole("button",{name:content.play,exact:true}).click();
 await expect.poll(()=>video.evaluate(element=>element.paused&&!element.seeking&&element.readyState>=3)).toBe(true);
 return video.evaluate((element,previous)=>({...previous,readyState:element.readyState,decodedFrames:element.getVideoPlaybackQuality().totalVideoFrames,currentTime:element.currentTime,videoWidth:element.videoWidth,videoHeight:element.videoHeight}),before);
}
async function screenshots(page,context,editor,output,report) {
 for(const theme of ["neon","paper","high-contrast"]) {
  if(theme!=="neon") {
   await context.addCookies([{name:"bitovp-theme",value:theme,url:page.url()}]);
   await page.reload();await page.getByRole("button",{name:"復元",exact:true}).click();
   await expect(editor).toBeVisible();await mediaReady(editor,8);
  }
  await editor.getByRole("button",{name:"音声クリップ 2, c.wav",exact:true}).click();
  await editor.getByRole("button",{name:"c.wavをプレビュー",exact:true}).click();
  await sourceRange(editor,1,5);
  const video=await mediaReady(editor,8);
  report.visualMedia.push({theme,...await playPause(editor,video)});
  await expect(page.locator("html")).toHaveAttribute("data-theme",theme);
  for(const width of [320,768,1024,1440]) {
   await page.setViewportSize({width,height:1000});
   await page.evaluate(async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});
   await video.hover();await editor.screenshot({path:resolve(output,theme+"-"+width+".png"),animations:"allow"});
   const layout=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,page:document.documentElement.scrollWidth}));
   assert.ok(layout.page<=layout.viewport+1,"Page overflows at "+theme+"/"+width);
   report.layouts.push({theme,width,...layout});
  }
 }
}
export async function runAvBrowserQa(options) {
 assert.equal(options.baseURL,origin);
 await mkdir(options.output,{recursive:true});
 const report={baseURL:origin,startedAt:new Date().toISOString(),status:"RUNNING",blocked:[],httpErrors:[],consoleErrors:[],requests:[],tasks:[],overwrites:[],layouts:[],visualMedia:[]};
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
 page.on("response",async response=>{
  const path=new URL(response.url()).pathname;
  if(response.status()>=400)report.httpErrors.push({path,status:response.status()});
  if(/^\/api\/vod\/input-previews(?:\/[0-9a-f-]{36})?$/.test(path)&&response.ok())try{const value=await response.json();if(value.task)report.tasks.push(value.task);}catch{}
 });
 try {
  await page.goto("/vod/new");
  await page.getByRole("navigation",{name:"ウィザードのステップ"}).getByRole("button",{name:/^2\./}).click();
  await page.getByRole("button",{name:"タイムラインで編集",exact:true}).click();
  const editor=page.getByRole("region",{name:content.editor,exact:true});
  console.log("AV QA: selecting actual A/B sources");
  await addSource(page,editor,"a.mp4");await editor.getByRole("button",{name:"a.mp4をタイムラインへ追加"}).click();await mediaReady(editor,8);
  const firstRequest=report.requests.findLast(request=>request.kind==="PREVIEW");
  assert.ok(firstRequest);const projectId=firstRequest.document.id;
  await addSource(page,editor,"b.mp4");await mediaReady(editor,8);
  const original=structuredClone(latestProject(report,projectId));
  const bKey=sourceKeyFor(report,"b.mp4");
  assert.equal(original.videoClips.length,1);assert.equal(original.audioClips.length,1);
  await editor.getByRole("button",{name:"V1 / A1のリンクを解除",exact:true}).click();
  console.log("AV QA: splitting only A1 and replacing its middle");
  await editor.getByRole("button",{name:"音声クリップ 1, a.mp4",exact:true}).click();
  await splitAt(editor,2);await splitAt(editor,6);await chooseMiddle(editor,"audio");
  await overwrite(editor,"b.mp4");
  await expect.poll(()=>latestProject(report,projectId)?.audioClips.some(clip=>clip.sourceKey===bKey)).toBe(true);
  const audioOverwrite=structuredClone(latestProject(report,projectId));
  assertTrackOverwrite(original,audioOverwrite,{track:"audio",startMs:2000,endMs:6000,sourceKey:bKey,inMs:1000});
  report.overwrites.push({kind:"audio-only",before:original,after:audioOverwrite});
  for(let undo=0;undo<3;undo++)await editor.getByRole("button",{name:"元に戻す",exact:true}).click();
  await expect(editor.getByRole("button",{name:/^音声クリップ \d, /})).toHaveCount(1);
  console.log("AV QA: splitting only V1 while keeping A1 uninterrupted");
  await editor.getByRole("button",{name:"クリップ 1, a.mp4",exact:true}).click();
  await splitAt(editor,2);await splitAt(editor,6);await chooseMiddle(editor,"video");
  await overwrite(editor,"b.mp4");
  await expect.poll(()=>latestProject(report,projectId)?.videoClips.some(clip=>clip.sourceKey===bKey)).toBe(true);
  const videoOverwrite=structuredClone(latestProject(report,projectId));
  assertTrackOverwrite(original,videoOverwrite,{track:"video",startMs:2000,endMs:6000,sourceKey:bKey,inMs:1000});
  report.overwrites.push({kind:"video-only",before:original,after:videoOverwrite});
  console.log("AV QA: actual WAV audition and A1 overwrite");
  await addSource(page,editor,"c.wav","v2");
  await editor.getByRole("button",{name:"c.wavをプレビュー",exact:true}).click();
  await mediaReady(editor,8);
  const cKey=sourceKeyFor(report,"c.wav");
  const freshSource=report.requests.findLast(request=>request.kind==="PREVIEW"&&request.document.id!==projectId&&request.document.audioClips?.[0]?.sourceKey===cKey);
  assert.ok(freshSource);assert.equal(freshSource.document.videoClips.length,0);assert.equal(freshSource.document.audioClips.length,1);
  assert.equal(freshSource.document.audioEnabled,true);assert.notEqual(freshSource.document.id,projectId);
  report.audioOnlySourcePreview=freshSource;
  await editor.getByRole("button",{name:"A1を選択",exact:true}).click();
  await editor.getByRole("button",{name:"音声クリップ 1, a.mp4",exact:true}).click();
  await splitAt(editor,2);await splitAt(editor,6);await chooseMiddle(editor,"audio");
  await overwrite(editor,"c.wav");
  await expect.poll(()=>latestProject(report,projectId)?.audioClips[1]?.sourceKey===cKey).toBe(true);
  const wavOverwrite=structuredClone(latestProject(report,projectId));
  const wavKey=freshSource.document.audioClips[0].sourceKey;
  assertTrackOverwrite(videoOverwrite,wavOverwrite,{track:"audio",startMs:2000,endMs:6000,sourceKey:wavKey,inMs:1000});
  report.overwrites.push({kind:"wav-audio-only",before:videoOverwrite,after:wavOverwrite});
  assert.equal(await editor.getByText("タイムラインの操作",{exact:true}).count(),0);
  console.log("AV QA: Japanese source-range controls across themes and viewports");
  await screenshots(page,context,editor,options.output,report);
  await writeFile(resolve(options.output,"accessibility.yaml"),await editor.ariaSnapshot());
  assert.equal(report.blocked.length,0,"Forbidden request attempted");assert.equal(report.httpErrors.length,0,"HTTP error");assert.equal(report.consoleErrors.length,0,"Browser console error");
  report.status="PASSED";
 } catch(error) {
  report.status="FAILED";report.error=error.message;
  await page.screenshot({path:resolve(options.output,"failure.png"),fullPage:true}).catch(()=>{});throw error;
 } finally {
  report.finishedAt=new Date().toISOString();await writeFile(resolve(options.output,"browser-receipt.json"),JSON.stringify(report,null,2)+"\n");
  await context.close();await browser.close();
  console.log(JSON.stringify({status:report.status,output:options.output,screenshots:report.layouts.length,overwrites:report.overwrites.length,blocked:report.blocked.length}));
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runAvBrowserQa(parseOptions(process.argv.slice(2)));
