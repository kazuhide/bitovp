import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
for (const source of Object.values(sources)) {
	assert.match(source.commit, /^[a-f0-9]{40}$/);
	const tree = execFileSync("git", ["rev-parse", `${source.commit}^{tree}`], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	assert.equal(source.tree, tree);
}

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
			const copy = input.getByRole("button", {
				name: /ストリームキー.*コピー/,
			});
			inputCoordinates = await copy.evaluate((button) => {
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
			const inputImage = `input-${testCase.role.toLowerCase()}-320.png`;
			await copy.scrollIntoViewIfNeeded();
			await page.screenshot({
				path: join(evidence, inputImage),
				animations: "disabled",
			});
			if (inputCoordinates.fits) {
				await context.grantPermissions(["clipboard-read", "clipboard-write"], {
					origin: new URL(page.url()).origin,
				});
				const value = copy.locator("..").locator(":scope > span").nth(1);
				const expected = (await value.textContent())?.trim();
				assert.ok(expected, "Synthetic stream key must be present");
				await copy.click({ timeout: 4_000 });
				await page.waitForFunction(
					async (value) => (await navigator.clipboard.readText()) === value,
					expected,
					{ timeout: 4_000 },
				);
				inputCoordinates.clipboardMatches = true;
			}
			inputCoordinates.image = inputImage;
		}
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
const unexpected = observations.filter(
	({ verdictMatches, wrapMatches, inputCoordinates }) =>
		!verdictMatches || !wrapMatches || inputCoordinates?.fits === false,
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
