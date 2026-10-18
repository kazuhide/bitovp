/**
 * Does a real browser actually PLAY this manifest?
 *
 * Every other check in this repo proves the bytes are right. This one proves the
 * thing an operator does: a browser engine, real hls.js/dash.js, real CORS
 * enforcement, real MSE decode. It exists to settle two questions:
 *
 *   1. does an anonymous browser play our public output at all?
 *   2. does it FAIL when the bucket withholds `Access-Control-Expose-Headers`?
 *      This probes the CORS prerequisite rather than only parsing a manifest.
 *
 * How: serve a one-file harness from 127.0.0.1 (a real http origin, so the
 * browser applies CORS exactly as it would on the app), load the player from
 * this repo's own `node_modules` copy, and have the page POST its verdict back.
 * Chrome runs headless — `--headless=new` still has MSE and the software codecs,
 * which is what makes the decode claim real rather than a manifest parse.
 *
 * Usage:
 *   pnpm --filter @bitovp/worker exec tsx scripts/playback-probe.ts \
 *     --url <manifest-url> [--kind HLS|DASH] [--seconds 12] [--chrome <path>]
 *
 * Exit code: 0 = played, 1 = did not. The report goes to stdout as JSON.
 *
 * Deliberately NOT part of the corpus runner: it needs a browser binary, which
 * the worker image does not have, so it runs on the host against an output the
 * corpus has already verified.
 */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

type Args = {
	url: string;
	kind: "HLS" | "DASH";
	seconds: number;
	chrome: string;
	keepOpen: boolean;
	/**
	 * Skip the native-HLS branch and go through hls.js/MSE.
	 *
	 * Not a hypothetical: Chrome on macOS answers `canPlayType(
	 * "application/vnd.apple.mpegurl")` truthily, so the app's native-first branch
	 * takes it — and that path largely ignores CORS (§3's "it works in Safari is a
	 * false positive", which turns out to apply to Chrome/macOS too). A CORS
	 * finding is only reachable through MSE, so the probe has to be able to force
	 * it.
	 */
	forceMse: boolean;
	/**
	 * : drive the BITMOVIN PLAYER instead of hls.js/dash.js — the
	 * licence + domain-lock verification . The licence allowlist
	 * matches hostnames, so `--host localhost` exists because the licence
	 * that allows `localhost` does not thereby allow `127.0.0.1`.
	 */
	player: "native" | "bitmovin";
	licenseKey: string;
	host: string;
};

const CHROME_DEFAULT =
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function parseArgs(argv: string[]): Args {
	const get = (flag: string): string | undefined => {
		const at = argv.indexOf(flag);
		return at >= 0 ? argv[at + 1] : undefined;
	};
	const url = get("--url");
	if (!url) {
		throw new Error("--url <manifest-url> is required");
	}
	const kind = (get("--kind") ??
		(url.includes(".mpd") ? "DASH" : "HLS")) as Args["kind"];
	return {
		url,
		kind,
		seconds: Number(get("--seconds") ?? 12),
		chrome: get("--chrome") ?? CHROME_DEFAULT,
		keepOpen: argv.includes("--keep-open"),
		forceMse: argv.includes("--force-mse"),
		player: (get("--player") ?? "native") as Args["player"],
		licenseKey: get("--license-key") ?? "",
		host: get("--host") ?? "127.0.0.1",
	};
}

/**
 * The page mirrors `playback-surface.tsx` for HLS and Bitmovin Player: same
 * library, events and native-HLS check. DASH is intentionally different:
 * dash.js proves output compatibility only and must never be cited as evidence
 * that the product's Shaka path loaded or decoded the stream.
 */
