import { describe, expect, it } from "vitest";
import type { WizardDrmRow } from "./build-plan";
import { blankDrmRow, drmEntriesFor, orphanDrmEntries } from "./drm-row-editor";

const rows: WizardDrmRow[] = [
	{ kind: "CENC", muxingKey: "v1080", credentialId: "c", kid: "k" },
	{
		kind: "FAIRPLAY",
		muxingKey: "v1080",
		credentialId: "c",
		iv: "i",
		uri: "u",
	},
	{ kind: "CENC", muxingKey: "a128", credentialId: "c", kid: "k" },
	{ kind: "CENC", muxingKey: "ghost", credentialId: "c", kid: "k" },
];

describe("blankDrmRow", () => {
	it("creates a CENC row pre-targeted to the muxing key", () => {
		expect(blankDrmRow("CENC", "v720")).toEqual({
			kind: "CENC",
			muxingKey: "v720",
			credentialId: "",
			kid: "",
		});
	});
	it("creates a FAIRPLAY row with iv/uri fields", () => {
		expect(blankDrmRow("FAIRPLAY", "a128")).toEqual({
			kind: "FAIRPLAY",
			muxingKey: "a128",
			credentialId: "",
			iv: "",
			uri: "",
		});
	});
	it("leaves a fresh CENC row at the API-default mode (encryptionMode absent)", () => {
		// The cenc-cbc golden depends on encryptionMode being OMITTED → CTR; a
		// blank row must not pre-seed it.
		const row = blankDrmRow("CENC", "v720");
		expect(row.kind === "CENC" && row.encryptionMode).toBeUndefined();
	});
});

describe("drmEntriesFor", () => {
	it("returns only the rows targeting the key, tagged with their global index", () => {
		const entries = drmEntriesFor(rows, "v1080");
		expect(entries.map((e) => e.index)).toEqual([0, 1]);
		expect(entries.map((e) => e.row.kind)).toEqual(["CENC", "FAIRPLAY"]);
	});
	it("is empty for a key with no encryption", () => {
		expect(drmEntriesFor(rows, "v360")).toEqual([]);
	});
	it("preserves the GLOBAL index when matches are non-contiguous", () => {
		// The index must point back into state.drm[] (change/remove key off it).
		// A regression that re-indexed into the filtered subarray would return
		// [0, 1] here instead of [0, 2].
		const split: WizardDrmRow[] = [
			{ kind: "CENC", muxingKey: "x", credentialId: "c", kid: "k" },
			{ kind: "CENC", muxingKey: "y", credentialId: "c", kid: "k" },
			{
				kind: "FAIRPLAY",
				muxingKey: "x",
				credentialId: "c",
				iv: "i",
				uri: "u",
			},
		];
		expect(drmEntriesFor(split, "x").map((e) => e.index)).toEqual([0, 2]);
	});
});

describe("orphanDrmEntries", () => {
	it("surfaces rows whose muxingKey matches no current output", () => {
		const orphans = orphanDrmEntries(rows, new Set(["v1080", "a128"]));
		expect(orphans).toHaveLength(1);
		expect(orphans[0]?.index).toBe(3);
		expect(orphans[0]?.row.muxingKey).toBe("ghost");
	});
	it("returns nothing when every row matches a current output", () => {
		expect(orphanDrmEntries(rows, new Set(["v1080", "a128", "ghost"]))).toEqual(
			[],
		);
	});
	it("treats every row as an orphan when there are no outputs, keeping indices", () => {
		// All renditions removed/renamed → every row surfaces for re-point, and
		// each keeps its global state.drm[] index.
		expect(orphanDrmEntries(rows, new Set()).map((e) => e.index)).toEqual([
			0, 1, 2, 3,
		]);
	});
});
