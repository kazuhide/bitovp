import type { CredentialSummaryWire } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import type { WizardSources, WizardState } from "./build-plan";
import {
	blankStream,
	clearStreamReferences,
	convertStreamType,
	flattenStreams,
	inputFileShortLabel,
	isS3Credential,
	nextStreamKey,
	removeStream,
	streamReferenceLabel,
	writeStream,
} from "./stream-model";

const sources: WizardSources = {
	tracks: [
		{
			key: "dv-video",
			inputFile: "vidfile",
			selectionMode: "AUTO",
			position: 0,
		},
	],
	fileStreams: [{ key: "vtt-en", inputFile: "subsfile" }],
	dolbyStreams: [
		{
			kind: "VISION",
			key: "dv",
			videoInputFile: "mezfile",
			metadataInputFile: "metafile",
		},
		{
			kind: "ATMOS",
			key: "atmos-in",
			inputFile: "atmosfile",
			inputFormat: "ADM",
		},
		{ kind: "VISION_METADATA", key: "dv-meta", inputFile: "dvmetafile" },
	],
};

const file = (key: string, inputKey: string, bucket: string, path: string) => ({
	key,
	inputKey,
	kind: "S3" as const,
	credentialId: "c",
	bucket,
	path,
});

const state = {
	inputFiles: [
		file("main", "main", "primary-bkt", "video.mp4"),
		file("vidfile", "main", "primary-bkt", "video.mp4"),
		file("subsfile", "subs", "subs-bkt", "en.vtt"),
		file("mezfile", "main", "primary-bkt", "mez.mov"),
		file("metafile", "main", "primary-bkt", "meta.xml"),
		file("atmosfile", "main", "primary-bkt", "atmos.atmos"),
		file("dvmetafile", "metadata", "meta-bkt", "m.xml"),
	],
	videos: [],
	audios: [],
	sources,
} as unknown as WizardState;

describe("flattenStreams", () => {
	it("orders track → fileStream → dolby and tags origin/index", () => {
		const rows = flattenStreams(sources);
		expect(rows.map((r) => [r.origin, r.index, r.type])).toEqual([
			["track", 0, "INGEST"],
			["fileStream", 0, "WEBVTT"],
			["dolby", 0, "VISION"],
			["dolby", 1, "ATMOS"],
			["dolby", 2, "VISION_METADATA"],
		]);
	});

	it("maps VISION videoInputFile and keeps the metadata sidecar file", () => {
		const vision = flattenStreams(sources).find((r) => r.type === "VISION");
		expect(vision?.inputFile).toBe("mezfile");
		expect(vision?.metadataInputFile).toBe("metafile");
	});

	it("carries the Atmos input format", () => {
		const atmos = flattenStreams(sources).find((r) => r.type === "ATMOS");
		expect(atmos?.inputFormat).toBe("ADM");
	});
});

describe("writeStream", () => {
	it("writes an edited row back to its array slot without disturbing siblings", () => {
		const rows = flattenStreams(sources);
		const atmos = rows.find((r) => r.type === "ATMOS");
		if (!atmos) throw new Error("no atmos row");
		const next = writeStream(sources, { ...atmos, inputFile: "newfile" });
		expect(next.dolbyStreams?.[1]).toMatchObject({
			kind: "ATMOS",
			key: "atmos-in",
			inputFile: "newfile",
		});
		// Siblings untouched.
		expect(next.dolbyStreams?.[0]).toEqual(sources.dolbyStreams?.[0]);
		expect(next.tracks).toEqual(sources.tracks);
	});

	it("round-trips: flatten then write-each-back is identity", () => {
		const rows = flattenStreams(sources);
		let acc = sources;
		for (const row of rows) {
			acc = writeStream(acc, row);
		}
		expect(acc.tracks).toEqual(sources.tracks);
		expect(acc.fileStreams).toEqual(sources.fileStreams);
		expect(acc.dolbyStreams).toEqual(sources.dolbyStreams);
	});
});

describe("removeStream", () => {
	it("removes the targeted element from its native array", () => {
		const rows = flattenStreams(sources);
		const visionMeta = rows.find((r) => r.type === "VISION_METADATA");
		if (!visionMeta) throw new Error("no vision-metadata row");
		const next = removeStream(sources, visionMeta);
		expect(next.dolbyStreams).toHaveLength(2);
		expect(next.dolbyStreams?.some((s) => s.key === "dv-meta")).toBe(false);
	});
});