function harnessHtml(args: Args): string {
	return `<!doctype html>
<meta charset="utf-8">
<title>playback probe</title>
<body style="background:#111;color:#eee;font:14px system-ui">
<video id="v" muted playsinline controls style="width:640px"></video>
<pre id="log"></pre>
<script src="/lib/player.js"></script>
<script>
const url = ${JSON.stringify(args.url)};
const kind = ${JSON.stringify(args.kind)};
const deadline = ${args.seconds} * 1000;
const forceMse = ${args.forceMse};
const events = [];
const video = document.getElementById("v");
function note(kind, detail) {
  events.push({ at: Math.round(performance.now()), kind, detail });
  document.getElementById("log").textContent = events
    .map((e) => e.at + "ms " + e.kind + " " + (e.detail ?? "")).join("\\n");
}
let done = false;
async function report(verdict, extra) {
  if (done) return;
  done = true;
  const v = {
    verdict,
    url, kind,
    // The decode evidence: a non-zero currentTime with readyState >= 2 means
    // frames were demuxed, decoded and presented — not merely fetched.
    currentTime: video.currentTime,
    readyState: video.readyState,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    buffered: video.buffered.length ? video.buffered.end(0) : 0,
    events,
    ...extra,
  };
  await fetch("/result", { method: "POST", body: JSON.stringify(v) });
}
video.addEventListener("timeupdate", () => {
  if (video.currentTime > 0.2 && video.readyState >= 2) {
    note("timeupdate", video.currentTime.toFixed(2));
    report("PLAYED");
  }
});
video.addEventListener("error", () => note("video-error", String(video.error && video.error.code)));
const playerKind = ${JSON.stringify(args.player)};
const licenseKey = ${JSON.stringify(args.licenseKey)};
(async () => {
  try {
    if (playerKind === "bitmovin") {
      const B = window.bitmovin;
      if (!B || !B.player) { return report("NO_LIB"); }
      const el = document.createElement("div");
      el.style.width = "640px"; el.style.height = "360px";
      document.body.insertBefore(el, video);
      const p = new B.player.Player(el, {
        key: licenseKey,
        playback: { autoplay: true, muted: true },
      });
      p.on(B.player.PlayerEvent.Error, (e) => {
        note("bitmovin-error", (e && (e.code + " " + e.name)) || "?");
        const name = String((e && e.name) || "").toLowerCase();
        if (name.indexOf("licens") >= 0 || (e && (e.code === 1016 || e.code === 1017))) {
          report("LICENSE_REFUSED", { code: e && e.code, name: e && e.name });
        } else {
          report("FAILED", { fatal: { code: e && e.code, name: e && e.name } });
        }
      });
      p.on(B.player.PlayerEvent.TimeChanged, () => {
        // The licence callout is ASYNC and playback starts before the
        // verdict arrives — measured: a garbage key still played 0.27s.
        // PLAYED therefore requires sustained playback PAST the licensing
        // round-trip; an early report is the suspicious-green shape.
        if (p.getCurrentTime() > 6) {
          note("bitmovin-time", p.getCurrentTime().toFixed(2));
          report("PLAYED", {
            player: "bitmovin",
            currentTime: p.getCurrentTime(),
            duration: p.getDuration(),
          });
        }
      });
      await p.load(kind === "HLS" ? { hls: url } : { dash: url });
      note("bitmovin-loaded");
      return;
    }
    if (kind === "HLS") {
      note("can-play-native-hls", JSON.stringify(video.canPlayType("application/vnd.apple.mpegurl")));
      if (!forceMse && video.canPlayType("application/vnd.apple.mpegurl")) {
        note("native-hls");
        video.src = url;
      } else {
        const Hls = window.Hls;
        if (!Hls || !Hls.isSupported()) { return report("NO_MSE"); }
        const hls = new Hls({ debug: false });
        hls.on(Hls.Events.ERROR, (_e, d) => {
          note("hls-error", d.type + "/" + d.details + (d.response ? " http=" + d.response.code : ""));
          if (d.fatal) {
            report("FAILED", { fatal: { type: d.type, details: d.details, http: d.response && d.response.code } });
          }
        });
        hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) => note("manifest-parsed", (d.levels || []).length + " level(s)"));
        hls.on(Hls.Events.FRAG_LOADED, (_e, d) => note("frag-loaded", d.frag && d.frag.relurl));
        hls.loadSource(url);
        hls.attachMedia(video);
      }
    } else {
      const dashjs = window.dashjs;
      if (!dashjs) { return report("NO_LIB"); }
      const p = dashjs.MediaPlayer().create();
      p.on("error", (e) => {
        note("dash-error", JSON.stringify(e.error && (e.error.code || e.error)));
        report("FAILED", { fatal: e.error });
      });
      p.on("manifestLoaded", () => note("manifest-loaded"));
      p.initialize(video, url, true);
    }
    video.play().catch((e) => note("play-rejected", String(e)));
  } catch (e) {
    report("FAILED", { thrown: String(e) });
  }
})();
setTimeout(() => report("TIMEOUT"), deadline);
</script>
`;
}

