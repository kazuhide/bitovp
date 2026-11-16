/** Hash-bound shards keep generated SDK contracts below the normal formatter limit. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require=createRequire(import.meta.url);
const digest=text=>createHash("sha256").update(text).digest("hex");
const fail=message=>{throw new Error(message);};
const shardName=/^contracts\/(operations|schemas)-[a-z0-9]+-\d{3}\.json$/;
const format=value=>execFileSync(process.execPath,[require.resolve("@biomejs/biome/bin/biome"),"format","--stdin-file-path=contracts.json"],{input:JSON.stringify(value),encoding:"utf8",maxBuffer:2*1024*1024});

function partitions(entries,keyOf) {
	const groups=new Map();
	for(const entry of entries) {
		const key=keyOf(entry);
		if(!/^[a-z0-9]+$/.test(key)) fail(`Invalid SDK shard group: ${key}`);
		if(!groups.has(key)) groups.set(key,[]);
		groups.get(key).push(entry);
	}
	const result=[];
	for(const [key,values] of groups) {
		let chunk=[]; let size=0; let index=0;
		for(const value of values) {
			const next=Buffer.byteLength(JSON.stringify(value,null,"\t"));
			if(chunk.length && size+next>550_000) {result.push([`${key}-${String(index++).padStart(3,"0")}`,chunk]);chunk=[];size=0;}
			chunk.push(value);size+=next;
		}
		if(chunk.length) result.push([`${key}-${String(index).padStart(3,"0")}`,chunk]);
	}
	return result;
}

export function writeContracts(manifestPath,contract) {
	const {operations,schemas,...manifest}=contract;
	const base=dirname(manifestPath);
	const old=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,"utf8")):{};
	const previous=[...(old.operationShards??[]),...(old.schemaShards??[])].map(row=>row.file);
	const generated=new Set();
	mkdirSync(join(base,"contracts"),{recursive:true});
	for(const [kind,entries,keyOf,field] of [
		["operations",operations,row=>row.sdkMethod.split(".")[1].toLowerCase(),"operationShards"],
		["schemas",Object.entries(schemas),([key])=>(key.split("/").at(-1)[0].toLowerCase().match(/[a-z]/)?.[0]??"other"),"schemaShards"],
	]) {
		manifest[field]=partitions(entries,keyOf).map(([name,items])=>{
			const file=`contracts/${kind}-${name}.json`;
			const text=format({schemaVersion:1,kind,items});
			if(Buffer.byteLength(text)>=1_048_576) fail(`Generated SDK shard exceeds formatter limit: ${file}`);
			writeFileSync(join(base,file),text);generated.add(file);
			return {file,sha256:digest(text)};
		});
	}
	for(const file of previous) if(shardName.test(file)&&!generated.has(file)) rmSync(join(base,file),{force:true});
	writeFileSync(manifestPath,format(manifest));
}

export function readContracts(manifestPath) {
	const manifest=JSON.parse(readFileSync(manifestPath,"utf8"));
	if(manifest.schemaVersion!==1 || !Array.isArray(manifest.operationShards)||!Array.isArray(manifest.schemaShards)) fail("Invalid SDK contract shard manifest");
	const {operationShards,schemaShards,...contract}=manifest;
	const base=dirname(manifestPath);
	const files=new Set();
	const read=(rows,kind)=>rows.flatMap(row=>{
		if(!shardName.test(row.file)||!row.file.startsWith(`contracts/${kind}-`)||files.has(row.file)||!/^[a-f0-9]{64}$/.test(row.sha256)) fail("Invalid or duplicate SDK contract shard");
		files.add(row.file);
		const text=readFileSync(join(base,row.file),"utf8");
		if(digest(text)!==row.sha256) fail(`SDK contract shard hash mismatch: ${row.file}`);
		const shard=JSON.parse(text);
		if(shard.schemaVersion!==1||shard.kind!==kind||!Array.isArray(shard.items)) fail(`Invalid SDK contract shard content: ${row.file}`);
		return shard.items;
	});
	contract.operations=read(operationShards,"operations");
	const schemaEntries=read(schemaShards,"schemas");
	if(new Set(contract.operations.map(row=>row.sdkMethod)).size!==contract.operations.length||new Set(schemaEntries.map(row=>row[0])).size!==schemaEntries.length) fail("Duplicate SDK contract operation or schema");
	contract.schemas=Object.fromEntries(schemaEntries.sort(([a],[b])=>a.localeCompare(b)));
	const extras=readdirSync(join(base,"contracts")).filter(file=>file.endsWith(".json")&&!files.has(`contracts/${file}`));
	if(extras.length) fail(`Extra SDK contract shards: ${extras.join(", ")}`);
	if(contract.summary.totalOperations!==contract.operations.length||contract.summary.schemas!==schemaEntries.length) fail("SDK contract shard denominator mismatch");
	return contract;
}
