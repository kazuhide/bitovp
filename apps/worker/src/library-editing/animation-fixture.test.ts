import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	librarySourceSnapshotSchema,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import { afterEach, describe, expect, it } from "vitest";
import {
	ANIMATION_CONTENT_ID,
	ANIMATION_SOURCE_ID,
	animationAnalysis,
	animationDemo,
	animationInputArgument,
	animationMediaArguments,
	animationSourceSnapshot,
	copyVerifiedAnimationSource,
} from "./animation-fixture";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
const digest = (bytes: string) =>
	createHash("sha256").update(bytes).digest("hex");

describe("animation demo identity and annotation", () => {
	it("pins the official bytes, excerpt and distinct additive sample identity", () => {
		expect(animationDemo.source).toMatchObject({
			url: "https://video.blender.org/download/web-videos/fb70d459-48d2-4db5-adba-813c84f9200a-1080.mp4",
			bytes: 47_376_339,
			sha256:
				"7c0f22495d7e6d33576068af668aa887e4dfbe38690c8f6b75ae953c9df80aea",
		});
		expect(animationDemo.excerpt).toEqual({
			sourceStartSeconds: 9,
			durationSeconds: 30,
		});
		expect(ANIMATION_CONTENT_ID).toBe("72b30340-2426-439e-8029-3e5dc764ee01");
		expect(ANIMATION_SOURCE_ID).toBe("72b30340-2426-439e-8029-3e5dc764ee02");
		expect(animationDemo.credit.license).toBe("CC BY 3.0");
		expect(animationDemo.credit.changes).not.toHaveLength(0);
		expect(animationDemo.credit.colorAssumption).toContain("未記載");
	});
	it("covers the six real normalized shots without inventing pan cuts or AISA inference", () => {
		const raw = animationAnalysis();
		const normalized = normalizeSceneAnalysis(raw);
		expect(raw.metadata.generatedByAisa).toBe(false);
		expect(raw.metadata.provenance).toBe("MANUALLY_ANNOTATED_DEMO");
		expect(raw.metadata.sourceStartSeconds).toBe(9);
		expect(normalized.duration).toBe(30);
		const shots = normalized.scenes.flatMap((scene) => scene.shots);
		expect(shots.map((shot) => Math.round(shot.startInSeconds * 30))).toEqual([
			0, 164, 281, 569, 741, 831,
		]);
		expect(shots.map((shot) => Math.round(shot.endInSeconds * 30))).toEqual([
			164, 281, 569, 741, 831, 900,
		]);
		for (const subject of shots.flatMap((shot) => shot.mainSubjects)) {
			const box = subject.box2d;
			expect(box).toHaveLength(4);
			if (!box) throw new Error("fixture");
			expect(subject.centerX).toBe((box[1] + box[3]) / 20);
			expect(subject.centerY).toBe((box[0] + box[2]) / 20);
		}
		expect(JSON.stringify(raw)).not.toMatch(/trackingId|speakerId|transcript/);
	});
	it("retains authenticated playback, an independent object key and unverified analysis identity", () => {
		const snapshot = librarySourceSnapshotSchema.parse(
			animationSourceSnapshot("a04e1514-6285-4ea5-9cdc-79dd110f650a"),
		);
		expect(snapshot.identity).toBe("UNVERIFIED");
		expect(snapshot.fileOutputs?.[0]?.path).toBe(
			"fixtures/caminandes2/v1/source.mp4",
		);
		expect(snapshot.playbackLinks[0]).toMatchObject({
			via: "AUTHENTICATED",
			url: null,
		});
		expect(snapshot.name).toContain("Caminandes");
	});
});

describe("animation input and normalization", () => {
	it("uses the synthetic default unless the exact opt-in and read-only mount path are supplied", () => {
		expect(animationInputArgument([])).toBeNull();
		expect(
			animationInputArgument(["--animation", "/fixtures/caminandes2.mp4"]),
		).toBe("/fixtures/caminandes2.mp4");
	});
	it.each([
		["--animation"],
		["--animation", "https://outside.example/movie.mp4"],
		["--animation", "/app/.env"],
		["--animation", "../caminandes2.mp4"],
		["--animation", "/fixtures/caminandes2.mp4", "--force"],
		["--unknown"],
	])("rejects unsupported input arguments: %j", (...args) => {
		expect(() => animationInputArgument(args)).toThrow(
			"PREVIEW_ANIMATION_ARGUMENTS_INVALID",
		);
	});
	it("normalizes an owned input with the agreed CFR30/BT709/AAC48 profile", () => {
		const args = animationMediaArguments(
			"/tmp/owned input.mp4",
			"/tmp/owned output.mp4",
		);
		expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 6)).toEqual([
			"-ss",
			"9",
			"-i",
			"/tmp/owned input.mp4",
			"-t",
			"30",
		]);
		expect(args[args.indexOf("-vf") + 1]).toBe(
			"fps=30:start_time=0,scale=1280:720:flags=lanczos:in_color_matrix=bt709:out_color_matrix=bt709,setsar=1",
		);
		expect(args[args.indexOf("-ar") + 1]).toBe("48000");
		expect(args[args.indexOf("-x264-params") + 1]).toBe(
			"colorprim=bt709:transfer=bt709:colormatrix=bt709",
		);
		expect(args.at(-1)).toBe("/tmp/owned output.mp4");
	});
	it("snapshots and hashes exactly the bytes that will be decoded, and rejects replacements", async () => {
		const directory = await mkdtemp(join(tmpdir(), "animation-fixture-"));
		directories.push(directory);
		const input = join(directory, "input.mp4");
		const output = join(directory, "owned.mp4");
		await writeFile(input, "valid bytes");
		await copyVerifiedAnimationSource(input, output, {
			bytes: 11,
			sha256: digest("valid bytes"),
		});
		await writeFile(input, "replacement");
		expect(await readFile(output, "utf8")).toBe("valid bytes");
		await expect(
			copyVerifiedAnimationSource(input, join(directory, "bad.mp4"), {
				bytes: 11,
				sha256: digest("valid bytes"),
			}),
		).rejects.toThrow("PREVIEW_ANIMATION_SOURCE_INVALID");
		await expect(readFile(join(directory, "bad.mp4"))).rejects.toThrow();
	});
	it("refuses the wrong official input size and preserves an existing destination", async () => {
		const directory = await mkdtemp(join(tmpdir(), "animation-fixture-"));
		directories.push(directory);
		const input = join(directory, "input.mp4");
		const output = join(directory, "owned.mp4");
		await writeFile(input, "short");
		await writeFile(output, "preserve");
		await expect(copyVerifiedAnimationSource(input, output)).rejects.toThrow(
			"PREVIEW_ANIMATION_SOURCE_INVALID",
		);
		expect(await readFile(output, "utf8")).toBe("preserve");
	});
	it("does not remove another file when the verified copy destination already exists", async () => {
		const directory = await mkdtemp(join(tmpdir(), "animation-fixture-"));
		directories.push(directory);
		const input = join(directory, "input.mp4");
		const output = join(directory, "owned.mp4");
		await writeFile(input, "valid bytes");
		await writeFile(output, "preserve");
		await expect(
			copyVerifiedAnimationSource(input, output, {
				bytes: 11,
				sha256: digest("valid bytes"),
			}),
		).rejects.toThrow("PREVIEW_ANIMATION_SOURCE_INVALID");
		expect(await readFile(output, "utf8")).toBe("preserve");
	});
});
