/** Offline request contracts, not API write support or GUI/runtime qualification.
 * Request bindings come from SDK transport arguments; types/comments from its declarations.
 * node scripts/api-coverage-contracts.mjs --write | --check
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { enumerateOperations } from "./api-coverage-current.mjs";
import { canonicalSdkMethods } from "./api-coverage-sdk-methods.mjs";
import { writeContracts, readContracts } from "./api-coverage-contract-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/web/package.json"));
const ts = require("typescript");
const slash = value => value.replaceAll("\\", "/");
const walk = (dir, suffix) => readdirSync(dir, {withFileTypes:true}).flatMap(entry => entry.isDirectory() ? walk(join(dir,entry.name),suffix) : entry.name.endsWith(suffix) ? [join(dir,entry.name)] : []);
const fail = message => { throw new Error(message); };
const textName = node => ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : fail("Unresolved SDK name");

/** Resolve every transport binding; fail instead of dropping unsupported inputs. */
export function transportBindings(file, source) {
	const {ast,methods}=canonicalSdkMethods(file,source);
	const rows=[];
	for(const {method,call:node,verb,pathMap,queryParameter} of methods) {
			const names=method.parameters.map(p=>textName(p.name));
			const path=node.arguments[0].text;
			const httpVerb=verb.toUpperCase();
			const parameters=[];
			const add=(name,location,extra={})=> {
				const parameterIndex=names.indexOf(name);
				if(parameterIndex<0) fail(`Unresolved SDK parameter: ${file} ${name}`);
				parameters.push({name,parameterIndex,location,...extra});
			};
			const paths=pathMap;
			if(!paths || !ts.isObjectLiteralExpression(paths)) fail(`Unresolved SDK path map: ${file}`);
			const wireNames=[];
			for(const property of paths.properties) {
				if(!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) fail(`Unresolved SDK path mapping: ${file}`);
				const value=ts.isShorthandPropertyAssignment(property)?property.name:property.initializer;
				if(!ts.isIdentifier(value)) fail(`Unresolved SDK path value: ${file}`);
				const wireName=textName(property.name);
				wireNames.push(wireName);
				add(value.text,"path",{wireName});
			}
			const placeholders=[...path.matchAll(/\{([^}]+)\}/g)].map(match=>match[1]);
			if(new Set(wireNames).size!==wireNames.length || JSON.stringify([...new Set(placeholders)].sort())!==JSON.stringify([...wireNames].sort())) fail(`SDK path placeholder mismatch: ${file}`);
			if(node.arguments.length>3) fail(`Unresolved SDK transport arguments: ${file}`);
			if(node.arguments[2]) {
				const argument=node.arguments[2];
				if(!ts.isIdentifier(argument)) fail(`Unresolved SDK request parameter: ${file}`);
				const location=httpVerb==="GET"?"query":"body";
				if(httpVerb==="DELETE") fail(`Unresolved DELETE request body: ${file}`);
				if(names.includes(argument.text)) add(argument.text,location,{binding:"direct"});
				else if(location==="query") add(queryParameter,location,{binding:"sdk-query-builder"});
				else fail(`Unresolved SDK body binding: ${file}`);
			}
			if(names.some((name,index)=>!parameters.some(p=>p.parameterIndex===index))) fail(`Unresolved unused SDK parameter: ${file}`);
			rows.push({identity:`${file.replace(/\.js$/,".d.ts")}#${method.name.getText(ast)}`,sdkMethod:`${slash(dirname(file)).replaceAll("/",".")}.${method.name.getText(ast)}`,path,httpVerb,parameterNames:names,parameters:parameters.sort((a,b)=>a.parameterIndex-b.parameterIndex)});
	}
	if(new Set(rows.map(row=>row.identity)).size!==rows.length) fail(`Duplicate SDK request operation: ${file}`);
	return rows;
}

