import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Published npm4.0.7 tarball, SHA512 verified; MIT notice remains in the package.
export const PICOMATCH_VERSION = "4.0.7";
export const PICOMATCH_INTEGRITY =
	"sha512-qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==";
export const PICOMATCH_PATCH_SHA256 =
	"a2b6a6ddd143c9b315be925d1cb737f94338b02729afba274fb8798057088e7f";
export const EXPECTED_PICOMATCH_FILES = Object.freeze({
	"index.js":
		"02ae26406508e28f9ba0865be16cf77f0b33de6c4d4d49c212c4176df1d5625a",
	"posix.js":
		"5695ff5dfcd5a338a40630bd506056f2950bcb08fe1cc068519cbbfe60add480",
	"package.json":
		"479b70b87aa7b44344d62c8a459ae7e53dd2bca6c61f1396bd55e63e9de73fc6",
	"lib/constants.js":
		"c28f952d2758261fe5428a121add485cc25b03e0193633f649de903dc0e5e222",
	"lib/parse.js":
		"96d0363de2ce9c843f5928eab99ff769f4ead2bf77ddc4c306e819b32650e75f",
	"lib/picomatch.js":
		"fdd249d7ffff853f3bb1c77eafc8baa1a437bea85a94c35877b83c6a40d9ca94",
	"lib/scan.js":
		"6457a1764e5c2e543cc3a0c00ce12ebb3764097628868198370b64d4e642aaae",
	"lib/utils.js":
		"f04604f70cd1a3f6ace80b84766468674ff38b4bb83818d2ef1d81fc6355f935",
});

const scope =
	"String glob compilation rejects recognized repeated extglobs; raw RegExp and externally supplied parser-state objects are outside this guarantee.";

// These published documentation hashes preserve the complete MIT package and
// make extra extensionless files unable to shadow relative require("./parse").
const EXPECTED_PACKAGE_FILES = Object.freeze({
	...EXPECTED_PICOMATCH_FILES,
	LICENSE: "d0cd141b0c322fded5dfad1d4645bb2fedfc05b7321fe1009469638190d59ef9",
	"README.md":
		"a69b87120fe2b9cb8f9057eaef6b9f9887f803e02185ca2f431e8162f6312220",
});

async function verifiedFiles(root) {
	assert.deepEqual(
		(await readdir(root)).sort(),
		[
			"LICENSE",
			"README.md",
			"index.js",
			"lib",
			"package.json",
			"posix.js",
		].sort(),
		"Unexpected picomatch package file inventory",
	);
	const lib = join(root, "lib");
	assert(
		(await lstat(lib)).isDirectory(),
		"Picomatch lib must be a regular directory",
	);
	assert.equal(
		await realpath(lib),
		lib,
		"Picomatch lib directory is redirected",
	);
	assert.deepEqual(
		(await readdir(lib)).sort(),
		["constants.js", "parse.js", "picomatch.js", "scan.js", "utils.js"].sort(),
		"Unexpected picomatch lib file inventory",
	);
	const files = {};
	for (const [relative, expected] of Object.entries(EXPECTED_PACKAGE_FILES)) {
		const file = join(root, relative);
		assert(
			(await lstat(file)).isFile(),
			`Package file is not a regular file: ${relative}`,
		);
		assert.equal(
			await realpath(file),
			file,
			`Package path is redirected: ${relative}`,
		);
		const actual = sha256(await readFile(file));
		assert.equal(
			actual,
			expected,
			`Unexpected picomatch runtime bytes: ${relative}`,
		);
		if (Object.hasOwn(EXPECTED_PICOMATCH_FILES, relative))
			files[relative] = actual;
	}
	return files;
}

