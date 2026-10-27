import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
	compileExpectedLiveArtefacts,
	liveChannelPlanSchema,
	validateLiveChannel,
} from "@bitovp/core";
import { expect, it } from "vitest";
import { liveStorageObjects } from "./live-storage-objects";

function fixture() {
	return liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
				),
				"utf8",
			),
		),
	);
}
function muxing() {
	const value = compileExpectedLiveArtefacts(fixture()).muxings[0];
	if (!value) throw new Error("Missing muxing fixture");
	return value;
}

it("bounds runtime membership for adjacent numeric tokens without blocking the sampler", () => {
	const writer = muxing();
	writer.segmentNaming = `${"%number%".repeat(24)}.ts`;
	const objects = [
		{
			outputKey: writer.outputKey,
			key: `${writer.dir.prefix}${"1".repeat(48)}.m3u8`,
		},
	];
	const script = `import { liveStorageObjects } from ${JSON.stringify(new URL("./live-storage-objects.ts", import.meta.url).href)}; process.stdout.write(JSON.stringify(liveStorageObjects(JSON.parse(process.argv[2]), JSON.parse(process.argv[1]))));`;
	const result = execFileSync(
		process.execPath,
		[
			"--import",
			createRequire(import.meta.url).resolve("tsx"),
			"--input-type=module",
			"--eval",
			script,
			JSON.stringify(writer),
			JSON.stringify(objects),
		],
		{ encoding: "utf8", timeout: 3000 },
	);
	expect(JSON.parse(result)).toEqual({ init: [], media: [] });
}, 5000);

it("retains literal and template provenance and provider policy tokens", () => {
	const writer = muxing();
	writer.dir.prefix = "literal/%number%/";
	writer.segmentNaming = "media/seg-{rand_chars:8}-%number%-%provider%.m4s";
	writer.initSegment = "headers/init_%number%.mp4";
	const keys = [
		"headers/init_%number%.mp4",
		"media/seg-{rand_chars:8}-1-custom.m4s",
		"media/seg-Ab12Cd34-1-custom.m4s",
		"foreign/headers/init_%number%.mp4",
	];
	const objects = keys.map((key) => ({
		outputKey: writer.outputKey,
		key: `${writer.dir.prefix}${key}`,
	}));
	expect(liveStorageObjects(objects, writer)).toEqual({
		init: [objects[0]],
		media: [objects[1]],
	});
	writer.segmentNamingIsTemplate = true;
	writer.initSegment = undefined;
	writer.initSegmentNameTemplate = "headers/init-{rand_chars:8}.mp4";
	const init = {
		outputKey: writer.outputKey,
		key: `${writer.dir.prefix}headers/init-Ab12Cd34.mp4`,
	};
	expect(liveStorageObjects([...objects, init], writer)).toEqual({
		init: [init],
		media: [objects[2]],
	});
});

it("does not promote exhausted init or segment membership into evidence", () => {
	const writer = muxing();
	writer.initSegment = undefined;
	writer.segmentNaming = `${"%number%".repeat(300)}.ts`;
	expect(
		liveStorageObjects(
			[
				{
					outputKey: writer.outputKey,
					key: `${writer.dir.prefix}${"1".repeat(700)}.ts`,
				},
			],
			writer,
		),
	).toEqual({ init: [], media: [] });
	writer.segmentNaming = "%provider%";
	writer.initSegmentNameTemplate = "init-{rand_chars:2049}.mp4";
	expect(
		liveStorageObjects(
			[
				{
					outputKey: writer.outputKey,
					key: `${writer.dir.prefix}init-${"A".repeat(2049)}.mp4`,
				},
			],
			writer,
		),
	).toEqual({ init: [], media: [] });
});

it.each([
	"FMP4",
	"CMAF",
] as const)("matches admitted %s init writers by their declared field provenance", (kind) => {
	const plan = fixture();
	const source = plan.muxings[0];
	const audio = plan.muxings[3];
	if (source?.kind !== "FMP4" || audio?.kind !== "FMP4" || !source.destination)
		throw new Error("Missing fMP4 muxing fixtures");
	const destination = { ...source.destination };
	plan.muxings = [source, audio].map((m, i) => ({
		...m,
		kind,
		destination,
		segmentNaming: `writer_${i}_%number%.m4s`,
		initSegmentName:
			i === 0 ? "headers/init_%number%.mp4" : "headers/init_1.mp4",
		...(i === 0 && kind === "CMAF"
			? { initSegmentNameTemplate: "headers/init_{rand_chars:8}_%number%.mp4" }
			: {}),
	}));
	if (kind === "CMAF")
		plan.liveManifests = plan.liveManifests.filter((m) => m.kind === "DASH");
	expect(validateLiveChannel(plan).filter((i) => i.level === "error")).toEqual(
		[],
	);
	const writers = compileExpectedLiveArtefacts(plan).muxings;
	expect(writers).toHaveLength(2);
	const first = writers[0];
	const second = writers[1];
	if (!first || !second) throw new Error("Missing compiled writers");
	const names = [
		kind === "CMAF"
			? "headers/init_Ab12Cd34_%number%.mp4"
			: "headers/init_%number%.mp4",
		"headers/init_1.mp4",
		"writer_0_1.m4s",
		"writer_1_1.m4s",
	];
	const objects = names.map((name) => ({
		outputKey: first.outputKey,
		key: `${first.dir.prefix}${name}`,
	}));
	expect(liveStorageObjects(objects, first)).toEqual({
		init: [objects[0]],
		media: [objects[2]],
	});
	expect(liveStorageObjects(objects, second)).toEqual({
		init: [objects[1]],
		media: [objects[3]],
	});
});
