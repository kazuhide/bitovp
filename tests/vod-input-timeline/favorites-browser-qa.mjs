#!/usr/bin/env node
/** Owned fixed-input QA. Only the dedicated loopback and three synthetic objects. */
import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium,expect} from "@playwright/test";
import {parseOptions,requestAllowed} from "./local-browser-qa.mjs";

const origin="http://127.0.0.1:3192",favoritePath="/api/vod/input-favorites";
const credentialId="928d0a9c-3217-4d54-ad2f-8eaa946274c8",bucket="bitovp-editing-preview",prefix="fixtures/vod-favorites-merge/v1/";
const syntheticAccount={id:"30000000-0000-4000-8000-000000000001",label:"Favorites QA synthetic account (never submitted)",internalHevcV2:false};
const draftKey='bitovp.wizard-draft:["00000000-0000-4000-8000-000000000001","main:none","vod","new"]';
// Read-only fixture: exercise the real parent Start gate without storing API keys
// or an account, and without ever submitting an encoding or preset write.
export function favoriteSyntheticRead(url,method){
 const u=new URL(url);return u.origin===origin&&!u.username&&!u.password&&!u.hash&&!u.search&&method==="GET"&&u.pathname==="/api/bitmovin-accounts"?[{...syntheticAccount}]:null;
}
export const favoriteFixtures=[
 {filename:"merge-qa-video.mp4",label:"merge-qa-video.mp4",kind:"VIDEO"},
 {filename:"merge-qa-audio.wav",label:"merge-qa-audio.wav",kind:"AUDIO"},
 {filename:"merge-qa-logo.png",label:"Merge QA固定素材 ロゴ",kind:"IMAGE"},
].map(f=>({...f,credentialId,bucket,objectKey:prefix+f.filename}));
export function favoriteRequestAllowed(url,method,body=null,ownedIds=new Set()) {
 const u=new URL(url);if(u.origin!==origin||u.username||u.password||u.hash)return false;
 if(method==="POST"&&u.pathname===favoritePath){
  if(u.search)return false;
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).sort().join(",")!=="bucket,credentialId,kind,label,objectKey")return false;
  return favoriteFixtures.some(f=>["credentialId","bucket","kind","label","objectKey"].every(k=>body[k]===f[k]));
 }
 if(method==="DELETE"&&u.pathname.startsWith(favoritePath+"/")){
  const id=u.pathname.slice(favoritePath.length+1);return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)&&ownedIds.has(id)&&!u.search;
 }
 return requestAllowed(url,method,origin);
}
export function assertNoImageProbes(requests){
 for(const r of requests.filter(v=>v.kind==="PROBE"))for(const source of r.sources){
  assert.notEqual(source.objectKey,prefix+"merge-qa-logo.png","Output logo entered AV PROBE");
  assert.notEqual(source.purpose,"FILTER_IMAGE","FILTER_IMAGE entered AV PROBE");
 }
}
export function assertFavoriteCopyPreserved(before,after){
 assert.deepEqual(after.inputFiles,before.inputFiles,"Favorite removal changed copied input references");
 assert.deepEqual(after.inputTimeline,before.inputTimeline,"Favorite removal changed timeline clips");
 assert.deepEqual(after.logo,before.logo,"Favorite removal changed copied output logo");
}