function runContract(root) {
	const require = createRequire(import.meta.url);
	const pm = require(join(root, "index.js"));
	const posix = require(join(root, "posix.js"));
	const parse = require(join(root, "lib/parse.js"));
	const rejected = [
		"+(*)",
		"+(*a)",
		"*(*)",
		"*(*a)",
		"+(*)c",
		"+(a*)c",
		"+(*[ab])c",
		"+(*a|b)c",
		"x+(*a)y",
		"**/+(*a).js",
		"./*(*a).js",
		"@(+(*a)|b)",
		"?(*(*a))",
		"!(*(*a))",
		"+(abc)",
		"*(a|b)",
	];

	let rejectionChecks = 0;
	for (const options of [
		{},
		{ fastpaths: false },
		{ capture: true },
		{ maxExtglobRecursion: false },
		{ regex: false },
		{ windows: true },
	]) {
		for (const pattern of rejected) {
			for (const [entry, call] of Object.entries({
				matcher: () => pm(pattern, options),
				posix: () => posix(pattern, options),
				array: () => pm(["*.js", pattern], options),
				isMatch: () => pm.isMatch(`${"a".repeat(32)}b`, pattern, options),
				makeRe: () => pm.makeRe(pattern, options),
				makeReOutput: () => pm.makeRe(pattern, options, true),
				parse: () => pm.parse(pattern, options),
				parseArray: () => pm.parse(["*.js", pattern], options),
				internalParse: () => parse(pattern, options),
				ignore: () => pm("**/*", { ...options, ignore: pattern }),
				ignoreArray: () =>
					pm("**/*", { ...options, ignore: ["*.md", pattern] }),
				matchBase: () => pm.matchBase("a/b.js", pattern, options),
			})) {
				assert.throws(
					call,
					(error) =>
						error instanceof SyntaxError &&
						error.code === "ERR_PICOMATCH_REPEATED_EXTGLOB",
					JSON.stringify({ entry, pattern, options }),
				);
				rejectionChecks++;
			}
			assert.equal(parse.fastpaths(pattern, options), undefined);
		}
	}
	// These explicit cases make the retained syntax and capture contract reviewable.
	assert(pm("src/**/*.test.{ts,tsx}")("src/a/file.test.tsx"));
	assert(pm("@(a|b)")("a"));
	assert(pm("?(a|b)")("b"));
	assert(!pm("?(a|b)")("ab"));
	assert(pm("!(a|b)")("c"));
	assert(!pm("!(a|b)")("a"));
	assert(pm('"+(*a)"')("+(*a)"));
	assert.deepEqual(
		Array.from(pm.makeRe("src/*.js", { capture: true }).exec("src/a.js")),
		["src/a.js", "a"],
	);
	// A finite regression fingerprint from the verified, unmodified npm4.0.7
	// release pins accepted regex sources, matches and capture values. Every
	// input here is short; the vulnerable long-input controls remain external.
	const allowed = [
		"*",
		"**",
		"*.js",
		"**/*.js",
		"src/**/*.{ts,tsx}",
		"**/*.{test,spec}.?(c|m)[jt]s?(x)",
		"@(a|b)",
		"?(a|b)",
		"!(a|b)",
		"foo/!(*.test).js",
		"@(?ar|zip)",
		"\\+\\(\\*a\\)",
		"\\*\\(a\\)",
		'"+(*a)"',
		'"*(a)"',
		"+\\(a\\)",
		"*\\(a\\)",
		"[+*](a)",
		"a+b",
		"a(b)",
		"a?b",
		"a/**/b",
		"!node_modules/**",
		"*.{js,ts}",
	];
	const inputs = [
		"",
		"a",
		"b",
		"ab",
		"aaa",
		"a.js",
		"b.test.js",
		"src/foo.ts",
		"src/foo.test.tsx",
		"a/b",
		"a\\b",
		"+(*a)",
		"*(a)",
		"+a",
		"*a",
		".a",
		"file.jar",
	];

	const samples = [];
	for (const options of [
		{},
		{ fastpaths: false },
		{ capture: true },
		{ dot: true },
		{ windows: true },
		{ bash: true },
		{ noextglob: true },
		{ noext: true },
	]) {
		for (const pattern of allowed) {
			const regex = pm.makeRe(pattern, options);
			samples.push({
				pattern,
				options,
				source: regex.source,
				matches: inputs.map((input) => [
					input,
					regex.exec(input),
					pm.isMatch(input, pattern, options),
				]),
			});
		}
	}
	assert.equal(
		sha256(JSON.stringify(samples)),
		"850b3b07a2e0ba6223068552d0e3418ea23cae3d13421c1c6b613197e235fb8b",
		"Accepted-pattern semantics changed",
	);
	const noextSamples = [];
	for (const options of [
		{ noextglob: true },
		{ noextglob: true, capture: true },
		{ noext: true },
	]) {
		for (const pattern of rejected) {
			noextSamples.push([
				pattern,
				options,
				pm.makeRe(pattern, options).source,
				pm.isMatch(`${"a".repeat(32)}b`, pattern, options),
			]);
		}
	}
	assert.equal(
		sha256(JSON.stringify(noextSamples)),
		"3a9bf394cd68ff163a97c8e9346b7f0824c48eb5b89e1e1cae7c07c93a7c351a",
		"Disabled-extglob semantics changed",
	);
	return {
		rejectionChecks,
		acceptedCases: samples.length * inputs.length,
		noextCases: noextSamples.length,
		scope,
	};
}

export async function verifyInstalledPicomatch(
	packageRoots,
	{ timeoutMs = 1000 } = {},
) {
	assert(
		Array.isArray(packageRoots) && packageRoots.length > 0,
		"No installed picomatch roots supplied",
	);
	assert(
		Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 1000,
		"Probe deadline must be1–1000ms",
	);
	const roots = [
		...new Set(
			await Promise.all(packageRoots.map((root) => realpath(resolve(root)))),
		),
	];
	const results = [];
	for (const root of roots) {
		const files = await verifiedFiles(root);
		const { stdout } = await execute(
			process.execPath,
			[script, "--child", root],
			{
				timeout: timeoutMs,
				killSignal: "SIGKILL",
				maxBuffer: 1024 * 1024,
				env: { LANG: "C", NO_COLOR: "1" },
			},
		);
		const contract = JSON.parse(stdout);
		assert.equal(contract.rejectionChecks, 1152);
		assert.equal(contract.acceptedCases, 3264);
		assert.equal(contract.noextCases, 48);
		assert.equal(contract.scope, scope);
		results.push({ root, version: PICOMATCH_VERSION, files, contract });
	}
	return results;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	if (process.argv[2] === "--child") {
		assert.equal(process.argv.length, 4);
		const root = await realpath(resolve(process.argv[3]));
		await verifiedFiles(root);
		console.log(JSON.stringify(runContract(root)));
	} else {
		console.log(
			JSON.stringify(
				await verifyInstalledPicomatch(process.argv.slice(2)),
				null,
				2,
			),
		);
	}
}
