import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { trackShotSubjects } from "./tracking";

const execute = vi.hoisted(() => vi.fn());
vi.mock("./process", async (original) => ({
	...(await original<object>()),
	runMediaProcess: execute,
}));
const directories: string[] = [];
afterEach(async () => {
	execute.mockReset();
	await Promise.all(
		directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
	);
});
function frame(x: number) {
	const data = Buffer.alloc(80 * 60, 45);
	let random = 7;
	for (let y = 20; y < 32; y++)
		for (let dx = 0; dx < 16; dx++) {
			random = (random * 1664525 + 1013904223) >>> 0;
			data[y * 80 + x + dx] = random >>> 24;
		}
	return data;
}
async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "bitovp-tracking-test-"));
	directories.push(directory);
	const sourcePath = join(directory, "source.mp4");
	await writeFile(sourcePath, "owned video");
	let scratch = "";
	execute.mockImplementation(async (_binary: string, args: string[]) => {
		scratch = args.at(-1) ?? "";
		await writeFile(scratch, Buffer.concat([frame(20), frame(23), frame(26)]));
		return { stdout: "", stderr: "" };
	});
	return {
		input: {
			sourcePath,
			mediaSha256: createHash("sha256").update("owned video").digest("hex"),
			sourceWidth: 80,
			sourceHeight: 60,
			shots: [
				{
					sceneId: "scene",
					shotIndex: 0,
					startUs: 0,
					endUs: 2_000_000,
					seed: {
						sourceTimeUs: 1_000_000,
						box: { x: 0.25, y: 1 / 3, w: 0.2, h: 0.2 },
					},
				},
			],
		},
		scratch: () => scratch,
	};
}
it("uses the actual appearance-time seed and explicitly FITs the preceding interval", async () => {
	const f = await setup();
	const result = await trackShotSubjects(f.input);
	const first = result.observations[0];
	expect(first?.sourceTimeUs).toBe(1_000_000);
	expect(result.observations).toHaveLength(3);
	expect(result.fallbacks).toEqual([
		{
			sceneId: "scene",
			shotIndex: 0,
			fromUs: 0,
			toUs: 1_000_000,
			reason: "BEFORE_SEED",
		},
	]);
	expect(execute.mock.calls[0]?.[1]).toEqual(
		expect.arrayContaining([
			"-ss",
			"1.000000000",
			"-protocol_whitelist",
			"file,pipe",
			"-frames:v",
			"3",
		]),
	);
	await expect(readFile(f.scratch())).rejects.toThrow();
});
it("adds one bounded six-fps measurement pass for fast motion while retaining the three-fps baseline clock", async () => {
	const f = await setup();
	execute.mockImplementation(async (_binary: string, args: string[]) => {
		const dense = String(args[args.indexOf("-vf") + 1]).includes("n\\,5");
		await writeFile(
			args.at(-1) ?? "",
			Buffer.concat(
				(dense ? [20, 26, 32, 38, 44, 50] : [20, 32, 44]).map(frame),
			),
		);
		return { stdout: "", stderr: "" };
	});
	const result = await trackShotSubjects({
		...f.input,
		adaptiveRecovery: true,
	});
	expect(execute).toHaveBeenCalledTimes(2);
	expect(result.sampleFps).toBe(3);
	expect(result.observations.map((point) => point.sourceTimeUs)).toEqual([
		1_000_000, 1_333_334, 1_666_667,
	]);
	expect(
		result.recoveryMeasurements?.map((point) => point.sourceTimeUs),
	).toEqual([1_166_667, 1_500_000, 1_833_334]);
});
it("makes no frame process or guessed track when the shot has no seed", async () => {
	const f = await setup();
	const first = f.input.shots[0];
	if (!first) throw new Error("Missing shot fixture");
	const { seed: _seed, ...shot } = first;
	const result = await trackShotSubjects({ ...f.input, shots: [shot] });
	expect(result.observations).toEqual([]);
	expect(result.fallbacks[0]?.reason).toBe("NO_SEED");
	expect(execute).not.toHaveBeenCalled();
});
it("enforces the total selected-shot budget before process or filesystem work", async () => {
	const f = await setup();
	await expect(
		trackShotSubjects({
			...f.input,
			shots: f.input.shots.map((shot) => ({ ...shot, endUs: 180_000_001 })),
		}),
	).rejects.toBeInstanceOf(RangeError);
	expect(execute).not.toHaveBeenCalled();
});
it("refuses source changes instead of reusing a matching declared cache key", async () => {
	const f = await setup();
	await writeFile(f.input.sourcePath, "replacement");
	await expect(trackShotSubjects(f.input)).rejects.toMatchObject({
		code: "SOURCE_CHANGED",
	});
	expect(execute).not.toHaveBeenCalled();
});
it("does not admit an AISA observation from outside its owning shot", async () => {
	const f = await setup();
	const shot = f.input.shots[0];
	if (!shot) throw new Error("Missing shot fixture");
	await expect(
		trackShotSubjects({ ...f.input, shots: [{ ...shot, startUs: 1_500_000 }] }),
	).rejects.toBeInstanceOf(RangeError);
	expect(execute).not.toHaveBeenCalled();
});
