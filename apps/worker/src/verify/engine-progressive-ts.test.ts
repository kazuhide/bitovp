import { readFileSync } from "node:fs";
import { compileExpectedArtefacts, encodingPlanSchema } from "@bitovp/core";
import { expect, it, vi } from "vitest";
import { type EngineDeps, verifyArtefacts } from "./engine";

it.each([
	["timeline.ts", "PASS"],
	["unrelated-timeline.ts", "FAIL"],
	["nested/timeline.ts", "FAIL"],
] as const)("verifies the exact progressive TS filename (%s)", async (filename, verdict) => {
	const raw = JSON.parse(
		readFileSync(
			new URL(
				"../../../../packages/core/src/plan/__fixtures__/mp4-muxed-av-progressive.plan.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	raw.muxings[0] = {
		...raw.muxings[0],
		kind: "PROGRESSIVE_TS",
		filename: "timeline.ts",
	};
	const expected = compileExpectedArtefacts(encodingPlanSchema.parse(raw));
	const prefix = expected.muxings[0]?.dir.prefix ?? "";
	const fetchConcatenated = vi.fn(async (_output: string, keys: string[]) => {
		expect(keys).toHaveLength(1);
		return keys[0] ?? "";
	});
	const unexpected = async (): Promise<never> => {
		throw new Error("segmented/manifest operation on a progressive TS file");
	};
	const deps: EngineDeps = {
		listAll: async () => [{ key: `${prefix}${filename}`, size: 1024 }],
		fetchObject: unexpected,
		fetchConcatenated,
		probe: async () => ({
			width: 1920,
			height: 1080,
			videoCodec: "h264",
			profile: "high",
			fps: 25,
			durationSec: 12,
			bitrateBps: 5000000,
			audioCodec: "aac",
			audioChannels: 2,
			audioSampleRate: 48000,
			audioBitrateBps: 192000,
		}),
		scanBoxes: unexpected,
		readText: unexpected,
		parseHls: unexpected,
		parseDash: unexpected,
	};
	const report = await verifyArtefacts(expected, deps);
	expect(report.checks).toContainEqual(
		expect.objectContaining({ id: "muxing:file:file", verdict }),
	);
	if (verdict === "PASS") {
		expect(report.checks).toContainEqual(
			expect.objectContaining({
				id: "rendition:v1080:audio-present",
				verdict: "PASS",
			}),
		);
		expect(fetchConcatenated).toHaveBeenCalledWith("origin", [
			`${prefix}timeline.ts`,
		]);
	} else {
		expect(fetchConcatenated).not.toHaveBeenCalled();
	}
});
