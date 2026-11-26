import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import { parse } from "yaml";
import workerConfig from "../../../apps/worker/vitest.config";
import workerFenceConfig from "../../../apps/worker/vitest.hierarchical-flow.config";
import fence from "../../../hierarchical-flow-fence.json";
import dbConfig from "../../db/vitest.config";
import dbFenceConfig from "../../db/vitest.hierarchical-flow.config";
import coreConfig from "../vitest.config";
import coreFenceConfig from "../vitest.hierarchical-flow.config";

// Enforces hierarchical-flow-fence.json. Production code must not import the
// fenced hierarchical story flow, and its tests run only in the dedicated run.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(posix.join(root, path), "utf8");
const isTest = (path: string) => /\.test\.[cm]?[jt]sx?$/.test(path);
const isSource = (path: string) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path);
const EXTENSIONS = [
	".ts",
	".tsx",
	".d.ts",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "generated", "dist"]);

/** A pattern with at most one `*`, as in `exports` keys and tsconfig `paths`. */
function matchPattern(pattern: string, value: string): string | undefined {
	const star = pattern.indexOf("*");
	if (star < 0) return pattern === value ? "" : undefined;
	const prefix = pattern.slice(0, star);
	const suffix = pattern.slice(star + 1);
	return value.length >= prefix.length + suffix.length &&
		value.startsWith(prefix) &&
		value.endsWith(suffix)
		? value.slice(prefix.length, value.length - suffix.length)
		: undefined;
}

type Alias = { pattern: string; targets: string[] };
function tsconfigAliases(dir: string): Alias[] {
	const file = posix.join(root, dir, "tsconfig.json");
	if (!existsSync(file)) return [];
	const { options } = ts.parseJsonConfigFileContent(
		ts.readConfigFile(file, ts.sys.readFile).config,
		{ ...ts.sys, readDirectory: () => [] },
		posix.join(root, dir),
	);
	const base =
		options.baseUrl ??
		(typeof options.pathsBasePath === "string"
			? options.pathsBasePath
			: posix.join(root, dir));
	return Object.entries(options.paths ?? {}).map(([pattern, targets]) => ({
		pattern,
		targets: targets.map((target) =>
			posix.relative(root, posix.resolve(base, target)),
		),
	}));
}

const workspaces = ["apps", "packages"].flatMap((group) =>
	readdirSync(posix.join(root, group), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => `${group}/${entry.name}`)
		.filter((dir) => existsSync(posix.join(root, dir, "package.json")))
		.map((dir) => {
			const manifest: { name: string; exports?: unknown } = JSON.parse(
				read(`${dir}/package.json`),
			);
			return {
				dir,
				name: manifest.name,
				exports: manifest.exports,
				aliases: tsconfigAliases(dir),
			};
		}),
);

/** Every file of every workspace, outside dependencies and build output. */
const files = new Set<string>();
function walk(dir: string) {
	for (const entry of readdirSync(posix.join(root, dir), {
		withFileTypes: true,
	})) {
		const path = `${dir}/${entry.name}`;
		if (!entry.isDirectory()) files.add(path);
		else if (
			!SKIPPED_DIRECTORIES.has(entry.name) &&
			!entry.name.startsWith(".")
		)
			walk(path);
	}
}
for (const { dir } of workspaces) walk(dir);

/** Every string target of an `exports` value, under any condition. */
function exportLeaves(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (value && typeof value === "object")
		return Object.values(value).flatMap(exportLeaves);
	return [];
}
function exportedPaths(
	workspace: (typeof workspaces)[number],
	subpath: string,
): string[] {
	const { exports } = workspace;
	const map: Record<string, unknown> =
		exports &&
		typeof exports === "object" &&
		Object.keys(exports).every((key) => key.startsWith("."))
			? { ...exports }
			: { ".": exports };
	return Object.entries(map).flatMap(([key, value]) => {
		const matched = matchPattern(key, subpath);
		return matched === undefined
			? []
			: exportLeaves(value).map((leaf) =>
					posix.join(
						workspace.dir,
						leaf.replaceAll("*", () => matched),
					),
				);
	});
}

/** The files a path without a resolved extension may name. */
function candidates(base: string): string[] {
	const path = posix.normalize(base);
	// TypeScript sources are imported with or without a JavaScript extension.
	const stem = path.replace(/\.[cm]?jsx?$/, "");
	return [
		path,
		...[stem, `${path}/index`].flatMap((prefix) =>
			EXTENSIONS.map((extension) => prefix + extension),
		),
	];
}

/**
 * The workspace files an import specifier may resolve to: relative paths,
 * workspace packages through `exports` or by direct path, tsconfig `paths`.
 */
