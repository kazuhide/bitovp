import { describe, expect, it } from "vitest";
import { dashAudioLegSelected, dashVideoLegSelected } from "./dash-legs";

/**
 * The one spelling of "which leg does this MPD list" (review-323 S2). Both the
 * compiler's static selection and the validator's PLAN_DASH_VIDEO_UNSELECTED
 * read these; the table is the contract they share.
 */
describe("dashVideoLegSelected", () => {
	it.each([
		["FMP4 by default", { kind: "FMP4" }, {}, false, true],
		["WEBM only when declared", { kind: "WEBM" }, {}, false, false],
		[
			"WEBM when declared",
			{ kind: "WEBM" },
			{ videoMuxingKind: "WEBM" },
			false,
			true,
		],
		[
			"FMP4 not when WEBM declared",
			{ kind: "FMP4" },
			{ videoMuxingKind: "WEBM" },
			false,
			false,
		],
		["TS never (segmented)", { kind: "TS" }, {}, false, false],
		[
			"MP4 never (segmented)",
			{ kind: "MP4", manifestType: "DASH_ON_DEMAND" },
			{},
			false,
			false,
		],
		[
			"ON_DEMAND: DASH_ON_DEMAND MP4",
			{ kind: "MP4", manifestType: "DASH_ON_DEMAND" },
			{},
			true,
			true,
		],
		[
			"ON_DEMAND: byte-range MP4 is another manifest's",
			{ kind: "MP4", manifestType: "HLS_BYTE_RANGE" },
			{},
			true,
			false,
		],
		["ON_DEMAND: fMP4 is not listed", { kind: "FMP4" }, {}, true, false],
	])("%s", (_name, muxing, manifest, onDemand, expected) => {
		expect(dashVideoLegSelected(muxing, manifest, onDemand)).toBe(expected);
	});
});

describe("dashAudioLegSelected", () => {
	it.each([
		["FMP4 by default", { kind: "FMP4" }, {}, false, true],
		[
			"TS when declared",
			{ kind: "TS" },
			{ audioMuxingKind: "TS" },
			false,
			true,
		],
		["TS not by default", { kind: "TS" }, {}, false, false],
		[
			"ON_DEMAND: DASH_ON_DEMAND MP4",
			{ kind: "MP4", manifestType: "DASH_ON_DEMAND" },
			{},
			true,
			true,
		],
		["ON_DEMAND: fMP4 is not listed", { kind: "FMP4" }, {}, true, false],
	])("%s", (_name, muxing, manifest, onDemand, expected) => {
		expect(dashAudioLegSelected(muxing, manifest, onDemand)).toBe(expected);
	});
});
