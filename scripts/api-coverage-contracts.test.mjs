import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildRequestContracts, transportBindings, contractContent } from "./api-coverage-contracts.mjs";
import { writeContracts, readContracts } from "./api-coverage-contract-files.mjs";

function fixture(run) {
	const root = mkdtempSync(join(tmpdir(), "api-contracts-"));
	try {
		mkdirSync(join(root, "encoding/items"), { recursive: true });
		mkdirSync(join(root, "models"));
		const js = join(root, "encoding/items/ItemsApi.js");
		writeFileSync(js, `class ItemsApi {
 create(itemId, body) { const paths = {item_id: itemId}; return this.restClient.post('/encoding/items/{item_id}', paths, body); }
 list(query) { return this.restClient.get('/encoding/items', {}, query); }
 get(itemId) { return this.restClient.get('/encoding/items/{item_id}', {item_id:itemId}); }
 }`);
		writeFileSync(js.replace(/js$/, "d.ts"), `import Body from '../../models/Body';
 export default class ItemsApi {
 create(itemId: string, body?: Body): Promise<Body>;
 list(query?: {limit?:number; sort?: 'ASC'|'DESC'}): Promise<Body[]>;
 get(itemId:string): Promise<Body>;
 }`);
		writeFileSync(join(root, "models/Body.d.ts"), `export enum Mode { ONE='ONE', TWO='TWO' }
 declare class Base { id?: string; readonly discriminator: string; method():void; }
 export default class Body extends Base {
 /** Either bitrate or quality is required. */
 bitrate?:number;
 mode?:Mode;
 child?:Body;
 children?:Body[];
 settings?:{enabled:boolean; values:{[key:string]:string}};
 alternative?: string | number;
 date?:Date;
 explicitUnset: string | undefined;
 nullable?:string | null;
 }`);
		run({ root, js, generate: () => buildRequestContracts({ sdkRoot:root, files:[js], sdkVersion:"test" }) });
	} finally { rmSync(root, { recursive:true, force:true }); }
}

test("request locations follow transport bindings and preserve every operation", () => fixture(({generate}) => {
	const result = generate();
	assert.equal(result.operations.length, 3);
	assert.deepEqual(result.operations[0].parameters.map(p=>[p.name,p.location,p.wireName,p.optional]), [["itemId","path","item_id",false],["body","body",undefined,true]]);
	assert.equal(result.operations[1].parameters[0].location, "query");
	assert.equal(result.operations[2].parameters.length, 1);
	assert.equal(result.provenance.sdkVersion, "test");
}));

test("normalized schemas retain inherited fields, cycles, nested arrays and dictionaries", () => fixture(({generate}) => {
	const result = generate();
	const body = result.operations[0].parameters[1].type;
	const schema = result.schemas[body.ref];
	const field = name => schema.properties.find(p=>p.name===name);
	assert.ok(field("id"));
	assert.equal(field("method"),undefined);
	assert.equal(field("child").type.ref,body.ref);
	assert.equal(field("children").type.kind,"array");
	assert.equal(field("children").type.items.ref,body.ref);
	const settings = result.schemas[field("settings").type.ref];
	const values = result.schemas[settings.properties.find(p=>p.name==="values").type.ref];
	assert.equal(values.additionalProperties[0].value.kind,"string");
}));

test("enum and union values and optional fields remain distinct from API acceptance", () => fixture(({generate}) => {
	const result = generate();
	const body = result.schemas[result.operations[0].parameters[1].type.ref];
	const field = name=>body.properties.find(p=>p.name===name);
	assert.equal(field("discriminator").sdkReadonly,true);
	assert.equal(field("discriminator").apiWriteability,"unconfirmed");
	assert.equal(field("bitrate").optional,true);
	assert.match(field("bitrate").documentation,/Either bitrate or quality/);
	assert.deepEqual(result.schemas[field("mode").type.ref].values,["ONE","TWO"]);
	assert.deepEqual(field("alternative").type.variants.map(t=>t.kind).sort(),["number","string"]);
	assert.ok(body.properties.every(p=>p.apiWriteability==="unconfirmed"));
}));

test("standard library values are recorded without inventing SDK wire fields", () => fixture(({generate}) => {
	const result=generate();
	const body=result.schemas[result.operations[0].parameters[1].type.ref];
	assert.deepEqual(body.properties.find(p=>p.name==="date").type,{kind:"builtin",type:"Date",scope:"TypeScript builtin; wire representation unconfirmed"});
}));

