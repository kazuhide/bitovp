/**
 * Inspect rendered Japanese screens for English prose that bypassed the
 * translation catalog. Reads visible page text and tooltip bodies in Chrome.
 *
 * Run against an authenticated local browser and review flagged text manually:
 * technical names, identifiers, and upstream error messages may be valid English.
 * Requires a running application and Chrome; this is a manual diagnostic tool.
 */

import { spawn } from "node:child_process";

/**
 * Vocabulary that legitimately stays Latin in a Japanese UI: codec and container
 * names, protocol names, provider names, status enums the app shows verbatim, and the
 * product's own name. Kept deliberately generous — a false positive costs one glance,
 * while a false negative is the defect this script exists to find, so anything
 * ambiguous is left OUT of this list and shows up in the output.
 */
const TECHNICAL = new Set(
	`bitmovin ovp vmaf psnr hls dash smooth cmaf fmp4 mp4 webm cenc drm srt rtmp
	h264 h265 hevc av1 vp9 aac opus atmos dolby ddplus json yaml uuid url uri api sdk cli
	ffmpeg libvmaf auth mode none password oidc aws gcs azure akamai oci s3 sftp cdn acl
	cors get put post head delete finished error running stopped pending queued created
	starting stopping canceled cancelled draft external vod live dvr abr per title pertitle
	prisma postgres redis docker next react node pnpm biome vitest tsx english mbps kbps
	fps sec min max mean harmonic gen id ids netstorage generics3 http https localhost
	webhook hmac generic cloud connect hash readme heartbeat listener caller sample
	rendition renditions encoding encodings input inputs output outputs delivery auto`
		.split(/\s+/)
		.filter(Boolean),
);

function flag(argName: string): string | undefined {
	const i = process.argv.indexOf(`--${argName}`);
	return i === -1 ? undefined : process.argv[i + 1];
}

type Cdp = {
	send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
	close: () => void;
};

async function connect(port: number): Promise<Cdp> {
	const chrome = spawn(
		flag("chrome") ??
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		[
			"--headless=new",
			"--disable-gpu",
			"--no-sandbox",
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${flag("profile") ?? "/tmp/ja-render-sweep"}`,
			"about:blank",
		],
		{ stdio: "ignore" },
	);
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	let target: { webSocketDebuggerUrl: string } | undefined;
	for (let i = 0; i < 40 && !target; i += 1) {
		await sleep(500);
		try {
			const list = (await (
				await fetch(`http://127.0.0.1:${port}/json/list`)
			).json()) as { type: string; webSocketDebuggerUrl: string }[];
			target = list.find((t) => t.type === "page");
		} catch {
			// Chrome is not listening yet.
		}
	}
	if (!target) {
		chrome.kill();
		throw new Error("Chrome did not expose a debugging target");
	}
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	let id = 0;
	const pending = new Map<number, (value: unknown) => void>();
	ws.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data)) as { id?: number };
		if (message.id && pending.has(message.id)) {
			pending.get(message.id)?.(message);
			pending.delete(message.id);
		}
	});
	await new Promise((r) => ws.addEventListener("open", r));
	return {
		send: (method, params = {}) =>
			new Promise((resolve) => {
				id += 1;
				pending.set(id, resolve);
				ws.send(JSON.stringify({ id, method, params }));
			}),
		close: () => {
			ws.close();
			chrome.kill();
		},
	};
}

async function main() {
	const base = flag("base") ?? "http://127.0.0.1:3200";
	const settle = Number(flag("settle") ?? 7000);
	/**
	 * Paths are the bare arguments — NOT the values of flags. The first version
	 * filtered on `startsWith("/")`, so `--profile /tmp/...` made the profile path a
	 * target: the sweep navigated to it, got the 404 page, and reported its English
	 * text as a finding. Which did find a real defect (Next's untranslated 404), but
	 * by accident, and it would just as happily have hidden one behind noise.
	 */
	const flagValues = new Set(
		["base", "settle", "port", "chrome", "profile"]
			.map((name) => flag(name))
			.filter((v): v is string => v !== undefined),
	);
	const paths = process.argv
		.slice(2)
		.filter((a) => a.startsWith("/") && !a.includes(" ") && !flagValues.has(a));
	if (paths.length === 0) {
		throw new Error("give at least one path, e.g. /qc /vod/jobs");
	}
	const cdp = await connect(Number(flag("port") ?? 9227));
	let flagged = 0;
	try {
		await cdp.send("Page.enable");
		await cdp.send("Runtime.enable");
		await cdp.send("Network.enable");
		// THE POINT OF THE INSTRUMENT, previously missing: set the app's locale
		// cookie so the sweep renders the JAPANESE app. Without this it swept the
		// English app unless a profile had been hand-seeded — the instrument was
		// named for a thing it never did .
		await cdp.send("Network.setCookie", {
			name: "ovp-locale",
			value: "ja",
			url: base,
		});
		for (const path of paths) {
			await cdp.send("Page.navigate", { url: `${base}${path}` });
			await new Promise((r) => setTimeout(r, settle));
			const result = (await cdp.send("Runtime.evaluate", {
				// innerText PLUS every tooltip body: InfoHint renders its text in a
				// `role="tooltip"` element that is `hidden` until hover, and
				// innerText cannot see hidden nodes BY CONSTRUCTION — which is how
				// seven English tooltip paragraphs sat invisible on the very screen
				// this instrument had "proven" . textContent reads them
				// regardless of visibility; role=tooltip is the semantic handle.
				expression: `document.body.innerText + "\n" + Array.from(
					document.querySelectorAll('[role="tooltip"]')
				).map((el) => el.textContent ?? "").join("\n")`,
				returnByValue: true,
			})) as { result?: { result?: { value?: string } } };
			const text = result.result?.result?.value ?? "";
			const words = [
				...new Set(
					(text.match(/[A-Za-z][A-Za-z'-]{3,}/g) ?? [])
						.map((w) => w.toLowerCase())
						.filter((w) => !TECHNICAL.has(w)),
				),
			];
			console.log(`\n${path}`);
			if (words.length === 0) {
				console.log("  clean");
			} else {
				flagged += 1;
				console.log(`  english-looking: ${words.join(" ")}`);
			}
		}
	} finally {
		cdp.close();
	}
	console.log(
		`\n${paths.length - flagged}/${paths.length} screens clean. Every hit needs a human read: most are data (job names, buckets, upstream API error text).`,
	);
	process.exitCode = flagged === 0 ? 0 : 1;
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exitCode = 1;
});