function schemaGraph(checker,sdkRoot) {
	const schemas={};
	const seen=new Map();
	const evidence=declaration=> {
		const file=slash(relative(sdkRoot,declaration.getSourceFile().fileName));
		if(file.startsWith("../")||isAbsolute(file)) fail(`Unresolved non-SDK declaration: ${file}`);
		return {file,line:declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart()).line+1};
	};
	const documentation=symbol=>ts.displayPartsToString(symbol.getDocumentationComment(checker));
	function encode(type,at) {
		const label=checker.typeToString(type,at,ts.TypeFormatFlags.NoTruncation);
		const variants=type.isUnion()?type.types:undefined;
		if(variants?.length===1) return encode(variants[0],at);
		if(type.flags & ts.TypeFlags.Any) return {kind:"opaque",type:label,reason:"SDK any; acceptance unconfirmed"};
		if(type.flags & ts.TypeFlags.Unknown) return {kind:"opaque",type:label,reason:"SDK unknown; acceptance unconfirmed"};
		if(type.flags & ts.TypeFlags.Never) return {kind:"never"};
		if(label==="boolean") return {kind:"boolean"};
		const symbol=type.aliasSymbol??type.symbol;
		let enumDeclaration=symbol?.declarations?.find(ts.isEnumDeclaration);
		if(!enumDeclaration && variants?.length) {
			const parents=variants.map(t=>t.symbol?.declarations?.find(ts.isEnumMember)?.parent);
			if(parents[0] && parents.every(parent=>parent===parents[0]) && parents[0].members.length===variants.length) enumDeclaration=parents[0];
		}
		if(enumDeclaration) {
			const key=`${evidence(enumDeclaration).file}#${enumDeclaration.name.text}`;
			if(!schemas[key]) schemas[key]={kind:"enum",values:enumDeclaration.members.map(member=>{const value=checker.getConstantValue(member);return value===undefined?fail(`Unresolved SDK enum value: ${key}`):value;}),sdkEvidence:evidence(enumDeclaration)};
			return {ref:key};
		}
		if(variants) return {kind:"union",variants:variants.map(t=>encode(t,at))};
		if(type.isIntersection()) return {kind:"intersection",variants:type.types.map(t=>encode(t,at))};
		if(type.isStringLiteral() || type.isNumberLiteral()) return {kind:typeof type.value,literal:type.value};
		if(type.flags & ts.TypeFlags.BooleanLiteral) return {kind:"boolean",literal:label==="true"};
		if(type.flags & ts.TypeFlags.String) return {kind:"string"};
		if(type.flags & ts.TypeFlags.Number) return {kind:"number"};
		if(type.flags & ts.TypeFlags.Null) return {kind:"null"};
		if(type.flags & ts.TypeFlags.Undefined) return {kind:"undefined"};
		if(checker.isTupleType(type)) return {kind:"tuple",items:checker.getTypeArguments(type).map(t=>encode(t,at))};
		if(checker.isArrayType(type)) return {kind:"array",items:encode(checker.getTypeArguments(type)[0],at)};
		if(checker.getSignaturesOfType(type,ts.SignatureKind.Call).length) return {kind:"function",type:label,scope:"SDK callable helper; not wire fields"};
		if(!(type.flags & ts.TypeFlags.Object)) return {kind:"opaque",type:label,reason:"SDK type not expanded; acceptance unconfirmed"};
		if(seen.has(type)) return {ref:seen.get(type)};
		const declaration=symbol?.declarations?.find(d=>ts.isClassDeclaration(d)||ts.isInterfaceDeclaration(d)||ts.isTypeAliasDeclaration(d)||ts.isTypeLiteralNode(d))??at;
		if(/\/typescript\/lib\/lib\.[^/]+\.d\.ts$/.test(slash(declaration.getSourceFile().fileName))) return {kind:"builtin",type:label,scope:"TypeScript builtin; wire representation unconfirmed"};
		const source=evidence(declaration);
		const key=`${source.file}#${symbol && symbol.name!=="__type" ? symbol.name : `anonymous:${declaration.getStart()}`}`;
		if(schemas[key]) fail(`Duplicate SDK schema identity: ${key}`);
		seen.set(type,key);
		const row={kind:"object",sdkEvidence:source,properties:[]};
		schemas[key]=row;
		for(const property of checker.getPropertiesOfType(type)) {
			const d=property.valueDeclaration??property.declarations?.[0];
			if(!d || !(ts.isPropertyDeclaration(d)||ts.isPropertySignature(d))) continue;
			if(d.modifiers?.some(m=>[ts.SyntaxKind.PrivateKeyword,ts.SyntaxKind.ProtectedKeyword,ts.SyntaxKind.StaticKeyword].includes(m.kind))) continue;
			const doc=documentation(property);
			const entry={name:property.name,optional:!!(property.flags&ts.SymbolFlags.Optional),sdkReadonly:!!d.modifiers?.some(m=>m.kind===ts.SyntaxKind.ReadonlyKeyword),apiWriteability:"unconfirmed",type:encode(d.type?checker.getTypeFromTypeNode(d.type):checker.getTypeOfSymbolAtLocation(property,d),d.type??d),sdkEvidence:evidence(d)};
			if(doc) entry.documentation=doc;
			const tags=property.getJsDocTags(checker).map(tag=>({name:tag.name,text:ts.displayPartsToString(tag.text)}));
			if(tags.length) entry.sdkDocTags=tags;
			row.properties.push(entry);
		}
		row.properties.sort((a,b)=>a.name.localeCompare(b.name));
		const indexes=checker.getIndexInfosOfType(type);
		if(indexes.length) row.additionalProperties=indexes.map(index=>({key:encode(index.keyType,at),value:encode(index.type,at),sdkReadonly:index.isReadonly}));
		return {ref:key};
	}
	return {schemas,encode,evidence};
}

