import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { openLiveLayoutFixture } from "../tests/browser/live-layout-pilot-fixture.mjs";
import { attachLiveLayoutProbe } from "../tests/browser/live-layout-pilot-probe.mjs";

import {
	inspectLiveSource,
	launchLiveSource,
} from "../tests/browser/live-layout-server.mjs";

const root = resolve(import.meta.dirname, "..");
const browserSignals = {
	handleSIGINT: false,
	handleSIGTERM: false,
	handleSIGHUP: false,
	timeout: 10000,
};
const historicCommit = "782632d355c6a8bf44b7c1ad02ba29f6bf853420";
const { values: options } = parseArgs({
	options: {
		historical: { type: "string" },
		current: { type: "string" },
		output: { type: "string" },
		lean: { type: "string" },
		bombadil: { type: "string" },
	},
	allowPositionals: false,
});

for (const key of ["historical", "current", "output", "lean"]) {
	assert.ok(options[key], `Provide --${key}`);
}
const evidence = resolve(options.output);
assert.ok(
	evidence !== root && !evidence.startsWith(`${root}/`),
	"Use a fresh evidence directory outside the checkout",
);
await mkdir(evidence, { mode: 0o700 });
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (name, value) =>
	writeFile(join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
	});
const checkouts = {
	historical: inspectLiveSource(options.historical),
	current: inspectLiveSource(options.current),
};
assert.equal(checkouts.historical.commit, historicCommit);
assert.notEqual(checkouts.current.commit, checkouts.historical.commit);
assert.notEqual(checkouts.current.root, root);
const databaseUrl = new URL(process.env.BITOVP_PILOT_DATABASE_URL);
assert.equal(databaseUrl.protocol, "postgresql:");
assert.equal(databaseUrl.hostname, "127.0.0.1");
assert.ok(databaseUrl.port, "Use a disposable loopback PostgreSQL instance");

const servers = {};
const browsers = new Set();
let stopping = false;
let cleanup;
function ownBrowser(launch, profile) {
	let disposal;
	const close = () =>
		(disposal ??= (async () => {
			try {
				const browser = await launch.catch(() => null);
				const failures = [];
				try {
					if (browser) await browser.close();
				} catch (error) {
					failures.push(error);
				}
				try {
					if (profile) await rm(profile, { recursive: true, force: true });
				} catch (error) {
					failures.push(error);
				}
				if (failures.length === 1) throw failures[0];
				if (failures.length)
					throw new AggregateError(failures, "Browser disposal failed");
			} finally {
				browsers.delete(close);
			}
		})());
	browsers.add(close);
	return { launch, close };
}
function cleanUp() {
	return (cleanup ??= (async () => {
		const browserResults = await Promise.allSettled(
			[...browsers].map((close) => close()),
		);
		const serverResults = await Promise.allSettled(
			Object.entries(servers).map(async ([label, runtime]) => {
				try {
					await runtime.terminate();
				} finally {
					await writeFile(
						join(evidence, `next-${label}.log`),
						runtime.getLog(),
						{ mode: 0o600 },
					);
				}
			}),
		);
		const failures = [...browserResults, ...serverResults].flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length)
			throw new AggregateError(failures, "Pilot cleanup failed");
	})());
}
const exitOnSignal = (code) => {
	if (stopping) return;
	stopping = true;
	void cleanUp().then(
		() => process.exit(code),
		(error) => {
			console.error(error);
			process.exit(1);
		},
	);
};
process.once("SIGTERM", () => exitOnSignal(143));
process.once("SIGINT", () => exitOnSignal(130));
process.once("SIGHUP", () => exitOnSignal(129));
const next = join(root, "apps/web/node_modules/next/dist/bin/next");
try {
	// Register both owned processes before the first await so signal cleanup sees both.
	for (const [label, source] of Object.entries(checkouts)) {
		const runtime = launchLiveSource(
			source,
			databaseUrl.href,
			next,
			join(evidence, `next-${label}-exit.json`),
		);
		servers[label] = runtime;
		void runtime.ready.catch(() => {});
	}
	const sources = Object.fromEntries(
		await Promise.all(
			Object.entries(checkouts).map(async ([label, source]) => [
				label,
				{ ...source, baseURL: await servers[label].ready },
			]),
		),
	);
	if (!stopping) {
		await save("sources.json", sources);
		await runPilot(sources);
		for (const runtime of Object.values(servers)) assert.ok(runtime.alive());
	}
} catch (error) {
	if (!stopping) throw error;
} finally {
	await cleanUp();
}
for (const source of Object.values(checkouts))
	assert.deepEqual(inspectLiveSource(source.root), source);