test("declared undefined/null alternatives are preserved independently of optionality", () => fixture(({generate}) => {
	const result=generate();
	const body=result.schemas[result.operations[0].parameters[1].type.ref];
	const unset=body.properties.find(p=>p.name==="explicitUnset");
	const nullable=body.properties.find(p=>p.name==="nullable");
	assert.equal(unset.optional,false);
	assert.deepEqual(unset.type.variants.map(t=>t.kind).sort(),["string","undefined"]);
	assert.equal(nullable.optional,true);
	assert.deepEqual(nullable.type.variants.map(t=>t.kind).sort(),["null","string"]);
}));

test("standard SDK query builder keeps callable helper as a separate declared alternative", () => fixture(({root,js,generate}) => {
	writeFileSync(js, `class ItemsApi { list(query) { let queryParams={}; if(typeof query==='function') { queryParams=query(new Builder()).buildQueryParams(); } else if(query) { queryParams=query; } return this.restClient.get('/encoding/items', {}, queryParams); } }`);
	writeFileSync(js.replace(/js$/,"d.ts"), `export default class ItemsApi { list(query?: {limit?:number} | ((builder:unknown)=>unknown)):Promise<void>; }`);
	const parameter=generate().operations[0].parameters[0];
	assert.equal(parameter.binding,"sdk-query-builder");
	assert.equal(parameter.type.kind,"union");
	assert.ok(parameter.type.variants.some(t=>t.kind==="function"));
	assert.equal(parameter.location,"query");
}));

test("unknown transport body or query transformations and path mismatches fail closed", () => {
	for(const source of [
		`class ItemsApi { create(body){return this.restClient.post('/encoding/items', {}, {...body});} }`,
		`class ItemsApi { list(query){return this.restClient.get('/encoding/items', {}, convert(query));} }`,
		`class ItemsApi { get(id){return this.restClient.get('/encoding/items/{missing}', {id});} }`,
		`class ItemsApi { get(id){return this.restClient.get('/encoding/items/{id}', {id:other});} }`,
		`class ItemsApi { list(query){let params={};if(typeof query==='function') {params=query;}else if(query){params=query(new Builder()).buildQueryParams();}return this.restClient.get('/encoding/items',{},params);} }`,
	]) assert.throws(()=>transportBindings("encoding/items/ItemsApi.js",source),/Unresolved|mismatch/);
});

test("computed/unknown SDK transport calls cannot disappear from both inventories", () => fixture(({js,generate}) => {
	for (const expression of ["this.restClient['get']", "this.restClient.head", "this['restClient'].get"]) {
		writeFileSync(js, `class ItemsApi { get(itemId) { return ${expression}('/encoding/items/{item_id}', {item_id:itemId}); } }`);
		assert.throws(generate, /Unresolved SDK transport/);
	}
}));

test("public arrow fields and missing JS methods cannot shrink the SDK operation denominator", () => fixture(({js,generate}) => {
	writeFileSync(js, `class ItemsApi { get = (itemId)=>{const {restClient}=this;return restClient.get('/encoding/items/{item_id}',{item_id:itemId});}; }`);
	assert.throws(generate,/Unresolved SDK/);
	writeFileSync(js, `class ItemsApi { create(itemId,body){return this.restClient.post('/encoding/items/{item_id}',{item_id:itemId},body);} list(query){return this.restClient.get('/encoding/items',{},query);} }`);
	assert.throws(generate,/declaration|denominator|method/);
}));

test("reassigned or mutated SDK parameters never retain a direct original-type binding", () => {
	for (const change of [
		`body = JSON.stringify(body);`, `body ||= {};`, `body++;`, `--body;`,
		`({body} = source);`, `[body] = source;`, `body.name = 'changed';`,
		`delete body.name;`, `const alias=body; alias.name='changed';`,
	]) assert.throws(() => transportBindings("encoding/items/ItemsApi.js", `class ItemsApi { create(body) { ${change} return this.restClient.post('/encoding/items', {}, body); } }`), /Unresolved SDK/);
	assert.throws(() => transportBindings("encoding/items/ItemsApi.js", `class ItemsApi { list(query) { query=normalize(query);return this.restClient.get('/encoding/items', {}, query); } }`), /Unresolved SDK/);
	assert.throws(() => transportBindings("encoding/items/ItemsApi.js", `class ItemsApi { get(id) { id='other';return this.restClient.get('/encoding/items/{id}', {id}); } }`), /Unresolved SDK/);
});