/** Fixture-capable generator. Reads SDK sources; never imports/executes SDK JS. */
export function buildRequestContracts({sdkRoot,files,sdkVersion}) {
	const sources=[...files].sort();
	if(new Set(sources).size!==sources.length) fail("Duplicate SDK files");
	const operations=sources.flatMap(file=>enumerateOperations(slash(relative(sdkRoot,file)),readFileSync(file,"utf8")));
	const bindings=sources.flatMap(file=>transportBindings(slash(relative(sdkRoot,file)),readFileSync(file,"utf8")));
	if(JSON.stringify(operations.map(row=>row.identity))!==JSON.stringify(bindings.map(row=>row.identity))) fail("SDK operation/request denominator mismatch");
	const program=ts.createProgram(sources.map(file=>file.replace(/\.js$/,".d.ts")),{noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,strictNullChecks:true,skipLibCheck:false});
	const diagnostics=[...program.getSyntacticDiagnostics(),...program.getSemanticDiagnostics()].filter(d=>d.file && !slash(relative(sdkRoot,d.file.fileName)).startsWith("../"));
	if(diagnostics.length) fail(`Unresolved SDK declaration: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText," ")}`);
	const checker=program.getTypeChecker();
	const declaredOperations=sources.flatMap(file=> {
		const declarationFile=file.replace(/\.js$/,".d.ts");
		const declaration=program.getSourceFile(declarationFile);
		if(!declaration) fail(`Unresolved SDK declaration: ${declarationFile}`);
		return declaration.statements.filter(ts.isClassDeclaration).flatMap(owner=>owner.members.filter(member=>ts.isMethodDeclaration(member)&&!member.modifiers?.some(modifier=>[ts.SyntaxKind.PrivateKeyword,ts.SyntaxKind.ProtectedKeyword,ts.SyntaxKind.StaticKeyword].includes(modifier.kind))).map(member=>`${slash(relative(sdkRoot,declarationFile))}#${member.name.getText(declaration)}`));
	});
	if(JSON.stringify([...declaredOperations].sort())!==JSON.stringify(operations.map(row=>row.identity).sort())) fail("SDK public method declaration/operation denominator mismatch");
	const graph=schemaGraph(checker,sdkRoot);
	const rows=bindings.map(binding=> {
		const [file,name]=binding.identity.split("#");
		const source=program.getSourceFile(join(sdkRoot,file));
		const declarations=[];
		function find(node) {if(ts.isMethodDeclaration(node)&&node.name.getText(source)===name)declarations.push(node);ts.forEachChild(node,find);}
		if(!source) fail(`Unresolved SDK declaration: ${file}`);
		find(source);
		if(declarations.length!==1) fail(`Unresolved SDK method declaration: ${binding.identity}`);
		const declaration=declarations[0];
		if(declaration.parameters.length!==binding.parameterNames.length || declaration.parameters.some((p,i)=>p.name.getText(source)!==binding.parameterNames[i])) fail(`SDK signature parameter mismatch: ${binding.identity}`);
		const {identity:_identity,parameterNames:_names,...row}=binding;
		row.sdkEvidence=graph.evidence(declaration);
		row.parameters=binding.parameters.map(parameter=> {
			const d=declaration.parameters[parameter.parameterIndex];
			if(!d.type) fail(`Unresolved SDK parameter type: ${binding.identity}`);
			return {...parameter,optional:!!d.questionToken,type:graph.encode(checker.getTypeFromTypeNode(d.type),d.type),sdkEvidence:graph.evidence(d)};
		});
		return row;
	});
	const sdkFiles=[...sources,...program.getSourceFiles().map(file=>file.fileName).filter(file=>{const path=relative(sdkRoot,file);return !path.startsWith("../")&&!isAbsolute(path);})].sort();
	const hash=createHash("sha256");
	for(const file of new Set(sdkFiles)) hash.update(slash(relative(sdkRoot,file))).update("\0").update(readFileSync(file)).update("\0");
	const parameters=rows.flatMap(row=>row.parameters);
	return {schemaVersion:1,provenance:{generatedAt:new Date().toISOString(),sdkVersion,typescriptVersion:ts.version,sdkFingerprint:hash.digest("hex"),method:"sdk-transport-request-contracts-v1",scope:"encoding",limitations:"SDK declarations and comments, not the complete server contract. API writeability and conditional acceptance remain unconfirmed. Callable query-builder alternatives are SDK helpers, not wire fields."},summary:{totalOperations:rows.length,pathParameters:parameters.filter(p=>p.location==="path").length,queryParameters:parameters.filter(p=>p.location==="query").length,bodyParameters:parameters.filter(p=>p.location==="body").length,schemas:Object.keys(graph.schemas).length,properties:Object.values(graph.schemas).reduce((n,s)=>n+(s.properties?.length??0),0)},operations:rows,schemas:Object.fromEntries(Object.entries(graph.schemas).sort(([a],[b])=>a.localeCompare(b)))};
}