async function runPilot(sources) {
	const leanStart = performance.now();
	const oracle = JSON.parse(
		execFileSync(
			resolve(options.lean),
			["--run", join(root, "verification/lean/LiveLayoutControls.lean")],
			{ cwd: root, encoding: "utf8", timeout: 30_000 },
		),
	);
	const leanMs = Math.round(performance.now() - leanStart);
	assert.equal(oracle.length, 8);
	await save("lean-oracle.json", { elapsedMs: leanMs, rows: oracle });
	const cases = await readJson(
		join(root, "tests/browser/live-layout-pilot-cases.json"),
	);

	function expectedByHistory(testCase) {
		const rows = oracle.filter(
			({ role, phase }) => role === testCase.role && phase === testCase.phase,
		);
		assert.deepEqual(rows.map(({ historyOpen }) => historyOpen).sort(), [
			false,
			true,
		]);
		return Object.fromEntries(
			rows.map(({ historyOpen, actions }) => [String(historyOpen), actions]),
		);
	}

	const viewport = (testCase) => ({ width: testCase.width, height: 1000 });
	const fitOptions = { locale: "ja-JP", serviceWorkers: "block" };
	async function open(context, testCase) {
		const fixture = await openLiveLayoutFixture({
			context,
			baseURL: sources[testCase.source].baseURL,
			role: testCase.role,
			phase: testCase.phase,
			title: testCase.title,
		});
		await attachLiveLayoutProbe(fixture.page, {
			title: testCase.title,
			expectedByHistory: expectedByHistory(testCase),
			maxGap: testCase.maxGap,
		});
		return fixture;
	}

	async function observe(page) {
		await page.getByRole("heading", { level: 1 }).scrollIntoViewIfNeeded();
		const snapshot = await page.evaluate(() =>
			window.__bitovpLiveLayoutProbe.read(),
		);
		assert.equal(snapshot.ready, true);
		return snapshot;
	}

	async function exercise(browser, testCase, position) {
		const context = await browser.newContext({
			...fitOptions,
			viewport: viewport(testCase),
		});
		const started = performance.now();
		try {
			const { page, deniedRequests } = await open(context, testCase);
			const states = [
				{ operation: "open-detail", layout: await observe(page) },
			];
			const image = `render-${String(position + 1).padStart(2, "0")}.png`;
			await page.screenshot({
				path: join(evidence, image),
				animations: "disabled",
			});
			for (const { label } of states[0].layout.buttons) {
				await page
					.getByRole("button", { name: label, exact: true })
					.click({ trial: true, timeout: 4_000 });
			}
			const historyHeader = page.locator("#sec-manifests > summary");
			if (testCase.role === "OPERATOR") {
				assert.equal(
					await historyHeader.count(),
					1,
					"Operator history disclosure must be present",
				);
				for (let i = 0; i < 2; i++) {
					const previous = states.at(-1).layout.historyOpen;
					await historyHeader.click();
					await page.waitForFunction((wasOpen) => {
						const disclosure = document.querySelector("#sec-manifests");
						return (
							disclosure instanceof HTMLDetailsElement &&
							disclosure.open === !wasOpen
						);
					}, previous);
					states.push({
						operation: previous ? "close-history" : "open-history",
						layout: await observe(page),
					});
				}
			}
			let inputCoordinates = null;
			if (testCase.width === 320 && testCase.phase === "RUNNING") {
				const input = page.locator("#sec-ingest");
				await input.scrollIntoViewIfNeeded();
				const inputImage = `input-${testCase.role.toLowerCase()}-320.png`;
				await page.screenshot({
					path: join(evidence, inputImage),
					animations: "disabled",
				});
				await context.grantPermissions(["clipboard-read", "clipboard-write"], {
					origin: new URL(page.url()).origin,
				});
				const rows = [];
				for (const label of [
					"RTMP 送信先 URL",
					"RTMP 送信先(完全形)",
					"ストリームキー",
				]) {
					const copy = input.getByRole("button", {
						name: `${label} をコピー`,
						exact: true,
					});
					const measured = await copy.evaluate((button) => {
						const row = button.closest("li");
						const rowRight = row.getBoundingClientRect().right;
						const buttonRight = button.getBoundingClientRect().right;
						const valueWidth = row.children[1].getBoundingClientRect().width;
						return {
							rowRight,
							buttonRight,
							valueWidth,
							fits: buttonRight <= rowRight + 1 && valueWidth > 0,
						};
					});
					if (measured.fits) {
						const row = copy.locator("..");
						const expected = (
							await row.locator(":scope > span").nth(1).textContent()
						)?.trim();
						assert.ok(expected, "Synthetic input value must be present");
						await copy.click({ timeout: 4_000 });
						await row
							.getByRole("status")
							.filter({ hasText: /^コピーしました$/ })
							.waitFor({
								state: "attached",
								timeout: 4_000,
							});
						assert.equal(
							await page.evaluate(() => navigator.clipboard.readText()),
							expected,
						);
					}
					rows.push({
						label,
						...measured,
						clipboardMatches: measured.fits,
					});
				}
				inputCoordinates = {
					fits: rows.every((row) => row.fits),
					rows,
					image: inputImage,
				};
			}
			const headingLines = await page
				.getByRole("heading", { level: 1 })
				.evaluate((heading) => {
					const range = document.createRange();
					range.selectNodeContents(heading);
					const rectangles = [...range.getClientRects()];
					for (let node = heading; node; node = node.parentElement) {
						const style = getComputedStyle(node);
						const box = node.getBoundingClientRect();
						const horizontalClip =
							node === heading || style.overflowX !== "visible";
						const verticalClip =
							node === heading || style.overflowY !== "visible";
						if (
							rectangles.some(
								(rect) =>
									(horizontalClip &&
										(rect.left < box.left - 1 || rect.right > box.right + 1)) ||
									(verticalClip &&
										(rect.top < box.top - 1 || rect.bottom > box.bottom + 1)),
							)
						)
							return 0;
					}
					return new Set(rectangles.map((rect) => Math.round(rect.top))).size;
				});
			assert.deepEqual(deniedRequests, []);
			const violations = [
				...new Set(states.flatMap(({ layout }) => layout.violations)),
			].sort();
			const verdictMatches =
				JSON.stringify(violations) ===
				JSON.stringify([...testCase.expect].sort());
			const wrapMatches =
				!testCase.wrap || states.some(({ layout }) => layout.rows > 1);
			return {
				...testCase,
				commit: sources[testCase.source].commit,
				image,
				elapsedMs: Math.round(performance.now() - started),
				states,
				violations,
				verdictMatches,
				wrapMatches,
				inputCoordinates,
				headingLines,
			};
		} finally {
			await context.close();
		}
	}

	if (stopping) return;
	const mainBrowser = ownBrowser(
		chromium.launch({ ...browserSignals, headless: true }),
	);
	const observations = [];
	try {
		const browser = await mainBrowser.launch;
		for (const [index, testCase] of cases.entries()) {
			const result = await exercise(browser, testCase, index);
			observations.push(result);
			console.log(
				`${result.id} ${result.violations.join(",") || "pass"} ${result.elapsedMs}ms`,
			);
		}
	} finally {
		await mainBrowser.close();
		await save("observations.json", observations);
	}
	await save(
		"design-review-cases.json",
		observations.map(({ image, role, phase, width }) => ({
			image,
			role,
			phase,
			width,
			task:
				role === "VIEWER"
					? "配信の状態を確認する"
					: phase === "STOPPED"
						? "停止済みの配信から再開、または同じ設定で新規配信の準備をする"
						: "稼働中の配信の運用操作を見つける",
		})),
	);

	async function explore(testCase, reproduce) {
		const { exploreLiveLayout } = await import(
			"../tests/browser/live-layout-bombadil.mjs"
		);
		const id = reproduce ? `replay-${testCase.id}` : testCase.id;
		const profile = join(evidence, `profile-${id}`);
		if (stopping) throw new Error("Pilot interrupted");
		const explorationBrowser = ownBrowser(
			chromium.launchPersistentContext(profile, {
				...browserSignals,
				...fitOptions,
				viewport: viewport(testCase),
				headless: true,
				args: [
					"--remote-debugging-address=127.0.0.1",
					"--remote-debugging-port=0",
				],
			}),
			profile,
		);
		try {
			const context = await explorationBrowser.launch;
			if (stopping) throw new Error("Pilot interrupted");
			const { page, deniedRequests } = await open(context, testCase);
			for (const blank of context.pages()) {
				if (blank !== page) await blank.close();
			}
			const port = Number(
				(await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
					"\n",
				)[0],
			);
			assert.ok(Number.isInteger(port) && port > 0 && port < 65_536);
			const result = await exploreLiveLayout({
				binary: resolve(options.bombadil),
				page,
				endpoint: `http://127.0.0.1:${port}`,
				output: join(evidence, `exploration-${id}`),
				cwd: root,
				timeLimitSeconds: 8,
				reproduce,
			});
			assert.deepEqual(deniedRequests, []);
			return { id, ...result };
		} finally {
			await explorationBrowser.close();
		}
	}

	const explorations = [];
	if (options.bombadil) {
		for (const testCase of cases.filter(({ id }) =>
			[
				"reported-desktop",
				"compact-desktop",
				"long-name-mobile",
				"wrapped-running",
			].includes(id),
		)) {
			const result = await explore(testCase);
			explorations.push(result);
			console.log(
				`Bombadil ${result.id} ${result.status} ${result.elapsedMs}ms`,
			);
			await save("explorations.json", explorations);
		}
		const historic = explorations.find(({ id }) => id === "reported-desktop");
		assert.equal(historic.status, "violation");
		assert.deepEqual(historic.violations, ["separated-actions"]);
		const replay = await explore(
			cases.find(({ id }) => id === historic.id),
			historic.replayTrace,
		);
		assert.equal(replay.status, "violation");
		assert.deepEqual(replay.violations, historic.violations);
		explorations.push(replay);
		await save("explorations.json", explorations);
	}
	const unexpected = observations.filter(
		({
			verdictMatches,
			wrapMatches,
			inputCoordinates,
			wrapTitle,
			headingLines,
		}) =>
			!verdictMatches ||
			!wrapMatches ||
			inputCoordinates?.fits === false ||
			(wrapTitle && headingLines <= 1),
	);
	assert.deepEqual(
		unexpected.map(({ id, violations }) => ({ id, violations })),
		[],
	);
	if (options.bombadil) {
		assert.deepEqual(
			explorations.map(({ status }) => status),
			["violation", "pass", "pass", "pass", "violation"],
		);
	}
}