test("unconsumed statements cannot hide aliases, path mutation or extra transport calls", () => {
	for (const source of [
		`class ItemsApi { create(body){const alias=(body);alias.toJSON=()=>"string";return this.restClient.post('/encoding/items',{},body);} }`,
		`class ItemsApi { get(id){const paths={id};paths.id='different';return this.restClient.get('/encoding/items/{id}',paths);} }`,
		`class ItemsApi { get(id){const paths={id};paths={id:'different'};return this.restClient.get('/encoding/items/{id}',paths);} }`,
		`class ItemsApi { get(id){const {restClient}=this;restClient.get('/encoding/items/hidden',{});return this.restClient.get('/encoding/items/{id}',{id});} }`,
		`class ItemsApi { create(body){Object.defineProperty(body,'toJSON',{value:()=>"string"});return this.restClient.post('/encoding/items',{},body);} }`,
		`class ItemsApi { get(id){const paths={id};normalize(paths);return this.restClient.get('/encoding/items/{id}',paths);} }`,
		`class ItemsApi { get(id){const unused={};return this.restClient.get('/encoding/items/{id}',{id});} }`,
		`class ItemsApi { get(id){return this.restClient.get('/encoding/items/{id}',{id}).then(response=>{fetch('/hidden');return response;});} }`,
		`class ItemsApi { list(query){let params={};if(typeof query==='function'){params=query(new Builder()).buildQueryParams();normalize(params);}else if(query){params=query;}return this.restClient.get('/encoding/items',{},params);} }`,
		`class ItemsApi { list(query){let params={};if(typeof query==='function'){params=query(new Builder(query)).buildQueryParams();}else if(query){params=query;}return this.restClient.get('/encoding/items',{},params);} }`,
		`class ItemsApi { list(query){let params={};if(typeof query==='function'){params=query(new Builder()).buildQueryParams();}else if(query){params=query;}params.limit='changed';return this.restClient.get('/encoding/items',{},params);} }`,
	]) assert.throws(()=>transportBindings("encoding/items/ItemsApi.js",source),/Unresolved SDK/);
});

test("unknown generated parameter and class member forms require an explicit grammar review", () => {
	for (const declaration of [
		`create(body={}){return this.restClient.post('/encoding/items',{},body);}`,
		`create(...body){return this.restClient.post('/encoding/items',{},body);}`,
		`create({body}){return this.restClient.post('/encoding/items',{},body);}`,
		`static get(){return this.restClient.get('/encoding/items',{});}`,
		`get response(){return this.restClient.get('/encoding/items',{});}`,
		`get=()=>this.restClient.get('/encoding/items',{});`,
	]) assert.throws(()=>transportBindings("encoding/items/ItemsApi.js",`class ItemsApi {${declaration}}`),/Unresolved SDK/);
	assert.throws(()=>transportBindings("encoding/items/ItemsApi.js",`class ItemsApi extends factory(){get(){return this.restClient.get('/encoding/items',{});}}`),/Unresolved SDK/);
	assert.throws(()=>transportBindings("encoding/items/ItemsApi.js",`class ItemsApi {get(){return this.restClient.get('/encoding/items',{}).then(Mapper_1=>{return (0,Mapper_1.map)(Mapper_1);});}}`),/Unresolved SDK/);
});

test("canonical local bindings cannot shadow module imports, class names or helper namespaces", () => {
	for (const source of [
		`const Mapper_1=require('mapper');class ItemsApi {create(Mapper_1){return this.restClient.post('/encoding/items',{},Mapper_1);}}`,
		`const Mapper_1=require('mapper');class ItemsApi {get(id){const Mapper_1={id};return this.restClient.get('/encoding/items/{id}',Mapper_1).then(response=>{return (0,Mapper_1.map)(response);});}}`,
		`const Model_1=require('model');class ItemsApi {get(){return this.restClient.get('/encoding/items',{}).then(Model_1=>{return (0,Mapper_1.map)(Model_1,Model_1.default);});}}`,
		`class ItemsApi {create(ItemsApi){return this.restClient.post('/encoding/items',{},ItemsApi);}}`,
		`class ItemsApi {list(query){let params={};if(typeof query==='function'){params=query(new query.Builder()).buildQueryParams();}else if(query){params=query;}return this.restClient.get('/encoding/items',{},params);}}`,
	]) assert.throws(()=>transportBindings("encoding/items/ItemsApi.js",source),/Unresolved SDK/);
});

