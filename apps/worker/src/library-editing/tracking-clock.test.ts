import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSceneAnalysis } from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	trackingCacheKey,
	trackingShotFromAnalysis,
	trackShotSubjects,
} from "./tracking";

const execute = vi.hoisted(() => vi.fn());
vi.mock("./process", async (original) => ({
	...(await original<object>()),
	runMediaProcess: execute,
}));
const directories: string[] = [];
afterEach(async () => {
	execute.mockReset();
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
const canonicalUs = (frame: number) =>
	Number((BigInt(frame) * 1_000_000n + 29n) / 30n);
function subjectShot(start: number, end: number, appearance = 0) {
	const shot = normalizeSceneAnalysis({
		metadata: { version: "tracking-clock-regression" },
		duration: 30,
		scenes: [
			{
				id: "00000000-0000-4000-8000-000000000001",
				type: "MAIN_CONTENT",
				startInSeconds: start,
				endInSeconds: end,
				shots: [
					{
						startInSeconds: start,
						endInSeconds: end,
						mainSubjects: [
							{
								classification: "person",
								description: "measured provider seed",
								appearanceTimeInSeconds: appearance,
								centerX: 35,
								centerY: 40,
								box2d: [333, 250, 533, 450],
							},
						],
					},
				],
			},
		],
	}).scenes[0]?.shots[0];
	if (!shot) throw new Error("Missing shot fixture");
	return shot;
}
describe("raw provider seconds become one explicit prepared-frame window", () => {
	it.each([
		1, 2, 164,
	])("retains exact frame %i before integer-microsecond quantization", (frame) => {
		const shot = trackingShotFromAnalysis({
			sceneId: "scene",
			shotIndex: 0,
			shot: subjectShot(frame / 30, (frame + 31) / 30),
			sourceStartUs: 0,
		});
		expect(shot).toMatchObject({
			startFrame: frame,
			endFrame: frame + 31,
			startUs: canonicalUs(frame),
			endUs: canonicalUs(frame + 31),
			seed: { sourceFrame: frame, sourceTimeUs: canonicalUs(frame) },
		});
	});
	it("keeps a genuinely between-frame appearance on the next frame", () => {
		const shot = trackingShotFromAnalysis({
			sceneId: "scene",
			shotIndex: 0,
			sourceStartUs: 0,
			shot: subjectShot(1 / 30, 2, 0.000001),
		});
		expect(shot?.seed).toMatchObject({ sourceFrame: 2, sourceTimeUs: 66_667 });
	});
	it("subtracts a nonzero original-time origin once, without rounding raw seconds", () => {
		const origin = 1_234_567;
		const shot = trackingShotFromAnalysis({
			sceneId: "scene",
			shotIndex: 0,
			sourceStartUs: origin,
			shot: subjectShot(
				origin / 1_000_000 + 164 / 30,
				origin / 1_000_000 + 195 / 30,
			),
		});
		expect(shot).toMatchObject({
			startFrame: 164,
			endFrame: 195,
			seed: { sourceFrame: 164, sourceTimeUs: 5_466_667 },
		});
	});
	it("uses conservative CFR30 boundaries for original 24fps shot times", () => {
		const shot = trackingShotFromAnalysis({
			sceneId: "scene",
			shotIndex: 0,
			sourceStartUs: 0,
			shot: subjectShot(1 / 24, 49 / 24),
		});
		expect(shot).toMatchObject({
			startFrame: 2,
			endFrame: 61,
			seed: { sourceFrame: 2 },
		});
	});
	it("retains the compiled 31-frame generation window's exclusive end", () => {
		const shot = trackingShotFromAnalysis({
			sceneId: "scene",
			shotIndex: 0,
			sourceStartUs: 0,
			shot: subjectShot(0, 31 / 30),
			frameWindow: { startFrame: 0, endFrame: 31 },
		});
		expect(shot).toMatchObject({
			startFrame: 0,
			endFrame: 31,
			endUs: 1_033_334,
		});
	});
});
function grayFrame() {
	const bytes = Buffer.alloc(80 * 60, 45);
	let random = 7;
	for (let y = 20; y < 32; y++)
		for (let x = 20; x < 36; x++) {
			random = (random * 1664525 + 1013904223) >>> 0;
			bytes[y * 80 + x] = random >>> 24;
		}
	return bytes;
}
async function inputFor(startFrame: number, endFrame: number) {
	const directory = await mkdtemp(join(tmpdir(), "bitovp-track-clock-"));
	directories.push(directory);
	const sourcePath = join(directory, "source.mp4");
	await writeFile(sourcePath, "fixed unit decode boundary");
	execute.mockImplementation(async (_binary: string, args: string[]) => {
		const count = Number(args[args.indexOf("-frames:v") + 1]);
		await writeFile(
			args.at(-1) ?? "",
			Buffer.concat(Array.from({ length: count }, grayFrame)),
		);
		return { stdout: "", stderr: "" };
	});
	return {
		sourcePath,
		mediaSha256: createHash("sha256")
			.update("fixed unit decode boundary")
			.digest("hex"),
		sourceWidth: 80,
		sourceHeight: 60,
		shots: [
			{
				sceneId: "scene",
				shotIndex: 0,
				startFrame,
				endFrame,
				startUs: canonicalUs(startFrame),
				endUs: canonicalUs(endFrame),
				seed: {
					sourceFrame: startFrame,
					sourceTimeUs: canonicalUs(startFrame),
					box: { x: 0.25, y: 1 / 3, w: 0.2, h: 0.2 },
				},
			},
		],
	};
}
describe("tracker does not re-round explicit CFR indices", () => {
	it.each([
		1, 2, 164,
	])("decodes and labels the requested seed frame %i", async (frame) => {
		const input = await inputFor(frame, frame + 31);
		const result = await trackShotSubjects(input);
		expect(result.observations.map((point) => point.sourceTimeUs)).toEqual(
			[frame, frame + 10, frame + 20, frame + 30].map(canonicalUs),
		);
		expect(result.fallbacks).toEqual([]);
		expect(execute.mock.calls[0]?.[1]).toEqual(
			expect.arrayContaining([
				"-ss",
				(frame / 30).toFixed(9),
				"-frames:v",
				"4",
			]),
		);
	});
	it("includes frame30 in a [0,31) window", async () => {
		const result = await trackShotSubjects(await inputFor(0, 31));
		expect(result.observations.map((point) => point.sourceTimeUs)).toEqual([
			0, 333_334, 666_667, 1_000_000,
		]);
	});
	it("keeps strict CEIL semantics for a direct noncanonical integer-us appearance", async () => {
		const input = await inputFor(0, 31);
		const first = input.shots[0];
		if (!first) throw new Error("Missing fixture");
		const { sourceFrame: _sourceFrame, ...seed } = first.seed;
		const result = await trackShotSubjects({
			...input,
			shots: [{ ...first, seed: { ...seed, sourceTimeUs: 33_334 } }],
		});
		expect(result.observations[0]?.sourceTimeUs).toBe(66_667);
	});
	it.each([
		"missing-start",
		"wrong-start-us",
		"wrong-end-us",
		"fractional-end",
		"wrong-seed-us",
		"seed-outside",
	])("rejects contradictory explicit clock metadata (%s) before decoding", async (change) => {
		const input = await inputFor(1, 32);
		const shot = input.shots[0];
		if (!shot) throw new Error("Missing fixture");
		if (change === "missing-start") Reflect.deleteProperty(shot, "startFrame");
		if (change === "wrong-start-us") shot.startUs--;
		if (change === "wrong-end-us") shot.endUs--;
		if (change === "fractional-end") shot.endFrame = 32.5;
		if (change === "wrong-seed-us") shot.seed.sourceTimeUs++;
		if (change === "seed-outside") {
			shot.seed.sourceFrame = 33;
			shot.seed.sourceTimeUs = canonicalUs(33);
		}
		await expect(trackShotSubjects(input)).rejects.toBeInstanceOf(RangeError);
		expect(execute).not.toHaveBeenCalled();
	});
	it("separates explicit canonical seed identity from legacy integer-us interpretation", async () => {
		const input = await inputFor(1, 32),
			shot = input.shots[0];
		if (!shot) throw new Error("Missing fixture");
		const { sourceFrame: _sourceFrame, ...seed } = shot.seed;
		expect(trackingCacheKey(input)).not.toBe(
			trackingCacheKey({ ...input, shots: [{ ...shot, seed }] }),
		);
	});
});