function resolveSpecifier(from: string, specifier: string): string[] {
	const bases: string[] = [];
	if (/^\.\.?(?:\/|$)/.test(specifier))
		bases.push(posix.join(posix.dirname(from), specifier));
	for (const workspace of workspaces) {
		if (specifier === workspace.name)
			bases.push(...exportedPaths(workspace, "."));
		else if (specifier.startsWith(`${workspace.name}/`)) {
			const subpath = `.${specifier.slice(workspace.name.length)}`;
			bases.push(
				...exportedPaths(workspace, subpath),
				posix.join(workspace.dir, subpath),
			);
		}
		if (!from.startsWith(`${workspace.dir}/`)) continue;
		for (const alias of workspace.aliases) {
			const matched = matchPattern(alias.pattern, specifier);
			if (matched !== undefined)
				bases.push(
					...alias.targets.map((target) => target.replace("*", () => matched)),
				);
		}
	}
	return [...new Set(bases.flatMap(candidates))].filter((path) =>
		files.has(path),
	);
}

/** Every module specifier a source file names, with its line. */
function specifiersIn(path: string, text: string) {
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest);
	const found: { specifier: string; line: number }[] = [];
	const add = (node: ts.Node, specifier: ts.Node | undefined) => {
		// A specifier that is not a string literal cannot be resolved.
		if (!specifier || !ts.isStringLiteralLike(specifier)) return;
		const { line } = source.getLineAndCharacterOfPosition(
			node.getStart(source),
		);
		found.push({ specifier: specifier.text, line: line + 1 });
	};
	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			add(node, node.moduleSpecifier);
		else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		)
			add(node, node.moduleReference.expression);
		else if (ts.isImportTypeNode(node))
			add(
				node,
				ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined,
			);
		else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) &&
					node.expression.text === "require"))
		)
			add(node, node.arguments[0]);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

const entryFiles = Object.values(fence.entries);
const fenced = new Set([...fence.modules, ...fence.tests, ...entryFiles]);
function fencedImports(path: string, text = read(path)): string[] {
	return specifiersIn(path, text).flatMap(({ specifier, line }) =>
		resolveSpecifier(path, specifier)
			.filter((target) => fenced.has(target))
			.map((target) => `${path}:${line} imports "${specifier}" (${target})`),
	);
}

const WORKFLOW = ".github/workflows/hierarchical-flow.yml";
const DEDICATED_CONFIG = "vitest.hierarchical-flow.config.ts";
const runs = [
	{
		dir: "apps/worker",
		name: "@bitovp/worker",
		standard: workerConfig,
		dedicated: workerFenceConfig,
	},
	{
		dir: "packages/core",
		name: "@bitovp/core",
		standard: coreConfig,
		dedicated: coreFenceConfig,
	},
	{
		dir: "packages/db",
		name: "@bitovp/db",
		standard: dbConfig,
		dedicated: dbFenceConfig,
	},
];

