import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	binaryHashes,
	childEnvironment,
	summarizeTrace,
} from "../../scripts/bombadil-component.mjs";
import { guardedCommand } from "../../scripts/semantic-controls.mjs";

const root = resolve(import.meta.dirname, "../..");
const property = "liveLayoutRemainsValid";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function verifyLiveLayoutTrace(entries, exitCode) {
	assert(exitCode === 0 || exitCode === 2, `Bombadil exited with ${exitCode}`);
	const trace = summarizeTrace(entries);
	const actionCounts = { openHistory: 0, closeHistory: 0, scrollHeader: 0 };
	const violations = new Set();
	let previous;
	for (const entry of entries) {
		const snapshots = (entry.snapshots ?? []).filter(
			(snapshot) => snapshot.name === "state",
		);
		assert.equal(snapshots.length, 1, "Missing or duplicated layout snapshot");
		const { value } = snapshots[0];
		assert.equal(value?.ready, true, "Live layout readiness lost");
		assert(
			typeof value.historyOpen === "boolean" &&
				Number.isFinite(value.scrollY) &&
				Number.isInteger(value.rows) &&
				value.rows >= 0 &&
				Array.isArray(value.controls) &&
				value.controls.every((control) => typeof control === "string") &&
				Array.isArray(value.violations) &&
				value.violations.every(
					(violation) => typeof violation === "string" && violation.length > 0,
				),
			"Malformed layout snapshot",
		);
		for (const reason of value.violations) violations.add(reason);

		const action = entry.action;
		if (action != null) {
			assert(previous, "Missing initial layout snapshot");
			assert.equal(Object.keys(action).length, 1, "Unexpected action shape");
			if (action.Click) {
				const { fingerprint, point } = action.Click;
				assert(
					fingerprint?.tag === "summary" &&
						Number.isFinite(point?.x) &&
						Number.isFinite(point?.y),
					"Bombadil performed an unexpected click",
				);
				if (value.historyOpen !== previous.historyOpen)
					actionCounts[value.historyOpen ? "openHistory" : "closeHistory"]++;
			} else {
				const custom = action.Custom;
				assert(
					custom?.name === "scrollLiveLayout" &&
						Array.isArray(custom.arguments) &&
						custom.arguments.length === 1 &&
						["history", "header"].includes(custom.arguments[0]),
					"Bombadil performed an unexpected action",
				);
				if (
					custom.arguments[0] === "header" &&
					previous.scrollY > 0 &&
					value.scrollY === 0
				)
					actionCounts.scrollHeader++;
			}
		}
		previous = value;
	}
	if (exitCode === 0) {
		assert(
			trace.violationNames.length === 0 && violations.size === 0,
			"Passed run contains a rule violation",
		);
		assert(
			Object.values(actionCounts).every((count) => count > 0),
			"Live history exploration coverage incomplete",
		);
	} else {
		assert(
			trace.violationNames.length === 1 &&
				trace.violationNames[0] === property &&
				violations.size > 0,
			"Bombadil failed without the observed layout rule violation",
		);
	}
	return {
		status: exitCode === 0 ? "pass" : "violation",
		exitCode,
		stateCount: trace.states,
		actions: trace.actions,
		actionCounts,
		violationNames: trace.violationNames,
		violations: [...violations].sort(),
	};
}

async function ownedPageTarget(endpoint, page, url) {
	const response = await fetch(`${endpoint}/json/list`, {
		redirect: "error",
		signal: AbortSignal.timeout(3000),
	});
	assert(response.ok, "Could not enumerate the local Chromium target");
	const pages = (await response.json()).filter(
		(target) => target.type === "page",
	);
	assert.equal(pages.length, 1, "Bombadil needs one dedicated page target");
	assert.equal(
		pages[0].url,
		url,
		"CDP page differs from the prepared Live route",
	);
	const session = await page.context().newCDPSession(page);
	try {
		const { targetInfo } = await session.send("Target.getTargetInfo");
		assert.equal(
			pages[0].id,
			targetInfo.targetId,
			"CDP target differs from the prepared Playwright page",
		);
		return targetInfo.targetId;
	} finally {
		await session.detach();
	}
}

