import { describe, expect, it } from "vitest";
import { renditionFamily } from "./detail-view";
import { AUDIO_CODECS, renditionSchema } from "./schema";

/**
 * Every codec the schema can emit maps to a family DELIBERATELY.
 *
 * `renditionFamily` falls through to `"subtitle"`, so a codec added to the schema
 * and not to its video set lands silently in the subtitle table — and nothing
 * caught that, because "every rendition appears exactly once" passes just as well
 * with a video codec in the wrong bucket (review finding). The first version also
 * forked the schema's exported `AUDIO_CODECS` character-for-character, which
 * the shared contract forbids precisely because of this failure mode.
 *
 * The list of codecs is read OUT OF THE SCHEMA rather than written here, so
 * adding a discriminant fails this test until someone classifies it. That is the
 * whole point: the failure should arrive when the codec is added, not when an
 * operator finds H266 listed under Subtitles.
 */

function schemaCodecs(): string[] {
	// The discriminated union's options, each a strictObject with a literal codec.
	const options = (
		renditionSchema as unknown as {
			options: Array<{ shape: { codec: { value: string } } }>;
		}
	).options;
	return options.map((option) => option.shape.codec.value).sort();
}

/** The expected classification, written down once, by hand, on purpose. */
const EXPECTED: Record<string, "video" | "audio" | "subtitle"> = {
	H264: "video",
	H265: "video",
	VP9: "video",
	AV1: "video",
	AAC: "audio",
	OPUS: "audio",
	DOLBY_ATMOS: "audio",
	DDPLUS: "audio",
	DD: "audio",
	WEBVTT: "subtitle",
	IMSC: "subtitle",
};

describe("codec → rendition family", () => {
	it("reads the codec list out of the schema", () => {
		// Guards the reader: if `options`/`shape` ever stop being reachable this
		// yields [] and every assertion below passes over nothing.
		const codecs = schemaCodecs();
		expect(codecs.length).toBeGreaterThanOrEqual(9);
		expect(codecs).toContain("H264");
		expect(codecs).toContain("WEBVTT");
	});

	it("classifies every schema codec, with no unclassified fall-through", () => {
		const codecs = schemaCodecs();
		// A codec the schema has and this table does not is the failure this exists
		// for — it would otherwise render under Subtitles without a word.
		expect(codecs.filter((c) => !(c in EXPECTED))).toEqual([]);
		for (const codec of codecs) {
			const family = renditionFamily({ codec } as never);
			expect(family, codec).toBe(EXPECTED[codec]);
		}
	});

	it("uses the schema's own audio set, not a copy of it", () => {
		// If the fork came back, a codec removed from the schema's set would keep
		// classifying as audio here. Asserted against the imported set directly.
		for (const codec of AUDIO_CODECS) {
			expect(renditionFamily({ codec } as never), String(codec)).toBe("audio");
		}
		expect(AUDIO_CODECS.size).toBe(5);
	});
});
