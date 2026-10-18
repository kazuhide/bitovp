import { describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../feeder/supervisor";
import {
	buildSignatureCommand,
	DEFAULT_EDGE_WEIGHT,
	extractSignature,
	parseSignalstats,
	statsToSignature,
} from "./signatures";

/**
 * Signature extraction runs ffmpeg `signalstats` through the injected runner —
 * CI has no ffmpeg, so the parser is exercised against canned metadata=print
 * output and the argv is asserted directly.
 */

/** Builds canned `metadata=print` stdout for the given per-frame YAVG/YDIF. */
function metadataOutput(frames: { yavg: number; ydif?: number }[]): string {
	const lines: string[] = [];
	frames.forEach((f, i) => {
		lines.push(
			`frame:${i}    pts:${i * 512}    pts_time:${(i / 30).toFixed(4)}`,
		);
		lines.push(`lavfi.signalstats.YAVG=${f.yavg}`);
		if (f.ydif !== undefined) {
			lines.push(`lavfi.signalstats.YDIF=${f.ydif}`);
		}
	});
	return `${lines.join("\n")}\n`;
}

describe("buildSignatureCommand", () => {
	it("emits a signalstats + metadata=print chain to stdout", () => {
		const argv = buildSignatureCommand("/tmp/clip.mp4");
		const vf = argv[argv.indexOf("-vf") + 1];
		expect(vf).toBe("signalstats,metadata=print:file=-");
		expect(argv).toContain("-i");
		expect(argv).toContain("/tmp/clip.mp4");
		expect(argv).toContain("-an");
		// No banner/progress on stdout so only metadata lines remain.
		expect(argv).toContain("-v");
		expect(argv[argv.indexOf("-v") + 1]).toBe("error");
	});

	it("prepends an fps conform node when fps is given", () => {
		const argv = buildSignatureCommand("/tmp/clip.mp4", { fps: 30 });
		const vf = argv[argv.indexOf("-vf") + 1];
		expect(vf).toBe("fps=30,signalstats,metadata=print:file=-");
	});
});

describe("parseSignalstats", () => {
	it("parses per-frame YAVG and YDIF in order", () => {
		const stdout = metadataOutput([
			{ yavg: 58.1, ydif: 0 },
			{ yavg: 60.2, ydif: 3.5 },
			{ yavg: 55.0, ydif: 7.1 },
		]);
		const frames = parseSignalstats(stdout);
		expect(frames).toEqual([
			{ yavg: 58.1, ydif: 0 },
			{ yavg: 60.2, ydif: 3.5 },
			{ yavg: 55.0, ydif: 7.1 },
		]);
	});

	it("ignores unrelated metadata keys and blank lines", () => {
		const stdout = [
			"frame:0    pts:0    pts_time:0",
			"lavfi.signalstats.YAVG=40",
			"lavfi.signalstats.YMIN=0",
			"lavfi.signalstats.YMAX=255",
			"",
			"frame:1    pts:512    pts_time:0.04",
			"lavfi.signalstats.YAVG=41",
			"",
		].join("\n");
		expect(parseSignalstats(stdout)).toEqual([{ yavg: 40 }, { yavg: 41 }]);
	});

	it("drops a trailing frame with no YAVG", () => {
		const stdout = [
			"frame:0    pts:0",
			"lavfi.signalstats.YAVG=40",
			"frame:1    pts:512",
		].join("\n");
		expect(parseSignalstats(stdout)).toEqual([{ yavg: 40 }]);
	});
});

describe("statsToSignature", () => {
	it("returns plain mean luma (YAVG) by default — encode-stable", () => {
		const sig = statsToSignature([
			{ yavg: 50, ydif: 0 },
			{ yavg: 50, ydif: 4 },
		]);
		// Default is luma alone (YDIF is the flat-luma fallback, off by default).
		expect(sig).toEqual([50, 50]);
	});

	it("blends YDIF when enrich is set (the flat-luma fallback)", () => {
		const sig = statsToSignature(
			[
				{ yavg: 50, ydif: 0 },
				{ yavg: 50, ydif: 4 },
			],
			{ enrich: true },
		);
		// YAVG + weight·YDIF — distinguishes two same-luma frames by motion.
		expect(sig[0]).toBe(50);
		expect(sig[1]).toBe(50 + DEFAULT_EDGE_WEIGHT * 4);
	});

	it("treats a missing YDIF as 0 under enrich (degrades to luma)", () => {
		expect(statsToSignature([{ yavg: 70 }], { enrich: true })).toEqual([70]);
	});
});

describe("extractSignature", () => {
	function runnerWith(
		stdout: string,
		code = 0,
		stderr = "",
	): { runner: ProcessRunner; argv: string[][] } {
		const argv: string[][] = [];
		const runner: ProcessRunner = {
			spawn: vi.fn(() => {
				throw new Error("spawn not used");
			}),
			run: vi.fn(async (_bin: string, a: string[]) => {
				argv.push(a);
				return { code, stdout, stderr };
			}),
		};
		return { runner, argv };
	}

	it("runs ffmpeg and returns the luma signature array by default", async () => {
		const { runner, argv } = runnerWith(
			metadataOutput([
				{ yavg: 10, ydif: 0 },
				{ yavg: 20, ydif: 5 },
			]),
		);
		const sig = await extractSignature({
			runner,
			ffmpegPath: "ffmpeg",
			path: "/tmp/clip.mp4",
			options: { fps: 30 },
		});
		// Default = luma alone (the encode-stable signal).
		expect(sig).toEqual([10, 20]);
		// fps conform reached the argv.
		expect(argv[0]?.[argv[0].indexOf("-vf") + 1]).toBe(
			"fps=30,signalstats,metadata=print:file=-",
		);
	});

	it("returns the enriched signature when enrich is requested", async () => {
		const { runner } = runnerWith(
			metadataOutput([
				{ yavg: 10, ydif: 0 },
				{ yavg: 20, ydif: 5 },
			]),
		);
		const sig = await extractSignature({
			runner,
			ffmpegPath: "ffmpeg",
			path: "/tmp/clip.mp4",
			options: { fps: 30, enrich: true },
		});
		expect(sig).toEqual([10, 20 + DEFAULT_EDGE_WEIGHT * 5]);
	});

	it("throws with the redacted stderr tail on a non-zero exit", async () => {
		const { runner } = runnerWith("", 1, "x\nffmpeg: decode failed\n");
		await expect(
			extractSignature({ runner, ffmpegPath: "ffmpeg", path: "/tmp/x.mp4" }),
		).rejects.toThrow(
			/signalstats extraction failed \(code 1\): ffmpeg: decode failed/,
		);
	});

	it("throws when zero frames decoded", async () => {
		const { runner } = runnerWith("");
		await expect(
			extractSignature({ runner, ffmpegPath: "ffmpeg", path: "/tmp/x.mp4" }),
		).rejects.toThrow(/produced no frames/);
	});
});

describe("buildSignatureCommand — frames limit", () => {
	/**
	 * The VOD alignment probe samples only the head: an offset is a lead-in
	 * property, and decoding a 3-hour reference twice more to find one frame
	 * would cost more than the libvmaf pass it corrects.
	 */
	it("limits the FILTERED frame count, not the input", () => {
		const argv = buildSignatureCommand("/tmp/a.mp4", { fps: 24, frames: 240 });
		const at = argv.indexOf("-frames:v");
		expect(at).toBeGreaterThan(argv.indexOf("-vf"));
		expect(argv[at + 1]).toBe("240");
		// After -vf matters: with an fps conform in the chain, limiting the input
		// would sample a different span on each side and the offset would be
		// measured between two different windows.
	});

	it("emits nothing when absent — the live aligner still reads whole clips", () => {
		expect(buildSignatureCommand("/tmp/a.mp4")).not.toContain("-frames:v");
		expect(buildSignatureCommand("/tmp/a.mp4", { fps: 24 })).not.toContain(
			"-frames:v",
		);
	});
});