describe("hierarchical flow fence", () => {
	it("lists existing files, each in exactly one list", () => {
		const listed = [
			...fence.modules,
			...fence.tests,
			...entryFiles,
			...fence.outside,
		];
		expect(listed.filter((path) => !files.has(path))).toEqual([]);
		expect(
			listed.filter((path, index) => listed.indexOf(path) !== index),
		).toEqual([]);
		expect(fence.modules.filter(isTest)).toEqual([]);
		expect(fence.tests.filter((path) => !isTest(path))).toEqual([]);
	});

	it("exports each fenced entry under its specifier", () => {
		for (const [specifier, file] of Object.entries(fence.entries))
			expect(resolveSpecifier("package.json", specifier), specifier).toEqual([
				file,
			]);
	});

	it("accounts for every local-story-flow-* and library-flow-* file", () => {
		const listed = new Set([...fenced, ...fence.outside]);
		expect(
			[...files].filter(
				(path) =>
					/^(?:local-story-flow-|library-flow-)/.test(posix.basename(path)) &&
					!listed.has(path),
			),
			"List the file under modules, tests or outside in hierarchical-flow-fence.json.",
		).toEqual([]);
	});

	// Parses every production source file. Measured: 1 s alone, 3 s inside this
	// package's run, over the default 5 s when every package runs at once.
	it("keeps production code from importing the fence", () => {
		const production = [...files].filter(
			(path) => isSource(path) && !isTest(path) && !fenced.has(path),
		);
		// One file of each kind the scan has to reach: each workspace, scripts
		// beside the sources, .tsx and .mjs, and a name that contains "test".
		const reached = new Set(production);
		expect(
			[
				"packages/core/src/content-editing/index.ts",
				"packages/db/src/index.ts",
				"packages/db/scripts/migrate.ts",
				"packages/storage/src/index.ts",
				"apps/worker/src/index.ts",
				"apps/worker/scripts/vmaf-cloud-worker.mjs",
				"apps/web/src/app/layout.tsx",
				"apps/web/src/lib/server/latest-runs.ts",
				"apps/site/src/main.tsx",
			].filter((path) => !reached.has(path)),
		).toEqual([]);
		expect(
			production.flatMap((path) => fencedImports(path)),
			"Only fenced modules and tests may import the fence. See hierarchical-flow-fence.json.",
		).toEqual([]);
	}, 60_000);

	it("detects every form of import into the fence", () => {
		const [fencedModule] = fence.modules;
		const [specifier] = Object.keys(fence.entries);
		const [entry] = entryFiles;
		if (!fencedModule || !specifier || !entry)
			throw new Error("The fence is empty: remove it and this test.");
		const bare = `./${fencedModule.replace(/\.ts$/, "")}`;
		const probe = [
			`import "${bare}";`,
			`import type { A } from "${bare}.js";`,
			`export * from "${bare}.ts";`,
			`export { b } from "${specifier}";`,
			`const c = await import("${bare}");`,
			`type D = typeof import("${specifier}");`,
			`import e = require("${bare}");`,
			`const f = require("${bare}");`,
			`const g = await import(\`${bare}\`);`,
		];
		expect(fencedImports("probe.ts", probe.join("\n"))).toEqual(
			[
				[bare, fencedModule],
				[`${bare}.js`, fencedModule],
				[`${bare}.ts`, fencedModule],
				[specifier, entry],
				[bare, fencedModule],
				[specifier, entry],
				[bare, fencedModule],
				[bare, fencedModule],
				[bare, fencedModule],
			].map(
				([named, target], index) =>
					`probe.ts:${index + 1} imports "${named}" (${target})`,
			),
		);
	});

	it("resolves directories, package roots and path aliases", () => {
		expect(
			resolveSpecifier("packages/core/src/index.ts", "./content-editing"),
		).toEqual(["packages/core/src/content-editing/index.ts"]);
		expect(resolveSpecifier("apps/worker/src/index.ts", "@bitovp/db")).toEqual([
			"packages/db/src/index.ts",
		]);
		expect(resolveSpecifier("apps/site/src/main.tsx", "@/app/layout")).toEqual([
			"apps/web/src/app/layout.tsx",
		]);
		// A workspace file named by its path, past the package's `exports`.
		expect(
			resolveSpecifier("package.json", "@bitovp/core/src/index.ts"),
		).toEqual(["packages/core/src/index.ts"]);
	});

	it("leaves the fenced tests out of the default runs and gives each a dedicated run", () => {
		const tests = [...fence.tests].sort();
		expect(
			runs
				.flatMap(({ dir, standard }) =>
					(standard.test?.exclude ?? [])
						.filter((pattern) => !configDefaults.exclude.includes(pattern))
						.map((pattern) => `${dir}/${pattern}`),
				)
				.sort(),
		).toEqual(tests);
		expect(
			runs
				.flatMap(({ dir, dedicated }) =>
					(dedicated.test?.include ?? []).map((pattern) => `${dir}/${pattern}`),
				)
				.sort(),
		).toEqual(tests);
		for (const { standard, dedicated } of runs) {
			expect(standard.test?.exclude).toEqual(
				expect.arrayContaining(configDefaults.exclude),
			);
			expect(dedicated.test?.exclude).toBeUndefined();
		}
	});

	// The dedicated runs count no skipped tests, so a fenced test that skipped
	// itself would stop running without a failure anywhere.
	it("lets no fenced test skip itself or others", () => {
		const skipping = /\.(?:skip|skipIf|runIf|todo|only)\b/;
		expect(skipping.test("it.skip(")).toBe(true);
		expect(skipping.test("describe.runIf(ready)(")).toBe(true);
		expect(skipping.test("context.skip()")).toBe(true);
		expect(fence.tests.filter((path) => skipping.test(read(path)))).toEqual([]);
	});

	it("runs every dedicated configuration from the root script and the workflow", () => {
		const { scripts }: { scripts: Record<string, string> } = JSON.parse(
			read("package.json"),
		);
		for (const { name } of runs)
			expect(scripts["test:hierarchical-flow"]).toContain(
				`pnpm --filter ${name} exec vitest run --config ${DEDICATED_CONFIG}`,
			);
		const workflow: {
			on: { pull_request: { paths: string[] }; push: { paths: string[] } };
		} = parse(read(WORKFLOW));
		expect(read(WORKFLOW)).toContain("run: pnpm test:hierarchical-flow");
		// GitHub path filters: `**/` spans directories, `*` stays inside one.
		const filter = (pattern: string) => {
			const literal = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
			const body = literal.replace(/\*\*\/|\*\*|\*/g, (wildcard) =>
				wildcard === "**/" ? "(?:.*/)?" : wildcard === "**" ? ".*" : "[^/]*",
			);
			return new RegExp(`^${body}$`);
		};
		const watched = [
			...fenced,
			"hierarchical-flow-fence.json",
			WORKFLOW,
			...runs.map(({ dir }) => `${dir}/${DEDICATED_CONFIG}`),
		];
		for (const paths of [
			workflow.on.pull_request.paths,
			workflow.on.push.paths,
		])
			expect(
				watched.filter(
					(path) => !paths.some((pattern) => filter(pattern).test(path)),
				),
			).toEqual([]);
	});
});