test("constructor child resources cannot replace transport, methods or duplicate slots", () => {
	for (const assignments of [
		`this.restClient=new Child_1.default(configuration);`,
		`this.get=new Child_1.default(configuration);`,
		`this.prototype=new Child_1.default(configuration);`,
		`this.__proto__=new Child_1.default(configuration);`,
		`this.constructor=new Child_1.default(configuration);`,
		`this.child=new Child_1.default(configuration);this.child=new Child_1.default(configuration);`,
		`this.restClient=configuration;`,
	]) assert.throws(()=>transportBindings("encoding/items/ItemsApi.js",`const Child_1=require('./ChildApi');class ItemsApi {constructor(configuration){super(configuration);${assignments}} get(){return this.restClient.get('/encoding/items',{});}}`),/Unresolved SDK/);
});

test("constructor namespace slots and imported targets match their own public declarations", () => fixture(({root,js,generate}) => {
	writeFileSync(join(root,"encoding/items/ChildApi.d.ts"),"export default class ChildApi {} ");
	writeFileSync(join(root,"encoding/items/OtherApi.d.ts"),"export default class OtherApi {} ");
	const declaration=`import Child from './ChildApi';export default class ItemsApi {child:Child;get(itemId:string):Promise<void>;}`;
	writeFileSync(js.replace(/js$/,"d.ts"),declaration);
	const source=slot=>`const Child_1=require('./ChildApi');const Other_1=require('./OtherApi');class ItemsApi {constructor(configuration){super(configuration);this.${slot}=new Child_1.default(configuration);}get(itemId){return this.restClient.get('/encoding/items/{item_id}',{item_id:itemId});}}`;
	writeFileSync(js,source("child"));
	assert.equal(generate().operations.length,1);
	writeFileSync(js,source("undeclared"));
	assert.throws(generate,/namespace|child|property/);
	writeFileSync(js,source("child").replace("new Child_1.default","new Other_1.default"));
	assert.throws(generate,/namespace|child|property/);
	writeFileSync(js,`class ItemsApi {get(itemId){return this.restClient.get('/encoding/items/{item_id}',{item_id:itemId});}}`);
	assert.throws(generate,/namespace|child|property/);
}));

test("an unused declared parameter is not silently dropped from the inventory", () => fixture(({js,generate}) => {
	writeFileSync(js.replace(/js$/,"d.ts"), `export default class ItemsApi { create(itemId:string,body?:{name:string},extra?:boolean):Promise<void>;list(query?:{limit:number}):Promise<void>;get(itemId:string):Promise<void>;}`);
	assert.throws(generate,/parameter|signature/);
}));

test("invalid SDK declarations and duplicate operations fail closed", () => fixture(({root,js,generate}) => {
	assert.throws(()=>buildRequestContracts({sdkRoot:root,files:[js,js],sdkVersion:"test"}),/Duplicate/);
	writeFileSync(js.replace(/js$/,"d.ts"), `export default class ItemsApi { create(itemId:string,body: Missing):Promise<void>; }`);
	assert.throws(generate,/Unresolved|declaration/);
}));

test("checks compare all contract facts but ignore generation timestamps", () => fixture(({generate}) => {
	const result=generate();
	const next=structuredClone(result);
	next.provenance.generatedAt="later";
	assert.deepEqual(contractContent(result),contractContent(next));
	next.operations[0].parameters[1].optional=false;
	assert.notDeepEqual(contractContent(result),contractContent(next));
}));

test("sharded contract files roundtrip and detect missing, tampered, duplicate and extra shards", () => fixture(({root,generate}) => {
	const file=join(root,"ledger","contracts.json");
	const contract=generate();
	writeContracts(file,contract);
	assert.deepEqual(contractContent(readContracts(file)),contractContent(contract));
	const manifest=readFileSync(file,"utf8");
	const decoded=JSON.parse(manifest);
	const shard=join(root,"ledger",decoded.operationShards[0].file);
	const original=readFileSync(shard,"utf8");
	writeFileSync(shard,original+" ");
	assert.throws(()=>readContracts(file),/hash mismatch/);
	rmSync(shard);
	assert.throws(()=>readContracts(file),/ENOENT/);
	writeFileSync(shard,original);
	decoded.operationShards.push(decoded.operationShards[0]);
	writeFileSync(file,JSON.stringify(decoded));
	assert.throws(()=>readContracts(file),/duplicate/);
	writeFileSync(file,manifest);
	writeFileSync(join(root,"ledger","contracts","extra.json"),"{}");
	assert.throws(()=>readContracts(file),/Extra/);
}));
