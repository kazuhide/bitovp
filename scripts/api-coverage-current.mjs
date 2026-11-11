/** Offline Encoding-operation census. Source evidence is not runtime/paid proof.
 * No SDK code is executed. Unresolved wrappers/dynamic dispatch remain unconfirmed.
 * node scripts/api-coverage-current.mjs --write | --check | --check-exact
 *
 * --check compares what the census states: the SDK surface, which operations and
 * body fields the source reaches, and from which files. Unrelated source changes
 * and shifted line numbers do not make it stale. --check-exact also requires the
 * recorded source fingerprint, compiler version and line numbers to match; release
 * preparation refreshes them with --write.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { enumerateBodyParameters, createRequestFieldAudit } from "./api-coverage-fields.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/web/package.json"));
const ts = require("typescript");
const VERBS = new Set(["get", "post", "put", "patch", "delete"]);
const slash = (value) => value.replaceAll("\\", "/");
const excluded = (file) => /(?:^|\/)(?:__tests__|__fixtures__|__mocks__|test|tests|test-fixtures|generated)(?:\/)|\.(?:test|spec)\.[^.]+$|\.d\.ts$|\/(?:fake-sdk|test-helpers|test-support|schema-fixtures)\.[^.]+$/.test(slash(file));

export function enumerateOperations(file, source) {
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	if (ast.parseDiagnostics.length) throw new Error(`Cannot parse SDK source: ${file}`);
	const rows = [];
	function visit(node, method) {
		if (ts.isMethodDeclaration(node)) method = node.name.getText(ast);
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const access = node.expression;
			if (access.expression.getText(ast) === "this.restClient" && VERBS.has(access.name.text)) {
				const path = node.arguments[0];
				if (!method || !path || !ts.isStringLiteralLike(path)) throw new Error(`Non-literal SDK transport: ${file}`);
				if (!path.text.startsWith("/encoding/")) throw new Error(`Unexpected Encoding path: ${file}`);
				const dir = slash(dirname(file));
				rows.push({ identity: `${file.replace(/\.js$/, ".d.ts")}#${method}`, path: path.text, httpVerb: access.name.text.toUpperCase(), operation: method, sdkMethod: `${dir.replaceAll("/", ".")}.${method}`, family: dir.split("/")[1] });
			}
		}
		ts.forEachChild(node, (child) => visit(child, method));
	}
	visit(ast);
	return rows;
}

export function collectEvidence({ root, sdkRoot, files, operations, options, onProgram, onCall }) {
	const selected = files.filter((file) => !excluded(file)).sort();
	const program = ts.createProgram(selected, { ...options, noEmit: true, incremental: false });
	const checker = program.getTypeChecker();
	onProgram?.(program);
	const allowed = new Set(operations.map((row) => row.identity));
	const evidence = new Map();
	for (const file of selected) {
		const source = program.getSourceFile(file);
		if (!source) throw new Error(`Source unavailable: ${file}`);
		function visit(node) {
			if (ts.isCallExpression(node)) {
				// A union call may resolve to one representative declaration. Do not
				// present that arbitrary member as proof for every runtime branch.
				const type = checker.getTypeAtLocation(node.expression);
				if (!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Union))) {
					const declaration = checker.getResolvedSignature(node)?.declaration;
					if (declaration && ts.isMethodDeclaration(declaration)) {
						const sdkFile = slash(relative(sdkRoot, declaration.getSourceFile().fileName));
						const identity = `${sdkFile}#${declaration.name.getText()}`;
						if (allowed.has(identity)) {
								onCall?.({ identity, node, source, checker });
							const item = { file: slash(relative(root, file)), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 };
							const entries = evidence.get(identity) ?? [];
							if (!entries.some((old) => old.file === item.file && old.line === item.line)) entries.push(item);
							evidence.set(identity, entries);
						}
					}
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
	return evidence;
}

function hashFiles(files, base) {
	const hash = createHash("sha256");
	for (const file of [...files].sort()) hash.update(slash(relative(base, file))).update("\0").update(readFileSync(file)).update("\0");
	return hash.digest("hex");
}

export function generateCensus() {
	const sdkRoot = join(dirname(realpathSync(require.resolve("@bitmovin/api-sdk/package.json"))), "dist");
	const sdkVersion = require("@bitmovin/api-sdk/package.json").version;
	const sdkFiles = [];
	function walk(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (entry.name.endsWith("Api.js")) sdkFiles.push(file);
		}
	}
	walk(join(sdkRoot, "encoding"));
	const operations = sdkFiles.sort().flatMap((file) => enumerateOperations(slash(relative(sdkRoot, file)), readFileSync(file, "utf8")));
	const bodyOperations = sdkFiles.flatMap((file) => enumerateBodyParameters(slash(relative(sdkRoot, file)), readFileSync(file, "utf8")));
	const requestFields = createRequestFieldAudit({ root, sdkRoot, bodyOperations });
	const modelDeclarations = readdirSync(join(sdkRoot, "models")).filter((file) => file.endsWith(".d.ts")).map((file) => join(sdkRoot, "models", file));
	if (operations.length < 1000 || new Set(operations.map((row) => row.identity)).size !== operations.length) throw new Error("Incomplete or duplicate SDK operation census");
	const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0");
	const files = tracked.filter((file) => /^(?:apps\/(?:web|worker)|packages\/(?:core|db|storage))\/src\/.*\.tsx?$/.test(file) && !excluded(file)).map((file) => join(root, file));
	const evidence = new Map();
	const configs = [];
	for (const workspace of ["apps/web", "apps/worker", "packages/core", "packages/db", "packages/storage"]) {
		const config = join(root, workspace, "tsconfig.json");
		configs.push(config);
		const loaded = ts.readConfigFile(config, ts.sys.readFile);
		if (loaded.error) throw new Error(`Cannot read ${config}`);
		const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(config));
		if (parsed.errors.length) throw new Error(`Invalid compiler configuration: ${config}`);
		const ownFiles = files.filter((file) => file.startsWith(`${join(root, workspace)}/`));
		const own = collectEvidence({ root, sdkRoot, files: ownFiles, operations, options: parsed.options, onProgram: requestFields.observeProgram, onCall: requestFields.observeCall });
		for (const [id, entries] of own) evidence.set(id, [...(evidence.get(id) ?? []), ...entries]);
	}
	const endpoints = operations.map(({ identity, ...row }) => ({ ...row, status: evidence.has(identity) ? "source-confirmed" : "unconfirmed", evidence: evidence.get(identity) ?? [] }));
	const tally = (rows) => ({ totalOperations: rows.length, sourceConfirmed: rows.filter((r) => r.status === "source-confirmed").length, unconfirmed: rows.filter((r) => r.status === "unconfirmed").length });
	const creates = endpoints.filter((row) => row.operation === "create");
	return {
		schemaVersion: 1,
		provenance: { generatedAt: new Date().toISOString(), sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), sourceFingerprint: hashFiles([...files, ...configs, join(root, "tsconfig.base.json"), join(root, "pnpm-lock.yaml"), fileURLToPath(import.meta.url), join(root, "scripts/api-coverage-fields.mjs")], root), sdkVersion, typescriptVersion: ts.version, sdkFingerprint: hashFiles([...sdkFiles.flatMap((file) => [file, file.replace(/\.js$/, ".d.ts")]), ...modelDeclarations], sdkRoot), method: "typescript-resolved-sdk-signatures-v1", scope: "encoding" },
		summary: { ...tally(endpoints), createTotal: creates.length, createSourceConfirmed: tally(creates).sourceConfirmed },
		families: [...new Set(endpoints.map((r) => r.family))].sort().map((family) => { const t = tally(endpoints.filter((r) => r.family === family)); return { family, total: t.totalOperations, sourceConfirmed: t.sourceConfirmed, unconfirmed: t.unconfirmed }; }),
		endpoints,
		requestFields: requestFields.finish(),
	};
}

// The time and commit of a generation run never take part in a check.
const NEVER_COMPARED = ["generatedAt", "sourceCommit"];
// Unrelated source changes move these; only --check-exact requires them to match.
const EXACT_ONLY = ["sourceFingerprint", "typescriptVersion"];
const SECTIONS = ["schemaVersion", "provenance", "summary", "families", "endpoints", "requestFields"];
// An evidence entry is a position. Any other attribute would be content and must be compared.
const POSITION = ["file", "line", "callLine"];
const REFRESH = "Regenerate it with: node scripts/api-coverage-current.mjs --write";

function evidenceFiles(evidence) {
	const counts = new Map();
	for (const entry of evidence) {
		const unknown = Object.keys(entry).filter((key) => !POSITION.includes(key));
		if (unknown.length) throw new Error(`Unknown evidence attribute: ${unknown.join(", ")}`);
		counts.set(entry.file, (counts.get(entry.file) ?? 0) + 1);
	}
	return [...counts.keys()].sort().map((file) => (counts.get(file) > 1 ? `${file} x${counts.get(file)}` : file));
}

/** One entry per stated fact. Unknown sections, unknown evidence attributes and colliding entries fail closed. */
export function censusContent(census) {
	const unknown = Object.keys(census).filter((key) => !SECTIONS.includes(key));
	if (unknown.length) throw new Error(`Unknown census section: ${unknown.join(", ")}`);
	const entries = new Map();
	const add = (key, value) => {
		if (entries.has(key)) throw new Error(`Ambiguous census entry: ${key}`);
		entries.set(key, value);
	};
	const provenance = Object.fromEntries(Object.entries(census.provenance).filter(([key]) => !NEVER_COMPARED.includes(key) && !EXACT_ONLY.includes(key)));
	add("census", { schemaVersion: census.schemaVersion, ...provenance });
	add("summary", census.summary);
	for (const family of census.families) add(`family ${family.family}`, family);
	for (const { evidence, ...endpoint } of census.endpoints) add(`${endpoint.sdkMethod} (${endpoint.httpVerb} ${endpoint.path})`, { ...endpoint, evidence: evidenceFiles(evidence) });
	const { operations, summary, ...fieldAudit } = census.requestFields;
	add("request fields", fieldAudit);
	add("request fields summary", summary);
	for (const { fields, ...operation } of operations) {
		const key = `${operation.sdkMethod} (${operation.httpVerb} ${operation.path}) body`;
		add(key, operation);
		for (const { evidence, ...field } of fields) add(`${key} field ${field.name}`, { ...field, evidence: evidenceFiles(evidence) });
	}
	return entries;
}

