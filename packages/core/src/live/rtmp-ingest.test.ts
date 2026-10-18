import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	liveRtmpIngestParamsSchema,
	selectRtmpIngestPoints,
} from "./rtmp-ingest";
import { liveChannelPlanSchema } from "./schema";

const loadLiveFixture = (name: string) =>
	liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(__dirname, "__fixtures__", `${name}.plan.json`),
				"utf8",
			),
		),
	);

describe("declared RTMP ingest selection", () => {
	it("preserves the selected order and refuses absent points and duplicate indexes", () => {
		const plan = loadLiveFixture("live-redundant-rtmp");
		expect(selectRtmpIngestPoints(plan, { pointIndexes: [1, 0] })).toEqual(
			plan.liveInput.kind === "REDUNDANT_RTMP"
				? [...(plan.liveInput.ingestPoints ?? [])].reverse()
				: [],
		);
		expect(() => selectRtmpIngestPoints(plan, { pointIndexes: [15] })).toThrow(
			"Undeclared",
		);
		expect(
			liveRtmpIngestParamsSchema.safeParse({ pointIndexes: [0, 0] }).success,
		).toBe(false);
		expect(
			liveRtmpIngestParamsSchema.safeParse({
				pointIndexes: [0],
				streamKey: "secret",
			}).success,
		).toBe(false);
	});
	it("refuses simple RTMP and fixed-FQDN input plans", () => {
		expect(() =>
			selectRtmpIngestPoints(loadLiveFixture("live-rtmp-simple"), {
				pointIndexes: [0],
			}),
		).toThrow("declared dynamic");
		const plan = loadLiveFixture("live-redundant-rtmp");
		if (plan.liveInput.kind !== "REDUNDANT_RTMP") throw new Error("fixture");
		delete plan.liveInput.ingestPoints;
		plan.liveInput.staticIngestPoints = [{ name: "fixed" }];
		expect(() => selectRtmpIngestPoints(plan, { pointIndexes: [0] })).toThrow(
			"declared dynamic",
		);
	});
});