export function contractContent({provenance,...contract}) {
	const {generatedAt:_generatedAt,...facts}=provenance;
	return {...contract,provenance:facts};
}

export function generateContracts() {
	const sdkPackage=dirname(realpathSync(require.resolve("@bitmovin/api-sdk/package.json")));
	const sdkRoot=join(sdkPackage,"dist");
	const result=buildRequestContracts({sdkRoot,files:walk(join(sdkRoot,"encoding"),"Api.js"),sdkVersion:JSON.parse(readFileSync(join(sdkPackage,"package.json"),"utf8")).version});
	if(result.operations.length<1000) fail("Incomplete Encoding request contract denominator");
	return result;
}

if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
	const mode=process.argv[2];
	if(!["--write","--check"].includes(mode)) { console.error("Usage: node scripts/api-coverage-contracts.mjs --write | --check"); process.exitCode=1; }
	else {
		try {
			const file=join(root,"apps/web/src/data/api-coverage/contracts.json");
			const contract=generateContracts();
			if(mode==="--write") writeContracts(file,contract);
			else if(JSON.stringify(contractContent(readContracts(file)))!==JSON.stringify(contractContent(contract))) fail("SDK request contracts are stale. Run node scripts/api-coverage-contracts.mjs --write");
			console.log(JSON.stringify({mode,sdkVersion:contract.provenance.sdkVersion,...contract.summary}));
		} catch(error) { console.error(error.message); process.exitCode=1; }
	}
}
