import { StreamInfo } from "@bitmovin/api-sdk";
import { describe, expect, it } from "vitest";

/**
 * The wire fact the `optStr(p.audio)` fix rests on (paid audit 893eb66
 * HIGH-8), pinned against the INSTALLED SDK rather than reasoned about: the
 * facade hands the payload straight to `new StreamInfo(p)` and the client
 * JSON-serializes the model, so what `undefined` and `""` become on the wire is
 * decided here and nowhere in our code.
 */
/*
 * What this test does NOT exercise (review-323 S1): the installed SDK's
 * `RestClient.request` runs `copyAndPrepareBody(body)` BEFORE `JSON.stringify` —
 * a recursive rebuilder that drops any property `== undefined` (so `null` too,
 * unlike native JSON). Traced by hand for this field the two paths agree
 * (undefined dropped, "" kept), which is the claim below. `copyAndPrepareBody`
 * is not re-exported from the package's public entry, so reaching it would mean
 * importing `dist/common/RestClient.js`; the day that helper changes semantics,
 * this file will not notice — a stubbed-fetch client test would.
 */
describe('StreamInfo serialization (the AUDIO="" mechanism)', () => {
	it("an undefined audio group is ABSENT from the request body", () => {
		const body = JSON.parse(
			JSON.stringify(
				new StreamInfo({
					audio: undefined,
					closedCaptions: "NONE",
					uri: "v.m3u8",
				}),
			),
		) as Record<string, unknown>;
		expect("audio" in body).toBe(false);
		expect(body.uri).toBe("v.m3u8");
	});

	it("an empty-string audio group is SENT as an empty string — the defect's shape", () => {
		// Kept as the negative control: if the SDK ever started dropping empty
		// strings, `str` would have been harmless and this whole fix moot.
		const body = JSON.parse(
			JSON.stringify(new StreamInfo({ audio: "", uri: "v.m3u8" })),
		) as Record<string, unknown>;
		expect(body.audio).toBe("");
	});
});