function describeChange(before, after) {
	if (Array.isArray(before) && Array.isArray(after)) {
		const removed = before.filter((item) => !after.includes(item)).map((item) => `-${item}`);
		const added = after.filter((item) => !before.includes(item)).map((item) => `+${item}`);
		if (removed.length || added.length) return [...removed, ...added].join(" ");
	}
	return `${JSON.stringify(before)} -> ${JSON.stringify(after)}`;
}

// A census that cannot be read entry by entry is reported with the side it came from.
function contentOf(census, side) {
	try {
		return censusContent(census);
	} catch (error) {
		throw new Error(`The ${side} census cannot be compared: ${error.message}`);
	}
}

/** Readable differences between the committed census and the one the source produces. */
export function censusDifferences(saved, current) {
	const before = contentOf(saved, "committed");
	const after = contentOf(current, "generated");
	const lines = [];
	for (const key of new Set([...before.keys(), ...after.keys()])) {
		const a = before.get(key);
		const b = after.get(key);
		if (a === undefined) lines.push(`${key}: missing from the committed census`);
		else if (b === undefined) lines.push(`${key}: no longer produced by the source`);
		else for (const property of new Set([...Object.keys(a), ...Object.keys(b)])) {
			if (JSON.stringify(a[property]) !== JSON.stringify(b[property])) lines.push(`${key}: ${property} ${describeChange(a[property], b[property])}`);
		}
	}
	return lines;
}