/**
 * Verification engines from this repo's own store — no CDN.
 *
 * The product preview uses Shaka for DASH. This output-compatibility probe
 * deliberately retains dash.js as an independent client, and therefore owns
 * its dependency in @bitovp/worker instead of borrowing apps/web's package.
 */
export async function playerBundlePath(
	kind: Args["kind"],
	player: Args["player"] = "native",
): Promise<string> {
	if (player === "bitmovin") {
		const path = join(
			REPO,
			"apps/web/node_modules/bitmovin-player/bitmovinplayer.js",
		);
		await stat(path);
		return path;
	}
	const candidates =
		kind === "HLS"
			? [
					join(REPO, "node_modules/hls.js/dist/hls.min.js"),
					join(REPO, "apps/web/node_modules/hls.js/dist/hls.min.js"),
				]
			: [
					join(
						REPO,
						"apps/worker/node_modules/dashjs/dist/modern/umd/dash.all.min.js",
					),
					join(REPO, "node_modules/dashjs/dist/modern/umd/dash.all.min.js"),
					join(
						REPO,
						"apps/web/node_modules/dashjs/dist/modern/umd/dash.all.min.js",
					),
				];
	for (const path of candidates) {
		try {
			await stat(path);
			return path;
		} catch {
			// keep looking
		}
	}
	throw new Error(
		`could not find the ${kind} player bundle; looked in:\n  ${candidates.join("\n  ")}`,
	);
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	const bundle = await playerBundlePath(args.kind, args.player);

	let settle: (value: unknown) => void = () => {};
	const verdict = new Promise<Record<string, unknown>>((res) => {
		settle = res as (value: unknown) => void;
	});

	const server = createServer((req, res) => {
		if (req.method === "POST" && req.url === "/result") {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c as Buffer));
			req.on("end", () => {
				res.writeHead(204).end();
				try {
					settle(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch (err) {
					settle({ verdict: "BAD_REPORT", error: String(err) });
				}
			});
			return;
		}
		if (req.url === "/lib/player.js") {
			res.writeHead(200, { "content-type": "text/javascript" });
			createReadStream(bundle).pipe(res);
			return;
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(harnessHtml(args));
	});
	await new Promise<void>((res) => server.listen(0, args.host, res));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const origin = `http://${args.host}:${port}`;

	const profile = await mkdtemp(join(tmpdir(), "playback-probe-"));
	const chrome = spawn(
		args.chrome,
		[
			...(args.keepOpen ? [] : ["--headless=new"]),
			// Autoplay of a MUTED element is allowed by default, but be explicit:
			// a probe that silently never started would report TIMEOUT and read as
			// a broken stream.
			"--autoplay-policy=no-user-gesture-required",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-extensions",
			`--user-data-dir=${profile}`,
			origin,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const chromeErr: string[] = [];
	chrome.stderr?.on("data", (d) => chromeErr.push(String(d)));

	const timeout = new Promise<Record<string, unknown>>((res) =>
		setTimeout(
			() => res({ verdict: "NO_REPORT", chromeStderr: chromeErr.join("") }),
			(args.seconds + 20) * 1000,
		),
	);
	const result = await Promise.race([verdict, timeout]);

	chrome.kill();
	server.close();
	await rm(profile, { recursive: true, force: true }).catch(() => {});

	console.log(JSON.stringify({ origin, ...result }, null, 2));
	return result.verdict === "PLAYED" ? 0 : 1;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	process.exit(await main());
}
