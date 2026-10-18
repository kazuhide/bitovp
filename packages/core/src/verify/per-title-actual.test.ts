import { describe, expect, it } from "vitest";
import type { PerTitleResultsSnapshot } from "../plan/per-title-results";
import { perTitleActualVideoFamilies } from "./per-title-actual";

/**
 * The third witness of the per-title family comparison
 * what the provider's RESULT population says. Every
 * arm that cannot answer must say so as `absent`/`incomplete` — the engine
 * turns those into an explicit SKIP — and only a complete capture yields a
 * family set, because a truncated or config-blind capture would otherwise read
 * as "the encoder produced fewer families".
 */

const stream = (
	streamId: string,
	codecType: string | undefined,
): PerTitleResultsSnapshot["streams"][number] => ({
	streamId,
	mode: "PER_TITLE_RESULT",
	...(codecType !== undefined ? { codecType } : {}),
	params: {},
	muxings: [],
});

const snapshot = (
	streams: PerTitleResultsSnapshot["streams"],
	scan: Partial<PerTitleResultsSnapshot["scan"]> = {},
): PerTitleResultsSnapshot => ({
	capturedAt: "2026-08-30T00:00:00.000Z",
	streams,
	scan: {
		streamsListed: streams.length + 7,
		templatesListed: 7,
		templatesDeclared: 7,
		resultsCaptured: streams.length,
		muxingsListed: streams.length * 3,
		complete: true,
		codecConfigErrors: 0,
		unattributed: 0,
		...scan,
	},
});

describe("perTitleActualVideoFamilies", () => {
	it("a complete capture yields the sorted, de-duplicated family set", () => {
		const view = perTitleActualVideoFamilies({
			origin: "step",
			snapshot: snapshot([
				stream("s1", "H264"),
				stream("s2", "H264"),
				stream("s3", "H264"),
			]),
		});
		expect(view).toEqual({
			status: "complete",
			families: ["H264"],
			results: 3,
		});
	});

	it("keeps every family the capture carries — the comparison, not this reader, judges them", () => {
		const view = perTitleActualVideoFamilies({
			origin: "snapshot",
			snapshot: snapshot([stream("s1", "H265"), stream("s2", "AV1")]),
		});
		expect(view).toEqual({
			status: "complete",
			families: ["AV1", "H265"],
			results: 2,
		});
	});

	it("a complete capture with ZERO results is complete and empty — an honest answer, not an unknown", () => {
		const view = perTitleActualVideoFamilies({
			origin: "step",
			snapshot: snapshot([], { streamsListed: 7, resultsCaptured: 0 }),
		});
		expect(view).toEqual({ status: "complete", families: [], results: 0 });
	});

	it("a capture that hit the page cap is INCOMPLETE, whatever it managed to read", () => {
		const view = perTitleActualVideoFamilies({
			origin: "step",
			snapshot: snapshot([stream("s1", "H264")], { complete: false }),
		});
		expect(view.status).toBe("incomplete");
		expect(view).toMatchObject({
			reason: expect.stringMatching(/complete=false/),
		});
	});

	it("a RESULT stream whose codec config could not be read makes the set INCOMPLETE, not smaller", () => {
		const view = perTitleActualVideoFamilies({
			origin: "step",
			snapshot: snapshot([stream("s1", "H264"), stream("s2", undefined)], {
				codecConfigErrors: 1,
			}),
		});
		expect(view.status).toBe("incomplete");
		expect(view).toMatchObject({
			reason: expect.stringMatching(/1 of 2 .* no codec type/),
		});
	});

	it("no capture at all is ABSENT with the reason", () => {
		expect(perTitleActualVideoFamilies({ origin: "absent" })).toEqual({
			status: "absent",
			reason: expect.stringMatching(/no per-title RESULT capture/),
		});
	});

	it("a FAILED capture is ABSENT and carries the capture's own error", () => {
		expect(
			perTitleActualVideoFamilies({
				origin: "failed",
				error: "listStreams timed out",
			}),
		).toEqual({
			status: "absent",
			reason: expect.stringMatching(/listStreams timed out/),
		});
	});
});

it("maps HEVCv2 to the H265 bitstream family without changing provider evidence", () => {
	const evidence = snapshot([
		stream("v2", "H265V2"),
		stream("v1", "H265"),
		stream("other", "UNKNOWN"),
	]);
	expect(
		perTitleActualVideoFamilies({ origin: "step", snapshot: evidence }),
	).toEqual({ status: "complete", families: ["H265", "UNKNOWN"], results: 3 });
	expect(evidence.streams[0]?.codecType).toBe("H265V2");
});