/** Differences that only an exact refresh removes. Call after the content matches. */
export function censusRunDifferences(saved, current) {
	const lines = [];
	for (const key of EXACT_ONLY) {
		if (saved.provenance[key] !== current.provenance[key]) lines.push(`provenance: ${key} ${JSON.stringify(saved.provenance[key])} -> ${JSON.stringify(current.provenance[key])}`);
	}
	const body = ({ provenance: _provenance, ...rest }) => JSON.stringify(rest);
	if (body(saved) !== body(current)) lines.push("evidence line numbers or entry order differ");
	return lines;
}

/** Runs one mode against a census file and returns what to print and the exit status. */
export function runCensus(mode, file, generate = generateCensus) {
	// An unknown mode is refused before the census is generated.
	if (!["--write", "--check", "--check-exact"].includes(mode)) return { status: 1, stdout: [], stderr: ["Usage: node scripts/api-coverage-current.mjs --write | --check | --check-exact"] };
	const current = generate();
	const passed = [JSON.stringify({ mode, sdkVersion: current.provenance.sdkVersion, ...current.summary, sourceFingerprint: current.provenance.sourceFingerprint })];
	if (mode === "--write") {
		writeFileSync(file, `${JSON.stringify(current, null, "\t")}\n`);
		return { status: 0, stdout: passed, stderr: [] };
	}
	let differences;
	try {
		const saved = JSON.parse(readFileSync(file, "utf8"));
		differences = censusDifferences(saved, current);
		if (!differences.length) {
			const run = censusRunDifferences(saved, current);
			if (mode === "--check-exact") differences = run;
			// The content is current; say when the release-only refresh is still owed.
			else if (run.length) passed.push("Note: the committed census records an older source fingerprint or line numbers. Release gates require an exact refresh.");
		}
	} catch (error) {
		return { status: 1, stdout: [], stderr: [`API census cannot be checked: ${error.message}`, REFRESH] };
	}
	if (!differences.length) return { status: 0, stdout: passed, stderr: [] };
	const shown = differences.slice(0, 40).map((line) => `  ${line}`);
	if (differences.length > shown.length) shown.push(`  ... and ${differences.length - shown.length} more`);
	return { status: 1, stdout: [], stderr: [`API census is stale: ${differences.length} difference${differences.length === 1 ? "" : "s"} from the source.`, ...shown, REFRESH] };
}

// The real path: a symlinked invocation must run, not exit 0 having done nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const result = runCensus(process.argv[2], join(root, "apps/web/src/data/api-coverage/current.json"));
	for (const line of result.stdout) console.log(line);
	for (const line of result.stderr) console.error(line);
	process.exitCode = result.status;
}
