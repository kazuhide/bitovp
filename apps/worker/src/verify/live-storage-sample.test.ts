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
