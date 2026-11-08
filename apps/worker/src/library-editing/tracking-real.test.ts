import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { trackGrayFrames } from "./tracking";

async function footage() {
	const packed = await readFile(
		new URL("./fixtures/caminandes2-head-30-34.gray.gz", import.meta.url),
	);
	expect(createHash("sha256").update(packed).digest("hex")).toBe(
		"264addd35bc92ad8ce7f9fcb113549b8dbb7cf6f32c9ca8c2e0a0ea42adc02c1",
	);
	const bytes = gunzipSync(packed);
	expect(bytes.length).toBe(12 * 320 * 180);
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(
		"82e46d0d4aeb84c4da18ca50b712aeaba67b58354c89f5c73f1adb4244f23d1b",
	);
	return Array.from({ length: 12 }, (_, index) =>
		bytes.subarray(index * 320 * 180, (index + 1) * 320 * 180),
	);
}
const input = {
	width: 320,
	height: 180,
	seedBox: { x: 0.32, y: 0.18, w: 0.12, h: 0.25 },
	sourceStartUs: 30_000_000,
	sampleStepUs: 333_333,
	sampleTimesUs: Array.from(
		{ length: 12 },
		(_, index) =>
			30_000_000 + Number((BigInt(index * 10) * 1_000_000n + 29n) / 30n),
	),
};
it("measures location and changing scale in real animation then stops before rapid loss and a cut", async () => {
	const result = await trackGrayFrames({ ...input, frames: await footage() });
	expect(result.observations).toHaveLength(9);
	expect(result.observations[8]?.sourceTimeUs).toBe(32_666_667);
	expect(result.lostAtUs).toBe(33_000_000);
	expect(result.reason).toBe("LOST");
	expect(result.observations.every((point) => point.confidence >= 0.78)).toBe(
		true,
	);
	const widths = result.observations.map((point) => point.box.w),
		centers = result.observations.map((point) => point.box.x + point.box.w / 2);
	expect(Math.max(...centers) - Math.min(...centers)).toBeGreaterThan(0.01);
	expect(Math.min(...widths)).toBeLessThan(0.11);
	expect(result.observations[8]?.box.w).toBeGreaterThan(
		Math.min(...widths) + 0.01,
	);
	expect(result.operations).toBeLessThanOrEqual(300_000_000);
});
it("does not drift to the background when an actual-footage subject region is deliberately occluded", async () => {
	const frames = await footage();
	// Controlled occlusion is explicit test data, not a claim about the original film.
	const occluded = Uint8Array.from(frames[6] ?? []);
	for (let y = 0; y < 120; y++) occluded.fill(40, y * 320 + 65, y * 320 + 190);
	const result = await trackGrayFrames({
		...input,
		frames: [...frames.slice(0, 6), occluded, ...frames.slice(7)],
	});
	expect(result.observations.length).toBeGreaterThanOrEqual(2);
	expect(result.observations.length).toBeLessThanOrEqual(6);
	expect(result.lostAtUs).toBe(32_000_000);
	expect(["LOST", "AMBIGUOUS"]).toContain(result.reason);
	expect(
		result.observations.every((point) => point.sourceTimeUs < 32_000_000),
	).toBe(true);
});
