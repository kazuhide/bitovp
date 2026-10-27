import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileExpectedLiveArtefacts,
	liveChannelPlanSchema,
} from "@bitovp/core";
import { expect, it, vi } from "vitest";
import { sampleLiveStorageObjects } from "./live-storage-sample";

it("retains output provenance for identical keys and deduplicates repeated listing routes", async () => {
	const p = liveChannelPlanSchema.parse(
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
	const e = compileExpectedLiveArtefacts(p);
	const first = e.muxings[0];
	if (!first) throw new Error("Missing route");
	e.muxings = [
		first,
		{ ...first, outputKey: "encrypted", drmKey: "enc", drmKind: "FAIRPLAY" },
	];
	e.manifests = e.manifests.map((m) => ({
		...m,
		muxingKeys: [first.muxingKey],
		outputKey: "encrypted",
		drmKind: "FAIRPLAY",
	}));
	const listAll = vi.fn(async (outputKey: string, prefix: string) =>
		outputKey === "origin"
			? [{ key: `${prefix}segment_1.m4s`, size: 1000, outputKey: "encrypted" }]
			: [],
	);
	const objects = await sampleLiveStorageObjects(e, listAll);
	expect(listAll).toHaveBeenCalledTimes(2);
	expect(objects).toEqual([
		{
			outputKey: "origin",
			key: `${first.dir.prefix}segment_1.m4s`,
			size: 1000,
		},
	]);
});

function oneRoute() {
	const p = liveChannelPlanSchema.parse(
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
	const expected = compileExpectedLiveArtefacts(p);
	const first = expected.muxings[0];
	if (!first) throw new Error("Missing muxing fixture");
	expected.muxings = [first];
	expected.manifests = [];
	return { expected, first, key: `${first.dir.prefix}segment_1.m4s` };
}

it("keeps identical object keys in different outputs and overrides untrusted output tags", async () => {
	const { expected, first, key } = oneRoute();
	expected.muxings.push({ ...first, outputKey: "other" });
	const objects = await sampleLiveStorageObjects(expected, async () => [
		{ key, size: 1000, outputKey: "spoofed" },
		{ key, size: 1000, outputKey: "spoofed" },
	]);
	expect(objects).toEqual([
		{ outputKey: "origin", key, size: 1000 },
		{ outputKey: "other", key, size: 1000 },
	]);
});

it.each([
	[[undefined, 700], 700],
	[[700, undefined], 700],
	[[undefined, undefined], undefined],
	[[700, 700], 700],
	[[0, 0], 0],
] as const)("merges compatible size observations %j", async (sizes, size) => {
	const { expected, key } = oneRoute();
	const objects = await sampleLiveStorageObjects(expected, async () =>
		sizes.map((value) => ({ key, size: value })),
	);
	expect(objects.map((o) => [o.outputKey, o.key, o.size])).toEqual([
		["origin", key, size],
	]);
});

it.each([
	[700, 800],
	[0, 700],
	[700, 0],
	[700, 800, 700],
	[-1],
	[Number.NaN],
	[Number.POSITIVE_INFINITY],
	[0.5],
])("drops contradictory or invalid known byte sizes %j", async (...sizes) => {
	const { expected, key } = oneRoute();
	const objects = await sampleLiveStorageObjects(expected, async () =>
		sizes.map((size) => ({ key, size })),
	);
	expect(objects).toEqual([]);
});

it("merges unknown modification times but drops contradictory known times", async () => {
	const { expected, key } = oneRoute();
	const first = { key, size: 700 };
	const modified = { ...first, lastModified: "2026-10-27T00:00:00.000Z" };
	const merged = await sampleLiveStorageObjects(expected, async () => [
		first,
		modified,
	]);
	expect(merged).toEqual([{ ...modified, outputKey: "origin" }]);
	const conflict = await sampleLiveStorageObjects(expected, async () => [
		modified,
		{ ...modified, lastModified: "2026-10-27T00:00:01.000Z" },
		modified,
	]);
	expect(conflict).toEqual([]);
});
