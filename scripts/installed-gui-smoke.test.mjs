import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	classifyBrowserError,
	PHASED_GUI_STATES,
} from "../tests/browser/diagnostics.ts";
import {
	browserExecutionAllowed,
	CASES,
	childEnvironment,
	cleanupFixture,
	composeOverride,
	failureSummary,
	inside,
	validateExecutionMode,
	validateReport,
	workerReady,
} from "./installed-gui-smoke.mjs";

const id = "0123456789abcdef0123456789abcdef";
const root = resolve(import.meta.dirname, "..");
const report = () => ({
	stats: { unexpected: 0, skipped: 0, flaky: 0, expected: CASES.length },
	suites: [
		{
			specs: CASES.map((title) => ({
				title,
				tests: [{ status: "expected", results: [{ status: "passed" }] }],
			})),
		},
	],
});

test("all browser definitions load in collection-only mode without running a case", () => {
	const directory = realpathSync(
		mkdtempSync(join(tmpdir(), "bitovp-collect-")),
	);
	try {
		const fixture = join(directory, "fixture.json");
		const output = join(directory, "report.json");
		const config = join(directory, "collect.config.mjs");
		writeFileSync(fixture, "{}", { mode: 0o600 });
		writeFileSync(
			config,
			`export default ${JSON.stringify({
				testDir: join(root, "tests/browser"),
				testMatch: "installed-gui.test.ts",
				reporter: [["json", { outputFile: output }]],
				outputDir: join(directory, "output"),
			})};`,
			{ mode: 0o600 },
		);
		const result = spawnSync(
			process.execPath,
			[
				join(root, "node_modules/@playwright/test/cli.js"),
				"test",
				"--list",
				"--config",
				config,
			],
			{
				cwd: root,
				env: {
					...childEnvironment(process.env),
					TMPDIR: directory,
					TMP: directory,
					TEMP: directory,
					BITOVP_GUI_SMOKE_FIXTURE: fixture,
				},
				timeout: 30_000,
				maxBuffer: 2_000_000,
			},
		);
		assert.equal(result.status, 0, "Browser definition collection failed");
		const collected = JSON.parse(readFileSync(output, "utf8"));
		assert.deepEqual(collected.errors, []);
		const titles = [];
		const visit = (suite) => {
			for (const spec of suite.specs ?? []) {
				titles.push(spec.title);
				assert.equal(spec.tests.length, 1);
				assert.deepEqual(spec.tests[0].results, []);
			}
			for (const child of suite.suites ?? []) visit(child);
		};
		for (const suite of collected.suites) visit(suite);
		assert.deepEqual(titles, CASES);
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("private state paths cannot use a dot-prefixed child or the checkout itself", () => {
	assert(inside("/checkout", "/checkout"));
	assert(inside("/checkout", "/checkout/..hidden/state"));
	assert(!inside("/checkout", "/private/state"));
	assert(!inside("/checkout", "/checkout-other/state"));
});

test("local browser execution and runtime-only CI completion fail closed", () => {
	const hosted = {
		GITHUB_ACTIONS: "true",
		RUNNER_ENVIRONMENT: "github-hosted",
		CI: "1",
	};
	assert(browserExecutionAllowed(hosted, "linux"));
	assert(!browserExecutionAllowed(hosted, "darwin"));
	assert(
		!browserExecutionAllowed(
			{ ...hosted, RUNNER_ENVIRONMENT: "self-hosted" },
			"linux",
		),
	);
	assert(!browserExecutionAllowed({}, "linux"));
	assert.throws(() => validateExecutionMode({}, false, "darwin"));
	assert.throws(() => validateExecutionMode(hosted, true, "linux"));
	assert.throws(() => validateExecutionMode({ CI: "1" }, true, "linux"));
	validateExecutionMode({}, true, "darwin");
});

test("does not forward application, cloud, Docker-context or authentication settings", () => {
	assert.deepEqual(
		childEnvironment({
			PATH: "/tools",
			DATABASE_URL: "private",
			AWS_SECRET_ACCESS_KEY: "private",
			BITMOVIN_API_KEY: "private",
			MASTER_KEY: "private",
			NODE_OPTIONS: "private",
		}),
		{
			PATH: "/tools",
			CI: "1",
			NEXT_TELEMETRY_DISABLED: "1",
			TURBO_TELEMETRY_DISABLED: "1",
		},
	);
	assert.throws(() => childEnvironment({ DOCKER_HOST: "tcp://remote:2375" }));
	assert.throws(() => childEnvironment({ DOCKER_CONTEXT: "remote" }));
});
test("overrides both root env files, all published ports and the media bind mount", () => {
	const text = composeOverride({ id, directory: "/private/smoke" });
	assert.equal((text.match(/env_file: !override/g) ?? []).length, 4);
	assert.equal((text.match(/ports: !override/g) ?? []).length, 3);
	assert.match(text, /volumes: !override \[\]/);
	assert.match(text, /pg_isready --host=127\.0\.0\.1/);
	assert.match(text, /networks:\n {2}default:\n {4}labels:/);
	assert.match(text, /networks:\n {2}default:[\s\S]*\n {4}internal: true/);
	assert.match(text, / {2}web:[\s\S]*ports: !override \[\]/);
	assert.match(text, / {2}gateway:[\s\S]*127\.0\.0\.1::3100/);
	assert(!text.includes("verify-runs"));
	assert(!text.includes("3330"));
	assert.throws(() =>
		composeOverride({ id: "main", directory: "/private/smoke" }),
	);
});
test("requires every named browser case to run and pass once without skipping or retrying", () => {
	validateReport(report());
	for (const key of ["skipped", "flaky", "unexpected"]) {
		const changed = report();
		changed.stats[key] = 1;
		assert.throws(() => validateReport(changed));
	}
	const missing = report();
	missing.suites[0].specs.pop();
	assert.throws(() => validateReport(missing));
	const retried = report();
	retried.suites[0].specs[0].tests[0].results.push({ status: "passed" });
	assert.throws(() => validateReport(retried));
});
test("failure summaries expose only known case names and safe statuses", () => {
	const changed = report();
	const specs = changed.suites[0].specs;
	specs[0].tests[0].results[0] = {
		status: "failed",
		error: { message: "private password, URL and cookie" },
		attachments: [{ body: "private attachment" }],
	};
	specs[1].tests[0].results[0].status = "timedOut";
	specs[2].tests[0].results[0].status = "skipped";
	specs[3].tests[0].results.push({ status: "passed" });
	specs[4].tests[0].results[0].status = "private-status";
	const summary = failureSummary(JSON.stringify(changed));
	assert.deepEqual(summary, [
		`Browser case: ${CASES[0]}; status=failed`,
		`Browser case: ${CASES[1]}; status=timedOut`,
		`Browser case: ${CASES[2]}; status=skipped`,
		`Browser case: ${CASES[3]}; status=retried`,
		`Browser case: ${CASES[4]}; status=unknown`,
		`Browser case: ${CASES[5]}; status=passed`,
		`Browser case: ${CASES[6]}; status=passed`,
		`Browser case: ${CASES[7]}; status=passed`,
	]);
	assert(!summary.join("\n").includes("private"));
});
test("failed browser cases expose only the last fixed submission stage", () => {
	const changed = report();
	const browserTest = changed.suites[0].specs[2].tests[0];
	browserTest.results[0].status = "failed";
	browserTest.annotations = [
		{ type: "smoke-stage", description: "submit-clicked" },
		{ type: "smoke-stage", description: "post-received" },
		{ type: "smoke-stage", description: "private URL and token" },
		{ type: "private", description: "post-fulfilled" },
		null,
	];
	assert.equal(
		failureSummary(JSON.stringify(changed))[2],
		`Browser case: ${CASES[2]}; status=failed; stage=post-received`,
	);
	browserTest.results[0].status = "passed";
	assert.equal(
		failureSummary(JSON.stringify(changed))[2],
		`Browser case: ${CASES[2]}; status=passed`,
	);
});
test("failure page observations expose only bounded fixed categories", () => {
	const changed = report();
	const browserTest = changed.suites[0].specs[5].tests[0];
	browserTest.results[0].status = "failed";
	browserTest.annotations = [
		{ type: "smoke-state", description: "route-vod-new" },
		{ type: "smoke-state", description: "session-admin" },
		{ type: "smoke-state", description: "session-anonymous" },
		{ type: "smoke-state", description: "private URL and cookie" },
		{ type: "private", description: "session-admin" },
		null,
	];
	assert.equal(
		failureSummary(JSON.stringify(changed))[5],
		`Browser case: ${CASES[5]}; status=failed; state=route-vod-new,session-admin,session-anonymous`,
	);
	browserTest.annotations = Array.from({ length: 100 }, () => ({
		type: "smoke-state",
		description: "session-admin",
	}));
	assert.equal(
		failureSummary(JSON.stringify(changed))[5].split("session-admin").length -
			1,
		8,
	);
	browserTest.results[0].status = "passed";
	assert.equal(
		failureSummary(JSON.stringify(changed))[5],
		`Browser case: ${CASES[5]}; status=passed`,
	);
});
test("original browser errors produce fixed useful categories without exposing their details", () => {
	for (const [error, expected] of [
		[{ message: "Minified React error #418; secret=discard" }, "react-418"],
		[{ message: "Minified React error #423; secret=discard" }, "react-423"],
		[{ message: "Minified React error #310; private URL" }, "react-310"],
		[{ message: "Minified React error #311; private URL" }, "react-311"],
		[{ message: "Minified React error #321; private URL" }, "react-321"],
		[{ message: "Minified React error #999; private URL" }, "react-other"],
		[{ name: "ChunkLoadError", message: "private module URL" }, "module-load"],
		[
			{ message: "Failed to load chunk https://private.invalid/path" },
			"module-load",
		],
		[{ message: "Hydration failed with private content" }, "hydration"],
		[
			{ message: "Rendered more hooks than during the previous render" },
			"hooks",
		],
		[
			{ message: "No QueryClient set, use QueryClientProvider to set one" },
			"query-client",
		],
		[{ name: "ReferenceError", message: "private symbol" }, "reference-error"],
		[{ name: "TypeError", message: "private value" }, "type-error"],
		[{ name: "SyntaxError", message: "private input" }, "syntax-error"],
		[{ name: "private name", message: "private arbitrary content" }, "unknown"],
		[null, "unknown"],
		[{ message: `${"x".repeat(2000)}Minified React error #418` }, "unknown"],
		[
			{
				get message() {
					throw new Error("private diagnostic failure");
				},
			},
			"unknown",
		],
	]) {
		const result = classifyBrowserError(error);
		assert.equal(result, expected);
		for (const phase of ["initial-login", "post-login"])
			assert(PHASED_GUI_STATES.includes(`browser-${phase}-${result}`));
	}
});
test("failure diagnostics distinguish authentication phases without exposing injected values", () => {
	const changed = report();
	const browserTest = changed.suites[0].specs[5].tests[0];
	browserTest.results[0].status = "failed";
	browserTest.annotations = [
		{ type: "smoke-state", description: "session-initial-login-anonymous" },
		{ type: "smoke-state", description: "session-post-login-started" },
		{ type: "smoke-state", description: "session-post-login-admin" },
		{ type: "smoke-state", description: "browser-post-login-module-load" },
		{
			type: "smoke-state",
			description: "browser-post-login-private URL cookie",
		},
		{
			type: "smoke-state",
			description: "session-post-login-admin\nprivate value",
		},
	];
	assert.equal(
		failureSummary(JSON.stringify(changed))[5],
		`Browser case: ${CASES[5]}; status=failed; state=browser-post-login-module-load,session-initial-login-anonymous,session-post-login-admin,session-post-login-started`,
	);
	browserTest.results[0].status = "timedOut";
	assert(
		failureSummary(JSON.stringify(changed))[5].includes(
			"session-post-login-started",
		),
	);
	browserTest.results[0].status = "passed";
	assert.equal(
		failureSummary(JSON.stringify(changed))[5],
		`Browser case: ${CASES[5]}; status=passed`,
	);
	browserTest.results[0].status = "failed";
	browserTest.annotations = Array.from({ length: 100 }, () => ({
		type: "smoke-state",
		description: "browser-post-login-reference-error",
	}));
	assert.equal(
		failureSummary(JSON.stringify(changed))[5].split(
			"browser-post-login-reference-error",
		).length - 1,
		4,
	);
	browserTest.annotations = [
		...Array.from({ length: 32 }, () => ({
			type: "private",
			description: "discard",
		})),
		{ type: "smoke-state", description: "session-post-login-started" },
	];
	assert.equal(
		failureSummary(JSON.stringify(changed))[5],
		`Browser case: ${CASES[5]}; status=failed`,
	);
});
test("original console errors retain useful fixed categories without returning text", () => {
	for (const [message, expected] of [
		[
			"An error occurred in the Server Components render. private digest",
			"server-render",
		],
		[
			'[i18n] key "private.key" has no value for {private}',
			"missing-translation",
		],
		["useT must be used inside <LocaleProvider>", "missing-translation"],
		["ReferenceError: private symbol is not defined", "reference-error"],
		["TypeError: private value is undefined", "type-error"],
		["SyntaxError: private input", "syntax-error"],
		["private URL cookie and arbitrary text", "unknown"],
	])
		assert.equal(classifyBrowserError({ message }), expected);
});
test("console resource failures expose fixed causes without resource names or codes", () => {
	const examples = [
		["Failed to load resource: net::ERR_CONNECTION_REFUSED", "network-refused"],
		["Failed to load resource: net::ERR_CONNECTION_RESET", "network-reset"],
		["Failed to load resource: net::ERR_CONNECTION_CLOSED", "network-closed"],
		["Failed to load resource: net::ERR_EMPTY_RESPONSE", "network-empty"],
		["Failed to load resource: net::ERR_TIMED_OUT", "network-timeout"],
		[
			"Failed to load resource: net::ERR_CONNECTION_TIMED_OUT",
			"network-timeout",
		],
		["Failed to load resource: net::ERR_ABORTED", "network-aborted"],
		["Failed to load resource: net::ERR_PRIVATE_UNKNOWN", "network-other"],
		["TypeError: Failed to fetch private URL", "network-other"],
		[
			"Failed to load resource: the server responded with a status of 404 (private)",
			"resource-http-404",
		],
		[
			"Failed to load resource: the server responded with a status of 503 (private)",
			"resource-http-5xx",
		],
		[
			"Failed to load resource: the server responded with a status of 401 (private)",
			"resource-http-other",
		],
		["Failed to load resource: private data", "resource-load"],
		[
			"Refused to load private URL because it violates Content Security Policy",
			"csp",
		],
		["Access to private URL has been blocked by CORS policy", "cors"],
		[
			"Refused to execute private script because its MIME type is not executable",
			"mime-type",
		],
		[
			"Failed to find a valid digest in the integrity attribute for private resource",
			"integrity",
		],
		["Loading CSS chunk private failed", "module-load"],
		["Failed to load module script at private URL", "module-load"],
		[
			"Text content did not match. Server: private Client: private",
			"hydration",
		],
		["Expected server HTML to contain a matching private element", "hydration"],
		[
			`${"x".repeat(2000)}Failed to load resource: net::ERR_CONNECTION_RESET`,
			"unknown",
		],
	];
	assert.deepEqual(
		examples.map(([message]) => classifyBrowserError({ message })),
		examples.map(([, expected]) => expected),
	);
	for (const [, category] of examples) {
		const changed = report();
		const browserTest = changed.suites[0].specs[5].tests[0];
		browserTest.results[0].status = "failed";
		browserTest.annotations = [
			{ type: "smoke-state", description: `console-post-login-${category}` },
			{
				type: "smoke-state",
				description: `console-post-login-${category} private URL cookie`,
			},
		];
		assert.equal(
			failureSummary(JSON.stringify(changed))[5],
			`Browser case: ${CASES[5]}; status=failed; state=console-post-login-${category}`,
		);
	}
});
test("structured failure diagnostics reserve bounded slots for original errors and sessions", () => {
	const changed = report();
	const browserTest = changed.suites[0].specs[5].tests[0];
	browserTest.results[0].status = "failed";
	const dom = [
		"route-vod-new",
		"navigation-ok",
		"navigation-content-html",
		"ready-complete",
		"document-next-error",
		"organization-missing",
		"content-empty",
		"permission-none",
		"wizard-nav-missing",
		"wizard-missing",
	];
	const errors = [
		"console-post-login-server-render",
		"console-post-login-missing-translation",
		"browser-post-login-react-418",
		"console-post-login-unknown",
	];
	const sessions = [
		"session-initial-login-login-anonymous",
		"session-post-login-root-admin",
		"session-post-login-vod-new-pending",
		"session-post-login-vod-new-admin",
		"session-post-login-other-http-error",
		"session-post-login-unavailable-invalid",
		"session-post-login-vod-new-unreadable",
		"session-post-login-vod-new-request-failed",
	];
	const markers = ["browser-error", "session-post-login-started"];
	const states = [...dom, ...errors, ...sessions, ...markers];
	assert.equal(states.length, 24);
	browserTest.annotations = [
		...states.map((description) => ({ type: "smoke-state", description })),
		{ type: "smoke-state", description: "console-post-login-private URL" },
		{
			type: "smoke-state",
			description: "session-post-login-vod-new-admin\nprivate",
		},
		{ type: "smoke-state", description: "wizard-step-private" },
	];
	assert.equal(
		failureSummary(JSON.stringify(changed))[5],
		`Browser case: ${CASES[5]}; status=failed; state=${states.join(",")}`,
	);
	// A noisy DOM group cannot evict error/session records inside the first 32 annotations.
	browserTest.annotations = [
		...Array(20).fill("document-empty"),
		...errors,
		...sessions,
	].map((description) => ({ type: "smoke-state", description }));
	assert.equal(
		failureSummary(JSON.stringify(changed))[5],
		`Browser case: ${CASES[5]}; status=failed; state=${[...Array(10).fill("document-empty"), ...errors, ...sessions].join(",")}`,
	);
});
test("known wizard steps and document states stay closed at the public boundary", () => {
	const changed = report();
	const browserTest = changed.suites[0].specs[5].tests[0];
	browserTest.results[0].status = "failed";
	for (const state of [
		"document-next-error",
		"document-app-shell",
		"document-empty",
		"document-other",
		"content-vod",
		"content-dashboard",
		"content-not-found",
		"content-empty",
		"wizard-imported",
		"wizard-nav-hidden",
		"wizard-nav-no-current",
		...Array.from({ length: 8 }, (_, index) => `wizard-step-${index + 1}`),
	]) {
		browserTest.annotations = [
			{ type: "smoke-state", description: state },
			{ type: "smoke-state", description: "wizard-step-0" },
			{ type: "smoke-state", description: "wizard-step-9" },
			{ type: "smoke-state", description: `${state} private URL cookie` },
		];
		assert.equal(
			failureSummary(JSON.stringify(changed))[5],
			`Browser case: ${CASES[5]}; status=failed; state=${state}`,
		);
	}
});
test("original navigation content types expose only fixed media categories", async () => {
	const { classifyNavigationContentType } = await import(
		"../tests/browser/diagnostics.ts"
	);
	for (const [value, expected] of [
		["text/html; charset=utf-8", "html"],
		["TEXT/X-COMPONENT; private=discard", "rsc"],
		["application/json", "json"],
		["application/problem+json; secret=discard", "json"],
		["private invalid content type", "other"],
		["", "unknown"],
		[null, "unknown"],
		[
			{
				toString() {
					throw new Error("must not coerce header");
				},
			},
			"unknown",
		],
	])
		assert.equal(classifyNavigationContentType(value), expected);
});
test("session records retain request-start document and response-arrival slots", async () => {
	const { observeSessionResponses } = await import(
		"../tests/browser/diagnostics.ts"
	);
	const page = new EventEmitter();
	const origin = "http://localhost:3100";
	let documentURL = `${origin}/login?private=discard`;
	const request = () => ({
		url: () => `${origin}/api/auth/session`,
		frame: () => ({ url: () => documentURL }),
	});
	const response = (req, json) => ({
		url: req.url,
		request: () => req,
		status: () => 200,
		json: () => json,
	});
	let finishInitial;
	const initialJSON = new Promise((resolve) => {
		finishInitial = resolve;
	});
	const observations = observeSessionResponses(page, origin);
	const initial = request();
	page.emit("request", initial);
	page.emit("response", {
		url: () => `${origin}/api/auth/login`,
		status: () => 200,
		request: () => ({ method: () => "POST" }),
	});
	documentURL = `${origin}/`;
	page.emit("response", response(initial, initialJSON));
	const dashboard = request();
	page.emit("request", dashboard);
	documentURL = `${origin}/vod/new?private=discard`;
	page.emit(
		"response",
		response(
			dashboard,
			Promise.resolve({
				configured: true,
				authenticated: true,
				mode: "users",
				role: "ADMIN",
			}),
		),
	);
	let failLate;
	const lateJSON = new Promise((_resolve, reject) => {
		failLate = reject;
	});
	for (let index = 0; index < 7; index++) {
		const req = request();
		page.emit("request", req);
		page.emit(
			"response",
			response(
				req,
				index === 0
					? lateJSON
					: Promise.resolve({ configured: true, authenticated: false }),
			),
		);
	}
	await new Promise(setImmediate);
	assert.equal(observations.history.length, 8);
	assert.equal(
		observations.history[0].state,
		"session-initial-login-login-pending",
	);
	assert.equal(observations.history[1].state, "session-post-login-root-admin");
	assert.equal(
		observations.history[2].state,
		"session-post-login-vod-new-pending",
	);
	finishInitial({ configured: true, authenticated: false, private: "discard" });
	failLate(new Error("private late JSON failure"));
	await new Promise(setImmediate);
	assert.equal(
		observations.history[0].state,
		"session-initial-login-login-anonymous",
	);
	assert.equal(
		observations.history[2].state,
		"session-post-login-vod-new-unreadable",
	);
	assert.equal(observations.history.length, 8);
	assert.equal(observations.postLoginSessionStarted, true);
	assert(!JSON.stringify(observations).includes("private"));
});
test("diagnostic observers keep the first four distinct categories and classify console text only", async () => {
	const { observeSessionResponses } = await import(
		"../tests/browser/diagnostics.ts"
	);
	const page = new EventEmitter();
	const observations = observeSessionResponses(page, "http://localhost:3100");
	page.emit("console", {
		type: () => "log",
		text: () => {
			throw new Error("must not read logs");
		},
	});
	page.emit("console", {
		type: () => "error",
		text: () => "Minified React error #418; private",
	});
	page.emit("console", {
		type: () => "error",
		text: () => "private arbitrary URL cookie",
	});
	page.emit("pageerror", { name: "ReferenceError", message: "private symbol" });
	page.emit("console", {
		type: () => "error",
		text: () => {
			throw new Error("private getter");
		},
	});
	page.emit("pageerror", {
		name: "TypeError",
		message: "fourth distinct category",
	});
	page.emit("pageerror", {
		name: "SyntaxError",
		message: "fifth distinct category must be ignored",
	});
	assert.deepEqual(observations.browserErrors, [
		"console-initial-login-react-418",
		"console-initial-login-unknown",
		"browser-initial-login-reference-error",
		"browser-initial-login-type-error",
	]);
	assert(!JSON.stringify(observations).includes("private"));
});
test("primary Web failure snapshots require ownership and inspect only explicit fields", async () => {
	const { reportPrimaryWebFailure } = await import("./installed-gui-smoke.mjs");
	const container = "a".repeat(64);
	for (const state of [
		{ running: true, oom: false, exit: 0, restarts: 0 },
		{ running: false, oom: false, exit: 137, restarts: 0 },
		{ running: false, oom: true, exit: 137, restarts: 2 },
		{ running: false, oom: false, exit: 1, restarts: 0 },
	]) {
		const calls = [],
			lines = [];
		await reportPrimaryWebFailure(
			{ id },
			{
				env: { DATABASE_URL: "private synthetic value" },
				notify: (line) => lines.push(line),
				execute: async (binary, args, options) => {
					assert.equal(binary, "docker");
					assert.equal(options.env.DATABASE_URL, undefined);
					calls.push(args);
					if (args.includes("ps")) {
						for (const filter of [
							`label=io.bitovp.gui-smoke=${id}`,
							`label=com.docker.compose.project=bitovp-gui-${id}`,
							"label=com.docker.compose.service=web",
						])
							assert(args.includes(filter));
						assert(args.includes("--no-trunc"));
						return container;
					}
					assert.equal(args.at(-1), container);
					assert(args.includes("--format"));
					const format = args[args.indexOf("--format") + 1];
					if (format.includes(".Config.Labels")) {
						assert.deepEqual(
							[
								...new Set(
									format.match(/(?<![A-Za-z0-9_])\.[A-Za-z_][A-Za-z0-9_.]*/g),
								),
							],
							[".Config.Labels"],
						);
						assert.deepEqual(
							[...format.matchAll(/index \.Config\.Labels "([^"]+)"/g)].map(
								(match) => match[1],
							),
							[
								"io.bitovp.gui-smoke",
								"com.docker.compose.project",
								"com.docker.compose.service",
							],
						);
						return JSON.stringify({
							fixture: id,
							project: `bitovp-gui-${id}`,
							service: "web",
						});
					}
					assert.equal(
						calls.length,
						3,
						"Ownership must be established before state is read",
					);
					assert.deepEqual(
						[
							...new Set(
								format.match(/(?<![A-Za-z0-9_])\.[A-Za-z_][A-Za-z0-9_.]*/g),
							),
						].sort(),
						[
							".RestartCount",
							".State.ExitCode",
							".State.OOMKilled",
							".State.Running",
						],
					);
					return JSON.stringify(state);
				},
			},
		);
		assert.equal(calls.length, 3);
		assert.deepEqual(lines, [
			`Primary Web diagnostic: running=${state.running}; oom=${state.oom}; exit=${state.exit === 0 ? "zero" : state.exit === 137 ? "137" : "other"}; restarts=${state.restarts === 0 ? "none" : "some"}`,
		]);
		assert(!JSON.stringify(lines).includes("private"));
	}
});
test("unavailable Web diagnostics cannot expose untrusted data or replace the original failure", async () => {
	const { reportPrimaryWebFailure } = await import("./installed-gui-smoke.mjs");
	for (const variant of [
		"missing",
		"ambiguous",
		"foreign-fixture",
		"foreign-project",
		"foreign-service",
		"invalid-running",
		"invalid-oom",
		"invalid-exit",
		"invalid-exit-range",
		"invalid-restarts",
		"negative-restarts",
		"missing-state",
		"malformed-state",
		"oversized-state",
		"command-error",
		"notify-error",
		"notify-rejection",
	]) {
		let calls = 0;
		const lines = [];
		const original = new Error("Original browser failure");
		await assert.rejects(
			async () => {
				try {
					throw original;
				} catch (error) {
					await reportPrimaryWebFailure(
						{ id },
						{
							env: {},
							notify: (line) => {
								if (variant === "notify-error")
									throw new Error("private notification");
								if (variant === "notify-rejection")
									return Promise.reject(new Error("private notification"));
								lines.push(line);
							},
							execute: async (_binary, args) => {
								calls++;
								if (variant === "command-error")
									throw new Error("private Docker error");
								if (args.includes("ps"))
									return variant === "missing"
										? ""
										: variant === "ambiguous"
											? `${"a".repeat(64)}\n${"b".repeat(64)}`
											: "a".repeat(64);
								const format = args[args.indexOf("--format") + 1];
								if (format.includes(".Config.Labels"))
									return JSON.stringify({
										fixture: variant === "foreign-fixture" ? "private" : id,
										project:
											variant === "foreign-project"
												? "private"
												: `bitovp-gui-${id}`,
										service: variant === "foreign-service" ? "private" : "web",
									});
								if (variant === "missing-state") return "null";
								if (variant === "malformed-state")
									return "private invalid JSON";
								if (variant === "oversized-state") return "private".repeat(600);
								return JSON.stringify({
									running: variant === "invalid-running" ? "private" : false,
									oom: variant === "invalid-oom" ? "private" : false,
									exit:
										variant === "invalid-exit"
											? "private"
											: variant === "invalid-exit-range"
												? 256
												: 0,
									restarts:
										variant === "invalid-restarts"
											? 0.5
											: variant === "negative-restarts"
												? -1
												: 0,
								});
							},
						},
					);
					throw error;
				}
			},
			(error) => error === original,
		);
		assert.deepEqual(
			lines,
			variant.startsWith("notify-")
				? []
				: ["Primary Web diagnostic: unavailable"],
		);
		if (variant.startsWith("foreign-"))
			assert.equal(calls, 2, "Foreign state must not be inspected");
	}
});
test("Web memory proof parses only bounded cgroup values and requires an actual 1 GiB zero-OOM sample", async () => {
	const { parseWebMemory, validateWebMemory } = await import(
		"./installed-gui-smoke.mjs"
	);
	const raw =
		"104857600\n734003200\n1073741824\nlow 0\nhigh 0\nmax 2\noom 0\noom_kill 0\n";
	const sample = parseWebMemory(raw);
	assert.deepEqual(sample, {
		current: 100 * 1024 ** 2,
		peak: 700 * 1024 ** 2,
		limit: 1024 ** 3,
		oom: 0,
		oomKill: 0,
	});
	assert.doesNotThrow(() => validateWebMemory(sample));
	for (const changed of [
		null,
		{ ...sample, limit: 512 * 1024 ** 2 },
		{ ...sample, oom: 1 },
		{ ...sample, oom: "0" },
		{ ...sample, oomKill: 1 },
		{ ...sample, oomKill: "0" },
	])
		assert.throws(() => validateWebMemory(changed));
	for (const malformed of [
		undefined,
		"private".repeat(700),
		raw.replace("1073741824", "max"),
		raw.replace("104857600", "-1"),
		raw.replace("734003200", "1.5"),
		raw.replace("734003200", "99999999999999999"),
		raw.replace("oom_kill 0", "oom_kill private"),
		raw.replace("oom_kill 0", "oom_kill 10000000000000000"),
		raw.replace("oom_kill 0", ""),
		`${raw}oom_kill 0\n`,
	])
		assert.throws(() => parseWebMemory(malformed));
});
test("Web memory checkpoints read only fixed cgroup files after ownership and emit finite projections", async () => {
	const { reportPrimaryWebMemory } = await import("./installed-gui-smoke.mjs");
	for (const phase of ["before", "after"]) {
		const calls = [],
			lines = [];
		const sample = await reportPrimaryWebMemory({ id }, phase, {
			env: { DATABASE_URL: "private value" },
			notify: (line) => lines.push(line),
			execute: async (binary, args, options) => {
				assert.equal(binary, "docker");
				assert.equal(options.env.DATABASE_URL, undefined);
				calls.push(args);
				if (args.includes("ps")) return "a".repeat(64);
				if (args.includes("inspect"))
					return JSON.stringify({
						fixture: id,
						project: `bitovp-gui-${id}`,
						service: "web",
					});
				assert.equal(calls.length, 3);
				assert.deepEqual(args.slice(2), [
					"exec",
					"a".repeat(64),
					"cat",
					"/sys/fs/cgroup/memory.current",
					"/sys/fs/cgroup/memory.peak",
					"/sys/fs/cgroup/memory.max",
					"/sys/fs/cgroup/memory.events",
				]);
				return "104857601\n734003201\n1073741824\noom 2\noom_kill 1\n";
			},
		});
		assert.equal(sample.oomKill, 1);
		assert.deepEqual(lines, [
			`Primary Web memory: checkpoint=${phase}; currentMiB=101; peakMiB=701; limitMiB=1024; oom=some; oom_kill=some`,
		]);
	}
});
test("Web memory collection rejects foreign containers and cannot replace a browser failure", async () => {
	const { reportPrimaryWebMemory } = await import("./installed-gui-smoke.mjs");
	for (const variant of [
		"foreign",
		"unavailable",
		"malformed",
		"notify-error",
	]) {
		const original = new Error("Original browser failure"),
			lines = [];
		let calls = 0;
		await assert.rejects(
			async () => {
				try {
					throw original;
				} catch (error) {
					assert.equal(
						await reportPrimaryWebMemory({ id }, "after", {
							env: {},
							notify: (line) => {
								if (variant === "notify-error") throw new Error("private");
								lines.push(line);
							},
							execute: async (_binary, args) => {
								calls++;
								if (args.includes("ps")) return "a".repeat(64);
								if (args.includes("inspect"))
									return JSON.stringify({
										fixture: id,
										project: `bitovp-gui-${id}`,
										service: variant === "foreign" ? "private" : "web",
									});
								if (variant === "unavailable")
									throw new Error("private command error");
								return "private invalid cgroup response";
							},
						}),
						null,
					);
					throw error;
				}
			},
			(error) => error === original,
		);
		assert.deepEqual(
			lines,
			variant === "notify-error"
				? []
				: ["Primary Web memory: checkpoint=after; unavailable"],
		);
		if (variant === "foreign") assert.equal(calls, 2);
	}
});
test("hosted memory proof retains browser exceptions and requires both valid lifetime checkpoints", async () => {
	const { withWebMemoryProof } = await import("./installed-gui-smoke.mjs");
	for (const variant of [
		"good",
		"before-unavailable",
		"after-unavailable",
		"after-oom",
		"after-kill",
		"wrong-limit",
		"changed-container",
		"browser-failure",
		"browser-and-diagnostic-failure",
	]) {
		let reads = 0,
			lookups = 0,
			browserRuns = 0;
		const original = new Error("Original browser exception");
		const work = () =>
			withWebMemoryProof(
				{ id },
				async () => {
					browserRuns++;
					if (variant.startsWith("browser-")) throw original;
				},
				{
					env: {},
					notify: () => {},
					execute: async (_binary, args) => {
						if (args.includes("ps")) {
							lookups++;
							return (
								variant === "changed-container" && lookups === 2 ? "b" : "a"
							).repeat(64);
						}
						if (args.includes("inspect"))
							return JSON.stringify({
								fixture: id,
								project: `bitovp-gui-${id}`,
								service: "web",
							});
						reads++;
						if (
							(variant === "before-unavailable" && reads === 1) ||
							(variant === "after-unavailable" && reads === 2) ||
							variant === "browser-and-diagnostic-failure"
						)
							throw new Error("Private unavailable counters");
						return `104857600\n734003200\n${variant === "wrong-limit" ? 536870912 : 1073741824}\nmax 2\noom ${variant === "after-oom" && reads === 2 ? 1 : 0}\noom_kill ${variant === "after-kill" && reads === 2 ? 1 : 0}\n`;
					},
				},
			);
		if (variant === "good") await assert.doesNotReject(work);
		else if (variant.startsWith("browser-"))
			await assert.rejects(work, (error) => error === original);
		else await assert.rejects(work, /Hosted Web memory proof/);
		assert.equal(browserRuns, 1);
		assert.equal(
			reads,
			2,
			"The final checkpoint must run even when the browser fails",
		);
	}
});
test("failed sign-in prioritizes fixed original POST evidence within existing output bounds", () => {
	const changed = report();
	const browserTest = changed.suites[0].specs[5].tests[0];
	browserTest.results[0].status = "failed";
	const dom = [
		"route-login",
		"navigation-unknown",
		"navigation-content-unknown",
		"ready-complete",
		"document-other",
		"organization-missing",
		"content-other",
		"alert-visible",
		"wizard-nav-missing",
		"wizard-missing",
	];
	const login = [
		"login-fields-match",
		"login-http-unauthorized",
		"login-code-invalid-credentials",
	];
	const errors = Array(4).fill("console-initial-login-unknown");
	const sessions = Array(8).fill("session-initial-login-login-anonymous");
	const markers = ["browser-error", "session-post-login-started"];
	const states = [...dom, ...errors, ...sessions, ...login, ...markers];
	assert(states.length <= 32);
	browserTest.annotations = states.map((description) => ({
		type: "smoke-state",
		description,
	}));
	const expected = [
		"route-login",
		"ready-complete",
		"document-other",
		"organization-missing",
		"content-other",
		"alert-visible",
		...login,
		...errors,
		...sessions,
		...markers,
	];
	assert(expected.length <= 24);
	assert.equal(
		failureSummary(JSON.stringify(changed))[5],
		`Browser case: ${CASES[5]}; status=failed; state=${expected.join(",")}`,
	);
	browserTest.annotations.push(
		{
			type: "smoke-state",
			description: "login-code-invalid-credentials\nprivate credential",
		},
		{ type: "smoke-state", description: "login-fields-private URL" },
		{ type: "smoke-state", description: "login-http-401 private header" },
	);
	assert.equal(
		failureSummary(JSON.stringify(changed))[5],
		`Browser case: ${CASES[5]}; status=failed; state=${expected.join(",")}`,
	);
});
test("login projections classify fields, HTTP status and machine code without exposing data", async () => {
	const { classifyLoginFields, classifyLoginStatus, classifyLoginCode } =
		await import("../tests/browser/diagnostics.ts");
	const expected = {
		email: "synthetic@example.invalid",
		password: "synthetic-password",
	};
	assert.equal(
		classifyLoginFields({ ...expected, private: "discard" }, expected),
		"login-fields-match",
	);
	assert.equal(
		classifyLoginFields(
			{ ...expected, password: "wrong private password" },
			expected,
		),
		"login-fields-mismatch",
	);
	assert.equal(
		classifyLoginFields({ password: expected.password }, expected),
		"login-fields-mismatch",
	);
	assert.equal(classifyLoginFields(null, expected), "login-fields-mismatch");
	assert.equal(
		classifyLoginFields(
			{
				get email() {
					throw new Error("private getter");
				},
			},
			expected,
		),
		"login-fields-unreadable",
	);
	for (const [status, category] of [
		[200, "ok"],
		[400, "bad-request"],
		[401, "unauthorized"],
		[403, "forbidden"],
		[409, "conflict"],
		[413, "too-large"],
		[429, "rate-limited"],
		[500, "server-error"],
		[503, "unavailable"],
		[302, "redirect"],
		[404, "other-4xx"],
		[502, "other-5xx"],
		[null, "other"],
		["401 private", "other"],
	])
		assert.equal(classifyLoginStatus(status), `login-http-${category}`);
	for (const [code, category] of [
		["AUTH_INVALID_CREDENTIALS", "invalid-credentials"],
		["AUTH_EMAIL_REQUIRED", "email-required"],
		["AUTH_PASSWORD_REQUIRED", "password-required"],
		["AUTH_CREDENTIALS_CHANGED", "credentials-changed"],
		["AUTH_PASSWORD_EXPIRED", "password-expired"],
		["AUTH_RATE_LIMITED", "rate-limited"],
		["AUTH_BUSY", "busy"],
		["AUTH_PROVIDER_UNAVAILABLE", "provider-unavailable"],
		["AUTH_NOT_CONFIGURED", "not-configured"],
		["AUTH_MODE_UNSUPPORTED", "mode-unsupported"],
		["AUTH_INVALID_CREDENTIALS\nprivate", "other"],
		["__proto__", "other"],
	])
		assert.equal(
			classifyLoginCode({
				error: "private text",
				details: { code, private: "discard" },
			}),
			`login-code-${category}`,
		);
	assert.equal(
		classifyLoginCode({ error: "private raw error" }),
		"login-code-none",
	);
	assert.equal(classifyLoginCode(null), "login-code-invalid");
	assert.equal(
		classifyLoginCode({
			details: {
				get code() {
					throw new Error("private getter");
				},
			},
		}),
		"login-code-unreadable",
	);
});
test("original login observation captures only the first primary POST and catches unreadable JSON", async () => {
	const { observeSessionResponses } = await import(
		"../tests/browser/diagnostics.ts"
	);
	const origin = "http://localhost:3100";
	const expected = {
		email: "synthetic@example.invalid",
		password: "synthetic-password",
	};
	const loginRequest = (url = `${origin}/api/auth/login`, method = "POST") => ({
		url: () => url,
		method: () => method,
		postDataJSON: () => ({ ...expected }),
	});
	const page = new EventEmitter();
	const observations = observeSessionResponses(page, origin, expected);
	page.emit("request", loginRequest(`${origin}/api/auth/login`, "GET"));
	page.emit("request", loginRequest("http://127.0.0.1:13100/api/auth/login"));
	assert.equal(observations.login.http, "login-http-not-observed");
	const first = loginRequest();
	page.emit("request", first);
	assert.equal(observations.login.fields, "login-fields-match");
	let completeJSON;
	page.emit("response", {
		url: first.url,
		request: () => first,
		status: () => 401,
		json: () =>
			new Promise((resolve) => {
				completeJSON = resolve;
			}),
	});
	const later = loginRequest();
	page.emit("request", later);
	page.emit("response", {
		url: later.url,
		request: () => later,
		status: () => 503,
		json: () => {
			throw new Error("later must not be read");
		},
	});
	completeJSON({
		error: "private prose",
		details: { code: "AUTH_INVALID_CREDENTIALS", private: expected.password },
	});
	await new Promise(setImmediate);
	assert.deepEqual(observations.login, {
		fields: "login-fields-match",
		http: "login-http-unauthorized",
		code: "login-code-invalid-credentials",
	});
	assert(!JSON.stringify(observations).includes(expected.email));
	assert(!JSON.stringify(observations).includes(expected.password));
	const failingPage = new EventEmitter();
	const unreadable = observeSessionResponses(failingPage, origin, expected);
	const broken = {
		...loginRequest(),
		postDataJSON: () => {
			throw new Error("private body");
		},
	};
	failingPage.emit("request", broken);
	failingPage.emit("response", {
		url: broken.url,
		request: () => broken,
		status: () => 500,
		json: () => Promise.reject(new Error("private body JSON")),
	});
	await new Promise(setImmediate);
	assert.deepEqual(unreadable.login, {
		fields: "login-fields-unreadable",
		http: "login-http-server-error",
		code: "login-code-unreadable",
	});
	const syncPage = new EventEmitter();
	const syncFailure = observeSessionResponses(syncPage, origin, expected);
	const syncRequest = loginRequest();
	syncPage.emit("request", syncRequest);
	assert.doesNotThrow(() =>
		syncPage.emit("response", {
			url: syncRequest.url,
			request: () => syncRequest,
			status: () => 503,
			json: () => {
				throw new Error("private synchronous JSON failure");
			},
		}),
	);
	assert.equal(syncFailure.login.code, "login-code-unreadable");
	const successfulPage = new EventEmitter();
	const successful = observeSessionResponses(successfulPage, origin, expected);
	const successfulRequest = loginRequest();
	successfulPage.emit("request", successfulRequest);
	successfulPage.emit("response", {
		url: successfulRequest.url,
		request: () => successfulRequest,
		status: () => 200,
		json: () => Promise.resolve({ ok: true, expiresAt: "private timestamp" }),
	});
	await new Promise(setImmediate);
	assert.deepEqual(successful.login, {
		fields: "login-fields-match",
		http: "login-http-ok",
		code: "login-code-none",
	});
	assert.equal(successful.phase, "post-login");
	assert(!JSON.stringify(successful).includes("private"));
	const cancelledPage = new EventEmitter();
	const cancelled = observeSessionResponses(cancelledPage, origin, expected);
	const cancelledRequest = loginRequest();
	cancelledPage.emit("request", cancelledRequest);
	cancelledPage.emit("requestfailed", cancelledRequest);
	assert.deepEqual(cancelled.login, {
		fields: "login-fields-match",
		http: "login-http-request-failed",
		code: "login-code-unavailable",
	});
});
test("missing and malformed browser reports produce constant failure categories", () => {
	assert.deepEqual(failureSummary(), [
		"Browser diagnostic: report unavailable",
	]);
	for (const raw of ["private invalid JSON", "null", "{}", '"private"'])
		assert.deepEqual(failureSummary(raw), [
			"Browser diagnostic: invalid report",
		]);
	const changed = report();
	changed.suites[0].specs[0].title = "private case name";
	assert.deepEqual(failureSummary(JSON.stringify(changed)), [
		"Browser diagnostic: unrecognized report structure",
	]);
});
test("failure summaries show unstarted cases and bound report traversal", () => {
	const changed = report();
	changed.suites[0].specs.pop();
	assert.equal(
		failureSummary(JSON.stringify(changed)).at(-1),
		`Browser case: ${CASES.at(-1)}; status=not-run`,
	);
	const duplicate = report();
	duplicate.suites[0].specs.push(duplicate.suites[0].specs[0]);
	assert.deepEqual(failureSummary(JSON.stringify(duplicate)), [
		"Browser diagnostic: unrecognized report structure",
	]);
	assert.deepEqual(failureSummary(" ".repeat(2_000_001)), [
		"Browser diagnostic: invalid report",
	]);
	assert.deepEqual(
		failureSummary(
			JSON.stringify({ suites: Array.from({ length: 257 }, () => ({})) }),
		),
		["Browser diagnostic: unrecognized report structure"],
	);
});
test("discovery errors expose fixed categories without raw module paths or messages", () => {
	const changed = report();
	changed.errors = [
		{ message: "Error: Cannot find module '/private/credential-path'" },
		{
			message: "Playwright Test did not expect test.describe.configure() here",
		},
		{ message: "Error: No tests found. private filter" },
		{
			message: "browserType.launch: Executable doesn't exist at /private/path",
		},
		{ message: "SyntaxError: private source text" },
		{ message: "Run browser verification on a GitHub-hosted Linux runner" },
		{ message: "Only the dedicated loopback installation may be tested" },
		{ message: "private error, cookie and password" },
	];
	assert.deepEqual(failureSummary(JSON.stringify(changed)).slice(0, 8), [
		"Browser diagnostic: module resolution",
		"Browser diagnostic: test registration",
		"Browser diagnostic: test discovery",
		"Browser diagnostic: browser launch",
		"Browser diagnostic: module loading",
		"Browser diagnostic: hosted runner guard",
		"Browser diagnostic: fixture configuration",
		"Browser diagnostic: unclassified preflight error",
	]);
	assert(
		!failureSummary(JSON.stringify(changed)).join("\n").includes("private"),
	);
});
test("failed cases expose only bounded line numbers from the known browser test file", () => {
	const changed = report();
	const result = changed.suites[0].specs[0].tests[0].results[0];
	result.status = "failed";
	result.error = {
		message: "private password and cookie",
		location: { file: "/private/installed-gui.test.ts", line: 173 },
		stack: "private URL and token\n at /private/installed-gui.test.ts:202:3",
	};
	assert.equal(
		failureSummary(JSON.stringify(changed))[0],
		`Browser case: ${CASES[0]}; status=failed; lines=173,202`,
	);
	assert(
		!failureSummary(JSON.stringify(changed)).join("\n").includes("private"),
	);
	for (const line of [0, -1, 10001, "private", 2.5]) {
		result.error.location.line = line;
		result.error.stack = "private data";
		assert.equal(
			failureSummary(JSON.stringify(changed))[0],
			`Browser case: ${CASES[0]}; status=failed`,
		);
	}
	for (const name of [
		"other-installed-gui.test.ts",
		"xinstalled-gui.test.ts",
		"other installed-gui.test.ts",
	]) {
		result.error.stack = `at /private/${name}:202:3`;
		assert.equal(
			failureSummary(JSON.stringify(changed))[0],
			`Browser case: ${CASES[0]}; status=failed`,
		);
	}
});
test("a process being up is insufficient without all worker queue registrations", () => {
	const queues = [
		"usageStatistics",
		"orchestrator",
		"liveChannel",
		"vmafRunner",
		"feederManager",
		"storageInspect",
		"notify",
		"startupProbe",
		"slateNormalize",
	];
	const ready = queues
		.map((queue) => `[worker:${queue}] listening on synthetic`)
		.join("\n");
	assert(workerReady(ready));
	for (const queue of queues)
		assert(!workerReady(ready.replace(`[worker:${queue}] listening on `, "")));
});
test("cleanup checks directory and Docker labels before removing anything", async () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "bitovp-gui-")));
	writeFileSync(join(directory, ".owner"), id, { mode: 0o600 });
	const removed = [];
	const execute = async (_executable, args) => {
		assert.deepEqual(args.slice(0, 2), [
			"--host",
			"unix:///var/run/docker.sock",
		]);
		if (args.includes("--filter"))
			return args.includes("ps") ? "owned-container" : "";
		if (args.includes("inspect"))
			return JSON.stringify([
				{
					Config: {
						Labels: {
							"io.bitovp.gui-smoke": "wrong",
							"com.docker.compose.project": `bitovp-gui-${id}`,
						},
					},
				},
			]);
		removed.push(args);
		return "";
	};
	try {
		await assert.rejects(cleanupFixture({ id, directory }, execute, {}));
		assert.equal(removed.length, 0);
		assert.equal(readFileSync(join(directory, ".owner"), "utf8"), id);
		writeFileSync(join(directory, ".owner"), "wrong");
		await assert.rejects(cleanupFixture({ id, directory }, execute, {}));
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("cleanup removes both independent installations and their child temporary files", async () => {
	const create = (owner) => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "bitovp-gui-")));
		writeFileSync(join(directory, ".owner"), owner, { mode: 0o600 });
		writeFileSync(join(directory, "child-temp"), "synthetic private output", {
			mode: 0o600,
		});
		return { id: owner, directory };
	};
	const secondary = create("fedcba9876543210fedcba9876543210");
	const primary = { ...create(id), secondary };
	const images = [];
	const execute = async (_command, args) => {
		assert.deepEqual(args.slice(0, 2), [
			"--host",
			"unix:///var/run/docker.sock",
		]);
		if (args.includes("--filter")) {
			const owner = args
				.find((arg) => arg.startsWith("label=io.bitovp.gui-smoke="))
				?.split("=")
				.at(-1);
			assert(owner === primary.id || owner === secondary.id);
			assert(
				args.includes(`label=com.docker.compose.project=bitovp-gui-${owner}`),
			);
		} else if (args.includes("image")) images.push(args.at(-1));
		else throw new Error("Unexpected cleanup operation");
		return "";
	};
	try {
		await cleanupFixture(primary, execute, {});
		assert(!existsSync(primary.directory));
		assert(!existsSync(secondary.directory));
		assert.deepEqual(images, [
			`bitovp-gui-web:${secondary.id}`,
			`bitovp-gui-worker:${secondary.id}`,
			`bitovp-gui-web:${primary.id}`,
			`bitovp-gui-worker:${primary.id}`,
		]);
	} finally {
		for (const instance of [primary, secondary])
			rmSync(instance.directory, { recursive: true, force: true });
	}
});
