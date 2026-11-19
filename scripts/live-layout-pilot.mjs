import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { openLiveLayoutFixture } from "../tests/browser/live-layout-pilot-fixture.mjs";
import { attachLiveLayoutProbe } from "../tests/browser/live-layout-pilot-probe.mjs";

const root = resolve(import.meta.dirname, "..");
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
const sources = {
	historical: await readJson(options.historical),
	current: await readJson(options.current),
};
assert.equal(sources.historical.commit, historicCommit);
assert.notEqual(sources.current.commit, sources.historical.commit);
assert.notEqual(sources.current.baseURL, sources.historical.baseURL);
async function verifyServingSource(source) {
	assert.match(source.commit, /^[a-f0-9]{40}$/);
	assert.match(source.proof, /^[a-f0-9-]{36}$/);
	assert.equal(source.root, await realpath(source.root));
	assert.notEqual(source.root, root);
	const origin = new URL(source.baseURL);
	assert.match(origin.origin, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
	assert.equal(origin.href, `${source.baseURL}/`);
	const filename = `live-layout-${source.proof}.json`;
	const marker = `apps/web/public/${filename}`;
	const git = (...args) =>
		execFileSync("git", args, { cwd: source.root, encoding: "utf8" }).trim();
	assert.equal(git("rev-parse", "--show-toplevel"), source.root);
	assert.equal(git("rev-parse", "HEAD"), source.commit);
	assert.equal(git("rev-parse", "HEAD^{tree}"), source.tree);
	assert.equal(
		git(
			"status",
			"--porcelain",
			"--untracked-files=all",
			"--",
			".",
			":(exclude)apps/web/next-env.d.ts",
		),
		`?? ${marker}`,
	);
	const expected = {
		commit: source.commit,
		tree: source.tree,
		proof: source.proof,
	};
	assert.deepEqual(await readJson(join(source.root, marker)), expected);
	const response = await fetch(new URL(`/${filename}`, origin), {
		cache: "no-store",
		redirect: "error",
		signal: AbortSignal.timeout(4_000),
	});
	assert.equal(
		response.status,
		200,
		"Expected the dedicated pilot source marker from the server",
	);
	assert.deepEqual(await response.json(), expected);
}
for (const source of Object.values(sources)) await verifyServingSource(source);
assert.notEqual(sources.historical.root, sources.current.root);

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
		const states = [{ operation: "open-detail", layout: await observe(page) }];
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
			for (const label of [/RTMP.*コピー/, /ストリームキー.*コピー/]) {
				const copies = input.getByRole("button", { name: label });
				assert.ok(
					(await copies.count()) > 0,
					`Missing synthetic copy actions: ${label}`,
				);
				for (const copy of await copies.all()) {
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
						label: label.source,
						...measured,
						clipboardMatches: measured.fits,
					});
				}
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
				return new Set(
					Array.from(range.getClientRects(), (rect) => Math.round(rect.top)),
				).size;
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

const browser = await chromium.launch({ headless: true });
let observations;
try {
	observations = [];
	for (const [index, testCase] of cases.entries()) {
		const result = await exercise(browser, testCase, index);
		observations.push(result);
		console.log(
			`${result.id} ${result.violations.join(",") || "pass"} ${result.elapsedMs}ms`,
		);
	}
} finally {
	await browser.close();
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
	const context = await chromium.launchPersistentContext(profile, {
		...fitOptions,
		viewport: viewport(testCase),
		headless: true,
		args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"],
	});
	try {
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
		await context.close();
		await rm(profile, { recursive: true, force: true });
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
		console.log(`Bombadil ${result.id} ${result.status} ${result.elapsedMs}ms`);
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
for (const source of Object.values(sources)) await verifyServingSource(source);
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
