import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { liveChannelPlanSchema } from "../live/schema";
import { encodingPlanSchema } from "../plan/schema";
import { compileExpectedArtefacts } from "./expected";
import { compileExpectedLiveArtefacts } from "./expected-live";

describe.each([
	"FMP4",
	"TS",
	"CMAF",
] as const)("%s expected media naming", (kind) => {
	it.each([
		false,
		true,
		"",
	])("preserves literal versus template origin (template=%s)", (template) => {
		const naming = `seg-{rand_chars}-%number%.${kind === "TS" ? "ts" : "m4s"}`;
		for (const live of [false, true]) {
			const raw = JSON.parse(
				readFileSync(
					join(
						import.meta.dirname,
						"..",
						live ? "live" : "plan",
						"__fixtures__",
						live
							? "live-rtmp-simple.plan.json"
							: "fixed-bitrate-hls-on-aws.plan.json",
					),
					"utf8",
				),
			);
			raw.muxings = raw.muxings.map(
				(m: { key: string; streamKey: string; destination: unknown }) => ({
					key: m.key,
					streamKey: m.streamKey,
					destination: m.destination,
					kind,
					segmentNaming: "literal_%number%.m4s",
					...(template
						? { segmentNamingTemplate: naming }
						: {
								segmentNaming: naming,
								...(template === "" ? { segmentNamingTemplate: "" } : {}),
							}),
				}),
			);
			const expected = live
				? compileExpectedLiveArtefacts(liveChannelPlanSchema.parse(raw))
				: compileExpectedArtefacts(encodingPlanSchema.parse(raw));
			expect(expected.muxings.length).toBeGreaterThan(0);
			for (const muxing of expected.muxings) {
				expect(muxing.segmentNaming).toBe(naming);
				if (template)
					expect(muxing).toHaveProperty("segmentNamingIsTemplate", true);
				else expect(muxing).not.toHaveProperty("segmentNamingIsTemplate");
			}
		}
	});
});