describe("convertStreamType", () => {
	it("moves a row between arrays preserving key/inputKey/encoding", () => {
		const withEnc: WizardSources = {
			tracks: [
				{
					key: "t1",
					inputFile: "subs",
					selectionMode: "AUTO",
					position: 0,
					encodingKey: "enc1",
				},
			],
		};
		const row = flattenStreams(withEnc)[0];
		if (!row) throw new Error("no row");
		const next = convertStreamType(withEnc, row, "ATMOS");
		expect(next.tracks ?? []).toHaveLength(0);
		expect(next.dolbyStreams?.[0]).toMatchObject({
			kind: "ATMOS",
			key: "t1",
			inputFile: "subs",
			inputFormat: "DAMF",
			encodingKey: "enc1",
		});
	});

	it("is reversible and keeps the hidden key stable", () => {
		const start: WizardSources = {
			tracks: [
				{ key: "keep", inputFile: "pfile", selectionMode: "AUTO", position: 0 },
			],
		};
		const row = flattenStreams(start)[0];
		if (!row) throw new Error("no row");
		const asAtmos = convertStreamType(start, row, "ATMOS");
		const atmosRow = flattenStreams(asAtmos)[0];
		if (!atmosRow) throw new Error("no atmos row");
		const back = convertStreamType(asAtmos, atmosRow, "INGEST");
		expect(back.tracks?.[0]?.key).toBe("keep");
		expect(back.dolbyStreams ?? []).toHaveLength(0);
	});

	it("returns sources unchanged when the type is identical", () => {
		const row = flattenStreams(sources)[0];
		if (!row) throw new Error("no row");
		expect(convertStreamType(sources, row, "INGEST")).toBe(sources);
	});
});

describe("nextStreamKey / blankStream", () => {
	it("generates a key unique across every stream array", () => {
		const key = nextStreamKey(sources, "ATMOS");
		const taken = new Set([
			...(sources.tracks ?? []).map((t) => t.key),
			...(sources.fileStreams ?? []).map((s) => s.key),
			...(sources.dolbyStreams ?? []).map((s) => s.key),
		]);
		expect(taken.has(key)).toBe(false);
		expect(key).toBe("atmos1");
	});

	it("appends a blank stream of the requested type", () => {
		const next = blankStream({}, "WEBVTT");
		expect(next.fileStreams).toEqual([{ key: "vtt1", inputFile: "main" }]);
	});
});

describe("streamReferenceLabel", () => {
	it("labels by type + input file + object path, never the raw key", () => {
		const rows = flattenStreams(sources);
		const visionMeta = rows.find((r) => r.type === "VISION_METADATA");
		if (!visionMeta) throw new Error("no vision-metadata row");
		const label = streamReferenceLabel(state, visionMeta);
		// References the declared input file's bucket, not the internal "dv-meta".
		expect(label).toContain("Vision metadata");
		expect(label).toContain("meta-bkt");
		expect(label).toContain("m.xml");
		expect(label).not.toContain("dv-meta");
	});

	it("uses the primary input bucket for main-referenced streams", () => {
		const track = flattenStreams(sources).find((r) => r.type === "INGEST");
		if (!track) throw new Error("no track");
		const label = streamReferenceLabel(state, track);
		expect(label).toContain("Ingest track");
		expect(label).toContain("primary-bkt");
	});
});

describe("isS3Credential", () => {
	const creds = [
		{ id: "s3", provider: "AWS_S3" },
		{ id: "az", provider: "AZURE_BLOB" },
	] as unknown as CredentialSummaryWire[];
	it("is true only for an AWS_S3 credential id", () => {
		expect(isS3Credential(creds, "s3")).toBe(true);
		expect(isS3Credential(creds, "az")).toBe(false);
		expect(isS3Credential(creds, "")).toBe(false);
	});
});