const fixture=(kind)=>favoriteFixtures.find(f=>f.kind===kind);
const useName=f=>f.kind==="IMAGE"?f.label+"を出力ロゴに使用":f.label+"を素材へ追加";
const removeName=f=>f.label+"を固定素材から外す";
const editorOf=page=>page.getByRole("region",{name:"入力タイムライン",exact:true});
const mediaRequests=report=>report.requests.filter(r=>r.kind==="PROBE"||r.kind==="PREVIEW");
async function step(page,n){await page.getByRole("navigation",{name:"ウィザードのステップ"}).getByRole("button",{name:new RegExp("^"+n+"\\.")}).click();}
async function enterEditor(page){await step(page,2);await page.getByRole("button",{name:"タイムラインで編集",exact:true}).click();await expect(editorOf(page)).toBeVisible();return editorOf(page);}
async function ownDraft(page){
 return page.evaluate(key=>{
  const value=JSON.parse(localStorage.getItem(key)??"null")?.value;if(!value)return null;
  return {inputFiles:(value.inputFiles??[]).map(f=>Object.fromEntries(["key","inputKey","kind","credentialId","bucket","path","purpose"].filter(k=>k in f).map(k=>[k,f[k]]))),inputTimeline:value.inputTimeline??null,logo:null};
 },draftKey);
}
async function ready(page,duration=8){
 const editor=editorOf(page);await expect(editor.getByText("プレビュー準備完了",{exact:true})).toBeVisible({timeout:120000});
 const video=editor.getByLabel("入力タイムラインのプレビュー",{exact:true});await expect.poll(()=>video.evaluate(e=>e.readyState),{timeout:30000}).toBeGreaterThanOrEqual(2);
 assert.ok(Math.abs(await video.evaluate(e=>e.duration)-duration)<.12,"Actual MP4 duration differs");return video;
}
async function pickOwned(page,filename){
 const picker=page.getByRole("dialog").filter({has:page.locator("#picker-credential")});await expect(picker).toBeVisible();
 await picker.locator("#picker-credential").selectOption({label:"VOD timeline local S3 (synthetic only)"});await picker.locator("#picker-bucket").selectOption(bucket);
 for(const folder of ["fixtures/","vod-favorites-merge/","v1/"])await picker.getByRole("button",{name:folder,exact:true}).click();
 await picker.getByRole("row").filter({has:page.getByText(filename,{exact:true})}).getByRole("button",{name:"入力に使う",exact:true}).click();await expect(picker).toBeHidden();
}
async function addInput(page,f){
 const editor=editorOf(page);await editor.getByRole("button",{name:"素材を追加",exact:true}).click();await pickOwned(page,f.filename);
 await expect(editor.getByRole("button",{name:f.filename+"をタイムラインへ追加",exact:true})).toBeEnabled({timeout:120000});
}
async function saveLoaded(page,report,f){
 await editorOf(page).getByRole("button",{name:f.filename+"を固定素材へ保存",exact:true}).click();
 await expect.poll(()=>report.saved.some(v=>v.objectKey===f.objectKey)).toBe(true);
 await expect(editorOf(page).getByRole("button",{name:useName(f),exact:true})).toBeEnabled();
 await expect(editorOf(page).getByRole("button",{name:f.filename+"は固定素材に保存済み",exact:true})).toBeDisabled();
}
async function saveImage(page,report){
 const f=fixture("IMAGE"),count=mediaRequests(report).filter(v=>v.kind==="PROBE").length;
 await editorOf(page).getByRole("button",{name:"固定素材を追加",exact:true}).click();await pickOwned(page,f.filename);
 const dialog=page.getByRole("dialog",{name:"固定素材を保存",exact:true});await expect(dialog).toBeVisible();await expect(dialog.getByRole("combobox",{name:"素材の種類",exact:true})).toHaveValue("IMAGE");
 await dialog.getByRole("textbox",{name:"表示名",exact:true}).fill(f.label);await dialog.getByRole("button",{name:"保存",exact:true}).click();await expect(dialog).toBeHidden();
 await expect.poll(()=>report.saved.some(v=>v.objectKey===f.objectKey)).toBe(true);await expect(editorOf(page).getByRole("button",{name:useName(f),exact:true})).toBeEnabled();
 assert.equal(mediaRequests(report).filter(v=>v.kind==="PROBE").length,count,"Saving a logo favorite triggered AV PROBE");report.imageRegistration={avProbeUnchanged:true};
}
async function nativeNewVod(page,report,fault){
 await expect.poll(async()=>!!(await ownDraft(page))?.inputTimeline?.videoClips?.length).toBe(true);
 const before=await ownDraft(page);await page.locator('a[href="/vod/jobs"]').first().click();await expect(page).toHaveURL(origin+"/vod/jobs");
 await page.getByRole("link",{name:"VOD ジョブを作成",exact:true}).click();await expect(page).toHaveURL(origin+"/vod/new");
 await page.getByRole("button",{name:"破棄",exact:true}).click();
 const probesBefore=mediaRequests(report).filter(v=>v.kind==="PROBE").length;fault.mode="invalid-list";await enterEditor(page);
 const alert=editorOf(page).getByRole("alert").filter({hasText:"固定素材を読み込めませんでした"});await expect(alert).toBeVisible();
 await expect(editorOf(page).getByText("固定素材はありません",{exact:true})).toHaveCount(0);await expect(editorOf(page).getByRole("button",{name:"固定素材を追加",exact:true})).toBeDisabled();
 fault.mode=null;await alert.getByRole("button",{name:"再試行",exact:true}).click();
 for(const f of favoriteFixtures)await expect(editorOf(page).getByRole("button",{name:useName(f),exact:true})).toBeVisible();
 await expect(editorOf(page).getByRole("button",{name:useName(fixture("VIDEO")),exact:true})).toBeEnabled();
 const logo=editorOf(page).getByRole("button",{name:useName(fixture("IMAGE")),exact:true});await expect(logo).toBeDisabled();await expect(logo).toHaveAttribute("title","先に映像素材を追加してください");
 assert.equal(mediaRequests(report).filter(v=>v.kind==="PROBE").length,probesBefore,"Unused favorites triggered a media probe");
 await expect(editorOf(page).getByRole("button",{name:/^クリップ \d, /})).toHaveCount(0);
 report.nativeNew={previousProjectId:before.inputTimeline.id,unusedFavoritesDidNotProbe:true,emptyLogoDisabled:true,injectedInvalidListHandled:true};
}
async function useMedia(page,report){
 for(const kind of ["VIDEO","AUDIO"]){
  const f=fixture(kind),count=report.requests.filter(v=>v.kind==="PROBE").length;
  await editorOf(page).getByRole("button",{name:useName(f),exact:true}).click();
  await expect.poll(()=>report.requests.filter(v=>v.kind==="PROBE").length).toBeGreaterThan(count);
  assert.ok(report.requests.findLast(v=>v.kind==="PROBE").sources.some(s=>s.objectKey===f.objectKey));
  await expect(editorOf(page).getByRole("button",{name:f.filename+"をタイムラインへ追加",exact:true})).toBeEnabled({timeout:120000});
  assert.ok(report.requests.filter(v=>v.kind==="PROBE").length>count,"Favorite use did not re-PROBE the copied reference");
  if(kind==="VIDEO"){await editorOf(page).getByRole("button",{name:f.filename+"をタイムラインへ追加",exact:true}).click();await ready(page);}
 }
 await expect.poll(async()=>!!(await ownDraft(page))?.inputTimeline?.videoClips?.length).toBe(true);const snapshot=await ownDraft(page);assert.notEqual(snapshot.inputTimeline.id,report.nativeNew.previousProjectId);report.copiedProject={document:snapshot.inputTimeline,inputFiles:snapshot.inputFiles};
}
async function restore(page){await page.reload();await page.getByRole("button",{name:"復元",exact:true}).click();await expect(editorOf(page)).toBeVisible();await ready(page);}
async function screenshots(page,context,report,output){
 for(const theme of ["neon","paper","high-contrast"]){
  if(theme!=="neon"){await context.addCookies([{name:"bitovp-theme",value:theme,url:origin}]);const before=report.requests.filter(v=>v.kind==="PROBE").length;await restore(page);assert.ok(report.requests.filter(v=>v.kind==="PROBE").length>before,"Draft restore did not re-PROBE");}
  await expect(page.locator("html")).toHaveAttribute("data-theme",theme);
  for(const width of [320,768,1024,1440]){
   await page.setViewportSize({width,height:1000});await page.evaluate(async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});
   for(const f of favoriteFixtures)await expect(editorOf(page).getByRole("button",{name:useName(f),exact:true})).toBeVisible();
   const layout=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,page:document.documentElement.scrollWidth}));report.layouts.push({theme,width,...layout});assert.ok(layout.page<=layout.viewport+1,"Fixed-source layout overflows at "+theme+"/"+width);
   await editorOf(page).screenshot({path:resolve(output,theme+"-"+width+".png"),animations:"allow"});
  }
 }
}
async function inspectLogo(page,{output}={}){
 await step(page,3);const kinds=page.locator('select[id^="wz-flt-"][id$="-kind"]');const values=await kinds.evaluateAll(nodes=>nodes.map(n=>({id:n.id,kind:n.value})));
 const rows=values.filter(v=>v.kind==="WATERMARK");let logo=null;
 for(const row of rows){
  const base=row.id.slice(0,-5),imagePath=await page.locator("#"+base+"-imagePath").inputValue();if(imagePath!==fixture("IMAGE").objectKey)continue;
  const filterKey=await page.locator("#"+base+"-key").inputValue(),inputKey=await page.locator("#"+base+"-input").inputValue();
  const attachments=await page.locator('select[id^="wz-v-"][id*="-x-flt-"]').evaluateAll(nodes=>nodes.map(n=>({id:n.id,value:n.value,position:Number(document.getElementById(n.id.replace("-flt-","-fltpos-"))?.value)})));
  const videos=await page.locator('select[id^="wz-v-"][id$="-codec"]').count(),attachedVideos=new Set(attachments.filter(a=>a.value===filterKey).map(a=>a.id.match(/^wz-v-(\d+)-/)?.[1]));
  assert.ok(videos>0&&attachedVideos.size===videos,"Output logo was not attached to every video rendition");
  const logoAttachments=attachments.filter(a=>a.value===filterKey);assert.ok(logoAttachments.every(a=>Number.isSafeInteger(a.position)&&a.position>=0),"Output logo attachment position is missing");
  logo={kind:"WATERMARK",filterKey,inputKey,imagePath,left:await page.locator("#"+base+"-left").inputValue(),top:await page.locator("#"+base+"-top").inputValue(),attachedVideos:attachedVideos.size,attachments:logoAttachments};
 }
 assert.ok(logo,"The output logo filter is missing");
 if(output&&logo){const summary=page.locator("summary").filter({hasText:/^フィルター設定/});if(await summary.count())await summary.click();await page.screenshot({path:resolve(output,"output-logo-filter.png"),fullPage:true});}
 await step(page,2);await expect(editorOf(page)).toBeVisible();await ready(page);return logo;
}
async function inspectParentEligibility(page,report,phase,output){
 const probesBefore=report.requests.filter(r=>r.kind==="PROBE").length;await step(page,8);
 const start=page.getByRole("button",{name:"エンコーディングを開始",exact:true});await expect(start).toBeEnabled();
 await page.getByRole("textbox",{name:"プリセット名",exact:true}).fill("favorites-readiness-qa");
 await expect(page.getByRole("button",{name:"プリセットとして保存",exact:true})).toBeEnabled();
 assert.equal(report.requests.filter(r=>r.kind==="PROBE").length,probesBefore,"Review eligibility was repaired by an unexpected probe");
 report.parentReadiness??={};report.parentReadiness[phase]={startEnabled:true,savePresetEnabled:true,probes:probesBefore,providerSubmitted:false};
 await page.screenshot({path:resolve(output,"parent-readiness-"+phase+".png"),fullPage:true});
 // Do not click either write action. The provider-write request guard stays closed.
}
async function configureParentEligibility(page,report,output){
 await step(page,1);await page.locator("#wz-name").fill("Fixed source readiness QA");await page.locator("#wz-account").selectOption(syntheticAccount.id);
 await step(page,4);await page.locator("#wz-out-cred").selectOption(credentialId);
 const picker=page.getByRole("dialog").filter({has:page.locator("#picker-credential")});await expect(picker).toBeVisible();
 await picker.locator("#picker-bucket").selectOption(bucket);
 for(const folder of ["fixtures/","vod-favorites-merge/","v1/"])await picker.getByRole("button",{name:folder,exact:true}).click();
 await picker.getByRole("button",{name:/^現在のプレフィックスを(?:出力先にする|使う)$/}).click();await expect(picker).toBeHidden();
 await step(page,2);await ready(page);await inspectParentEligibility(page,report,"before-logo",output);
 await step(page,2);await ready(page);
}
async function applyLogo(page,report){
 const before=await ownDraft(page),editorHandle=await editorOf(page).elementHandle(),previewHandle=await editorOf(page).getByLabel("入力タイムラインのプレビュー",{exact:true}).elementHandle(),requestCount=mediaRequests(report).length;
 await editorOf(page).getByRole("button",{name:useName(fixture("IMAGE")),exact:true}).click();
 await expect(editorOf(page).getByRole("status").filter({hasText:"入力プレビューには表示されません"})).toBeVisible();
 await expect.poll(async()=>!!(await ownDraft(page))?.inputFiles?.some(f=>f.path===fixture("IMAGE").objectKey&&f.purpose==="FILTER_IMAGE")).toBe(true);
 const after=await ownDraft(page);assert.deepEqual(after.inputTimeline,before.inputTimeline,"Logo action changed timeline clips");assertNoImageProbes(report.requests);
 assert.ok(await editorOf(page).evaluate((el,previous)=>el===previous,editorHandle),"Logo action remounted the editor");
 assert.ok(await editorOf(page).getByLabel("入力タイムラインのプレビュー",{exact:true}).evaluate((el,previous)=>el===previous,previewHandle),"Logo action remounted the preview");
 assert.equal(mediaRequests(report).length,requestCount,"Applying output-only logo triggered AV preparation");
 report.logoApplication={editorRetained:true,previewRetained:true,mediaRequestsUnchanged:true};return after;
}
async function logoAndRemoval(page,report,output){
 console.log("Favorites QA: output logo copy, reload exclusion and removal invariance");
 await configureParentEligibility(page,report,output);await applyLogo(page,report);
 // Checking output filters first would remount the editor and hide the parent's
 // stale signature bug. Go straight to Review and inspect the actual Start gate.
 await inspectParentEligibility(page,report,"after-logo",output);await step(page,2);await ready(page);
 const initialLogo=await inspectLogo(page),beforeReload=await ownDraft(page);const probesBefore=report.requests.filter(v=>v.kind==="PROBE").length;
 await restore(page);assert.ok(report.requests.filter(v=>v.kind==="PROBE").length>probesBefore,"Applied-logo draft did not re-PROBE media");assertNoImageProbes(report.requests);
 const logo=await inspectLogo(page),afterReload=await ownDraft(page);
 assert.deepEqual(afterReload.inputFiles,beforeReload.inputFiles,"Draft restore changed FILTER_IMAGE input reference or purpose");
 assert.deepEqual(afterReload.inputTimeline,beforeReload.inputTimeline,"Draft restore changed timeline clips");
 assert.equal(afterReload.inputFiles.find(f=>f.path===fixture("IMAGE").objectKey)?.purpose,"FILTER_IMAGE","Draft restore lost the logo input purpose");
 assert.deepEqual(logo,initialLogo,"Draft restore lost or changed the WATERMARK filter and rendition attachments");
 report.logoReload={filterPersisted:true,attachmentsPersisted:true,purposePersisted:true,AVProbeExcludedImage:true,reapplied:false};report.logo={initial:initialLogo,current:logo};
 const video=await ready(page);await editorOf(page).getByRole("slider",{name:"シーケンスの再生位置",exact:true}).press("Home");await expect.poll(()=>video.evaluate(e=>!e.seeking&&e.readyState>=2)).toBe(true);
 const pixel=await video.evaluate(e=>{const c=new OffscreenCanvas(1,1),x=c.getContext("2d");x.drawImage(e,5,5,1,1,0,0,1,1);return [...x.getImageData(0,0,1,1).data];});assert.ok(pixel[0]>150&&pixel[1]<80&&pixel[2]<80,"Output-only yellow logo leaked into the red input preview");report.logo.previewPixel=pixel;
 for(const width of [320,1440]){await page.setViewportSize({width,height:1000});await page.evaluate(async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});await editorOf(page).screenshot({path:resolve(output,"logo-applied-"+width+".png"),animations:"allow"});}
 const before={...await ownDraft(page),logo};
 for(const f of favoriteFixtures){
  const saved=report.saved.find(v=>v.objectKey===f.objectKey);await editorOf(page).getByRole("button",{name:removeName(f),exact:true}).click();
  await expect(editorOf(page).getByRole("button",{name:removeName(f),exact:true})).toHaveCount(0);await expect.poll(()=>report.deleted.includes(saved.id)).toBe(true);
  const after=await ownDraft(page);assertFavoriteCopyPreserved({...before,logo:null},{...after,logo:null});report.removals.push({kind:f.kind,id:saved.id,copyRetained:true});
 }
 const afterLogo=await inspectLogo(page,{output});assertFavoriteCopyPreserved(before,{...await ownDraft(page),logo:afterLogo});assertNoImageProbes(report.requests);report.logo.copySurvivedFavoriteRemoval=true;
}
export async function runFavoritesBrowserQa(options){
 assert.equal(options.baseURL,origin);await mkdir(options.output,{recursive:true});
 const report={baseURL:origin,startedAt:new Date().toISOString(),status:"RUNNING",blocked:[],httpErrors:[],consoleErrors:[],responseErrors:[],requests:[],requestTimes:[],saved:[],deleted:[],layouts:[],removals:[],injectedResponses:[],cacheHeaders:[],cleanupErrors:[]};
 const ownedIds=new Set(),fault={mode:null},browser=await chromium.launch({headless:true}),context=await browser.newContext({baseURL:origin,viewport:{width:1440,height:1000},locale:"ja-JP",serviceWorkers:"block"});
 await context.addCookies([{name:"ovp-locale",value:"ja",url:origin}]);
 await context.route("**/*",async route=>{
  const r=route.request(),url=new URL(r.url()),body=r.method()==="POST"?JSON.parse(r.postData()??"null"):null;
  if(!favoriteRequestAllowed(r.url(),r.method(),body,ownedIds)){report.blocked.push({method:r.method(),path:url.pathname});return route.abort();}
  if(r.method()==="POST"){report.requests.push(body);report.requestTimes.push({at:Date.now(),path:url.pathname,kind:body?.kind});}
  const syntheticRead=favoriteSyntheticRead(r.url(),r.method());if(syntheticRead){report.injectedResponses.push({path:url.pathname,status:200,mode:"synthetic-account-read-only-no-key",at:Date.now()});return route.fulfill({status:200,contentType:"application/json",headers:{"cache-control":"private, no-store"},body:JSON.stringify(syntheticRead)});}
  if(r.method()==="GET"&&url.pathname===favoritePath&&fault.mode==="invalid-list"){report.injectedResponses.push({path:favoritePath,status:200,mode:"invalid-schema",at:Date.now()});return route.fulfill({status:200,contentType:"application/json",headers:{"cache-control":"private, no-store"},body:JSON.stringify({favorites:"intentional QA malformed response"})});}
  return route.continue();
 });
 const page=await context.newPage();page.on("pageerror",e=>report.consoleErrors.push(e.message));page.on("console",m=>{if(m.type()==="error")report.consoleErrors.push(m.text());});
 page.on("response",async r=>{
  const url=new URL(r.url()),method=r.request().method();if(r.status()>=400)report.httpErrors.push({path:url.pathname,status:r.status()});
  if(url.pathname===favoritePath&&r.ok()){
   report.cacheHeaders.push({method,status:r.status(),value:r.headers()["cache-control"]??""});
   const value=await r.json().catch(()=>null);
   if(method==="POST"&&value?.favorite){if(!favoriteFixtures.some(f=>f.objectKey===value.favorite.objectKey))report.responseErrors.push("Favorite response did not match an owned fixture");else{ownedIds.add(value.favorite.id);report.saved.push(value.favorite);}}
   if(method==="GET"&&Array.isArray(value?.favorites)){const own=value.favorites.filter(f=>favoriteFixtures.some(q=>q.objectKey===f.objectKey));report.currentFavorites=own;if(!report.initialList){report.initialList={nonOwnedIds:value.favorites.filter(f=>!own.includes(f)).map(f=>f.id),ownedIds:own.map(f=>f.id)};}}
  }
  if(url.pathname.startsWith(favoritePath+"/")&&method==="DELETE"&&r.status()===204)report.deleted.push(url.pathname.slice(favoritePath.length+1));
 });
 try {
  await page.goto("/vod/new");await enterEditor(page);await expect.poll(()=>!!report.initialList).toBe(true);assert.equal(report.initialList.ownedIds.length,0,"Owned QA favorites already exist; preserve them and clean the earlier run first");
  console.log("Favorites QA: native video/audio saves and image registration");
  await addInput(page,fixture("VIDEO"));await editorOf(page).getByRole("button",{name:fixture("VIDEO").filename+"をタイムラインへ追加",exact:true}).click();await ready(page);await saveLoaded(page,report,fixture("VIDEO"));
  await addInput(page,fixture("AUDIO"));await saveLoaded(page,report,fixture("AUDIO"));await saveImage(page,report);
  console.log("Favorites QA: native New VOD, persisted list, error/retry and fresh probes");
  await nativeNewVod(page,report,fault);await useMedia(page,report);await ready(page);assertNoImageProbes(report.requests);
  await screenshots(page,context,report,options.output);
  report.pacing={limit:30,windowMs:60000,quietMs:60200,postsBefore:report.requests.length,startedAt:Date.now()};assert.ok(mediaRequests(report).length<30,"First group exceeds the real preview POST budget");console.log("Favorites QA: quiet window before logo/reload checks; POSTs="+report.requests.length);await page.waitForTimeout(30100);await page.waitForTimeout(30100);report.pacing.finishedAt=Date.now();assert.equal(report.requests.length,report.pacing.postsBefore,"Unexpected POST during quiet window");
  await logoAndRemoval(page,report,options.output);await writeFile(resolve(options.output,"accessibility.yaml"),await editorOf(page).ariaSnapshot());
  assert.equal(report.saved.length,3);assert.equal(new Set(report.deleted).size,3);assert.ok(report.injectedResponses.length>0);assert.ok(report.cacheHeaders.every(h=>h.value.includes("private")&&h.value.includes("no-store")),"Favorite responses must be private/no-store");
  assert.equal(report.blocked.length,0,"Forbidden request attempted");assert.equal(report.httpErrors.length,0,"HTTP error");assert.equal(report.consoleErrors.length,0,"Console error");assert.equal(report.responseErrors.length,0,"Favorite response error");report.status="PASSED";
 }catch(error){report.status="FAILED";report.error=error.message;await page.screenshot({path:resolve(options.output,"failure.png"),fullPage:true}).catch(()=>{});throw error;}
 finally{
  fault.mode=null;
  if(report.status!=="PASSED"&&ownedIds.size){
   try{await page.keyboard.press("Escape");await step(page,2);const retry=editorOf(page).getByRole("alert").filter({hasText:"固定素材"}).getByRole("button",{name:"再試行",exact:true});if(await retry.count())await retry.click();
    for(const f of favoriteFixtures){const saved=report.saved.find(v=>v.objectKey===f.objectKey),button=editorOf(page).getByRole("button",{name:removeName(f),exact:true});if(saved&&!report.deleted.includes(saved.id)&&await button.count()&&await button.isEnabled())await button.click();}
   }catch(e){report.cleanupErrors.push(e.message);}
  }
  report.remainingOwnedIds=[...ownedIds].filter(id=>!report.deleted.includes(id));report.finishedAt=new Date().toISOString();await writeFile(resolve(options.output,"browser-receipt.json"),JSON.stringify(report,null,2)+"\n");await context.close();await browser.close();console.log(JSON.stringify({status:report.status,output:options.output,saved:report.saved.length,removed:new Set(report.deleted).size,screenshots:report.layouts.length,blocked:report.blocked.length}));
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runFavoritesBrowserQa(parseOptions(process.argv.slice(2)));