export async function exploreLiveLayout({
	binary,
	page,
	endpoint,
	output,
	cwd = root,
	timeLimitSeconds = 8,
	reproduce,
}) {
	assert(
		isAbsolute(binary) && isAbsolute(output) && isAbsolute(cwd),
		"Use absolute Bombadil and evidence paths",
	);
	assert(
		Number.isInteger(timeLimitSeconds) && timeLimitSeconds > 0,
		"Specify a positive exploration duration in seconds",
	);
	assert(
		/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(endpoint),
		"Use the dedicated loopback CDP endpoint",
	);
	const url = page.url();
	assert(
		/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9]\d*\/live\/[a-f\d-]+$/.test(url),
		"Use a prepared synthetic loopback Live detail page",
	);
	const viewport = page.viewportSize();
	assert(viewport, "A fixed Playwright viewport is required");
	assert.equal(
		page.context().pages().length,
		1,
		"Use a dedicated browser context",
	);
	const targetId = await ownedPageTarget(endpoint, page, url);
	const binarySha256 = digest(await readFile(binary));
	assert.equal(
		binarySha256,
		binaryHashes[`${process.platform}-${process.arch}`],
		"Unexpected Bombadil binary hash",
	);

	await mkdir(output, { mode: 0o700 });
	const specification = join(output, "specification.ts");
	const specBytes = await readFile(
		join(cwd, "tests/bombadil/live-layout.spec.ts"),
	);
	await writeFile(specification, specBytes, { mode: 0o600, flag: "wx" });
	const traceDirectory = join(output, "trace");
	const args = [
		"browser",
		"test-external",
		"--remote-debugger",
		endpoint,
		"--width",
		String(viewport.width),
		"--height",
		String(viewport.height),
		"--output-path",
		traceDirectory,
		...(reproduce
			? ["--reproduce", resolve(reproduce)]
			: ["--time-limit", `${timeLimitSeconds}s`, "--exit-on-violation"]),
		url,
		specification,
	];

	await page.evaluate(() => {
		const probe = window.__bitovpLiveLayoutProbe;
		if (!probe?.read().ready || window.__bitovpLiveLayoutExploration)
			throw new Error("Live layout probe is missing or already in use");
		const summaries = document.querySelectorAll("#sec-manifests > summary");
		const summary = summaries[0];
		const disclosure = summary?.parentElement;
		if (summaries.length !== 1 || !(disclosure instanceof HTMLDetailsElement))
			throw new Error("Live observation history disclosure is unavailable");
		let open = disclosure.open;
		const exploration = {
			disclosure,
			summary,
			openHistory: 0,
			closeHistory: 0,
			scrollHeader: 0,
			historyObscured: false,
			dispose: () => disclosure.removeEventListener("toggle", onToggle),
		};
		const onToggle = () => {
			if (disclosure.open === open) return;
			open = disclosure.open;
			exploration[open ? "openHistory" : "closeHistory"]++;
		};
		disclosure.addEventListener("toggle", onToggle);
		window.__bitovpLiveLayoutExploration = exploration;
	});

	const started = performance.now();
	let log = "";
	let exitCode;
	try {
		// Keep the owned process group and capture CLI stdout as well.
		exitCode = await guardedCommand(
			"/bin/sh",
			["-c", 'exec "$@" 1>&2', "bombadil", binary, ...args],
			{
				cwd,
				env: childEnvironment(output),
				exitPath: join(output, "exit.json"),
				timeout: (timeLimitSeconds + 15) * 1000,
				diagnostics: (part) => {
					log = (log + part).slice(-65536);
				},
			},
		);
	} finally {
		try {
			await writeFile(join(output, "bombadil.log"), log, {
				mode: 0o600,
				flag: "wx",
			});
		} finally {
			if (page.url() === url && !page.isClosed())
				await page.evaluate(() => {
					window.__bitovpLiveLayoutExploration?.dispose();
					delete window.__bitovpLiveLayoutExploration;
				});
		}
	}
	if (reproduce) assert.match(log, /Reproduction finished/);
	assert.equal(
		await ownedPageTarget(endpoint, page, url),
		targetId,
		"Bombadil replaced the dedicated Live page",
	);
	assert(exitCode === 0 || exitCode === 2, `Bombadil exited with ${exitCode}`);
	const tracePath = join(traceDirectory, "trace.jsonl");
	assert(
		(await stat(tracePath)).size <= 16 * 1024 * 1024,
		"Layout trace is too large",
	);
	const traceBytes = await readFile(tracePath);
	const entries = traceBytes
		.toString("utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const result = {
		...verifyLiveLayoutTrace(entries, exitCode),
		elapsedMs: Math.round(performance.now() - started),
		viewport,
		binarySha256,
		specificationSha256: digest(specBytes),
		traceSha256: digest(traceBytes),
		tracePath,
		replayTrace: traceDirectory,
	};
	await writeFile(
		join(output, "summary.json"),
		`${JSON.stringify(result, null, 2)}\n`,
		{
			mode: 0o600,
			flag: "wx",
		},
	);
	return result;
}