describe("convertStreamType — asymmetric VISION reshape", () => {
	const visionSources: WizardSources = {
		dolbyStreams: [
			{
				kind: "VISION",
				key: "dv",
				videoInputFile: "mezfile",
				metadataInputFile: "metafile",
				encodingKey: "enc1",
			},
		],
	};

	it.each([
		"INGEST",
		"ATMOS",
		"VISION_METADATA",
	] as const)("VISION → %s keeps videoInputFile and drops the metadata sidecar", (type) => {
		const row = flattenStreams(visionSources)[0];
		if (!row) throw new Error("no row");
		const next = convertStreamType(visionSources, row, type);
		const moved = flattenStreams(next)[0];
		expect(moved?.type).toBe(type);
		expect(moved?.inputFile).toBe("mezfile"); // videoInputFile preserved
		expect(moved?.metadataInputFile).toBeUndefined(); // sidecar dropped
		expect(moved?.key).toBe("dv");
		expect(moved?.encodingKey).toBe("enc1");
		// No metadata sidecar survives onto the native array element.
		expect(JSON.stringify(next)).not.toContain("metafile");
	});

	it("INGEST → VISION leaves metadataInputPath undefined and round-trips", () => {
		const start: WizardSources = {
			tracks: [
				{ key: "t", inputFile: "vfile", selectionMode: "AUTO", position: 0 },
			],
		};
		const row = flattenStreams(start)[0];
		if (!row) throw new Error("no row");
		const next = convertStreamType(start, row, "VISION");
		expect(next.dolbyStreams?.[0]).toMatchObject({
			kind: "VISION",
			key: "t",
			videoInputFile: "vfile",
		});
		// No carried sidecar: the value is undefined (buildPlan prunes the key,
		// like the inputKey/encodingKey pass-throughs).
		const visionEl = next.dolbyStreams?.[0];
		expect(visionEl && "kind" in visionEl && visionEl.kind === "VISION").toBe(
			true,
		);
		expect(
			visionEl && visionEl.kind === "VISION" ? visionEl.metadataInputFile : "x",
		).toBeUndefined();
	});

	it("ATMOS → INGEST restores selection defaults and drops the Atmos format", () => {
		const start: WizardSources = {
			dolbyStreams: [
				{ kind: "ATMOS", key: "a", inputFile: "afile", inputFormat: "ADM" },
			],
		};
		const row = flattenStreams(start)[0];
		if (!row) throw new Error("no row");
		const next = convertStreamType(start, row, "INGEST");
		expect(next.tracks?.[0]).toEqual({
			key: "a",
			inputFile: "afile",
			selectionMode: "AUTO",
			position: 0,
			encodingKey: undefined,
		});
		expect(JSON.stringify(next)).not.toContain("ADM");
	});
});

describe("nextStreamKey — collision skipping", () => {
	it("skips a key already held by a recovered preset", () => {
		const seeded: WizardSources = {
			dolbyStreams: [
				{ kind: "ATMOS", key: "atmos1", inputFile: "", inputFormat: "DAMF" },
			],
			fileStreams: [{ key: "vtt1", inputFile: "" }],
		};
		expect(nextStreamKey(seeded, "ATMOS")).toBe("atmos2");
		expect(nextStreamKey(seeded, "WEBVTT")).toBe("vtt2");
	});
});

describe("writeStream — empty/undefined target array", () => {
	it("creates the array when writing a row into sources that lack it", () => {
		const blank = blankStream({}, "WEBVTT");
		const row = flattenStreams(blank)[0];
		if (!row) throw new Error("no row");
		const next = writeStream(blank, { ...row, inputFile: "xfile" });
		expect(next.fileStreams).toEqual([{ key: "vtt1", inputFile: "xfile" }]);
	});
});

describe("blankStream — every shape", () => {
	it("INGEST appends an AUTO/0 track", () => {
		expect(blankStream({}, "INGEST").tracks).toEqual([
			{ key: "track1", inputFile: "main", selectionMode: "AUTO", position: 0 },
		]);
	});
	it("VISION appends a videoInputPath-only mezzanine", () => {
		expect(blankStream({}, "VISION").dolbyStreams).toEqual([
			{ kind: "VISION", key: "dv1", videoInputFile: "main" },
		]);
	});
	it("VISION_METADATA appends an inputPath sidecar", () => {
		expect(blankStream({}, "VISION_METADATA").dolbyStreams).toEqual([
			{ kind: "VISION_METADATA", key: "dv-meta1", inputFile: "main" },
		]);
	});
});

describe("clearStreamReferences", () => {
	const refState = {
		videos: [{ extras: { source: "dv" } }, { extras: { source: "other" } }, {}],
		audios: [{ extras: { source: "dv" } }],
		subtitles: [{ source: "dv" }],
	} as unknown as WizardState;

	it("reverts video/audio renditions that read the key to the implicit track", () => {
		const patch = clearStreamReferences(refState, "dv");
		expect(patch.videos?.[0]?.extras?.source).toBeUndefined();
		expect(patch.videos?.[1]?.extras?.source).toBe("other"); // untouched
		expect(patch.audios?.[0]?.extras?.source).toBeUndefined();
		// Subtitles are not in the returned patch (they need a source; left for
		// the preview to flag).
		expect(patch).not.toHaveProperty("subtitles");
	});

	it("returns an empty patch when nothing references the key", () => {
		expect(clearStreamReferences(refState, "nobody")).toEqual({});
	});
});

describe("inputFileShortLabel", () => {
	it("flags a dangling input key as missing", () => {
		expect(inputFileShortLabel(state, "ghost")).toBe("ghost (missing input)");
	});
});
