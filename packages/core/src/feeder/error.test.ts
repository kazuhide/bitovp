import { describe, expect, it } from "vitest";
import {
	FEEDER_ERROR_CODES,
	feederError,
	feederErrorEnglish,
	parseFeederError,
} from "./error";

describe("feederError / parseFeederError", () => {
	it("roundtrips typed differences separately from legacy interpolation prose", () => {
		const differences = [
			{
				attribute: "frame rate",
				reference: "30/1",
				candidate: "24/1",
				blocking: true,
			},
		] as const;
		expect(
			parseFeederError(feederError("slateMismatch", {}, differences)),
		).toEqual({
			code: "slateMismatch",
			params: { differences: "frame rate 30/1 → 24/1" },
			differences,
		});
		for (const invalid of [
			null,
			{},
			[{ ...differences[0], blocking: "false" }],
			[{ ...differences[0], attribute: "unknown" }],
		]) {
			expect(
				parseFeederError(
					JSON.stringify({
						code: "slateMismatch",
						params: {},
						differences: invalid,
					}),
				),
			).toEqual({ code: "slateMismatch", params: {} });
		}
	});
	it.each(
		[
			null,
			{},
			[
				{
					attribute: "color primaries",
					reference: "bt709",
					candidate: "bt2020",
					blocking: true,
				},
			],
			[
				{
					attribute: "frame rate",
					reference: "30/1",
					candidate: "24/1",
					blocking: "false",
				},
			],
		].map((differences) => ({ differences })),
	)("ignores unusable optional detail but preserves the legacy notification fallback (%j)", ({
		differences,
	}) => {
		const params = {
			originKind: "runSource",
			differences: "color primaries bt709 → bt2020",
			nested: { ignored: true },
		};
		const stored = JSON.stringify({
			code: "sourceMismatch",
			params,
			differences,
		});
		const legacy = feederError("sourceMismatch", {
			originKind: "runSource",
			differences: params.differences,
		});
		expect(parseFeederError(stored)).toEqual({
			code: "sourceMismatch",
			params: { originKind: "runSource", differences: params.differences },
		});
		expect(feederErrorEnglish(stored)).toBe(feederErrorEnglish(legacy));
		expect(feederErrorEnglish(stored)).not.toContain('"code"');
	});
	it("serialises a code + params round-trip", () => {
		const stored = feederError("sourceMismatch", {
			originKind: "runSource",
			differences: "frame rate 30000/1001 → 24/1",
		});
		expect(parseFeederError(stored)).toEqual({
			code: "sourceMismatch",
			params: {
				originKind: "runSource",
				differences: "frame rate 30000/1001 → 24/1",
			},
		});
	});

	it("defaults params to an empty object when omitted", () => {
		expect(parseFeederError(feederError("ingestUnsatisfied"))).toEqual({
			code: "ingestUnsatisfied",
			params: {},
		});
	});

	it("round-trips every known code", () => {
		for (const code of FEEDER_ERROR_CODES) {
			const parsed = parseFeederError(feederError(code, { a: 1 }));
			expect(parsed?.code).toBe(code);
		}
	});

	// The documented fallback: a plain sentence from a legacy row or an
	// un-migrated writer is NOT JSON, so it parses to null and the panel renders
	// it verbatim. This is the load-bearing back-compat guarantee.
	it("returns null for a legacy plain-English sentence", () => {
		expect(
			parseFeederError(
				'Source cannot satisfy the channel\'s ingest: ingest "audio" needs audio. The encoder would accept the connection and publish nothing.',
			),
		).toBeNull();
	});

	it("returns null for a plain string that is not JSON at all", () => {
		expect(parseFeederError("processing failed")).toBeNull();
	});

	it("returns null for JSON carrying an UNKNOWN code", () => {
		expect(parseFeederError(JSON.stringify({ code: "ECONNRESET" }))).toBeNull();
	});

	it("returns null for JSON that is not an object", () => {
		expect(parseFeederError(JSON.stringify(["sourceMismatch"]))).toBeNull();
		expect(parseFeederError(JSON.stringify("sourceMismatch"))).toBeNull();
		expect(parseFeederError("{ not valid json")).toBeNull();
	});

	it("returns null when code is present but not a string", () => {
		expect(parseFeederError(JSON.stringify({ code: 7 }))).toBeNull();
	});

	it("keeps only string/number params and drops the rest", () => {
		const stored = JSON.stringify({
			code: "slateMismatch",
			params: { differences: "x", n: 2, nested: { a: 1 }, arr: [1], ok: true },
		});
		expect(parseFeederError(stored)).toEqual({
			code: "slateMismatch",
			params: { differences: "x", n: 2 },
		});
	});
});

describe("feederErrorEnglish", () => {
	it.each([
		"toString",
		"constructor",
		"__proto__",
		"hasOwnProperty",
		7,
		null,
		false,
	])("rejects inherited or non-string origin %j without exposing implementation text", (originKind) => {
		const stored = JSON.stringify({
			code: "sourceMismatch",
			params: { originKind, differences: "x" },
		});
		expect(feederErrorEnglish(stored)).toBe(
			"The file input could not continue. Ask an administrator to review Diagnostics.",
		);
	});
	// The notification path (Slack body, SCHEDULE_MISSED event, schedule-outcome
	// note) has no locale at write time, so a structured payload renders the
	// default-locale English sentence — NEVER the raw JSON.
	it("renders each code's English sentence with params interpolated", () => {
		expect(
			feederErrorEnglish(
				feederError("sourceMismatch", {
					originKind: "runSource",
					differences: "frame rate 30000/1001 → 24/1",
				}),
			),
		).toBe(
			"Source does not match what this channel is ingesting (the source this run started on) — the encoder would warn on the attribute change and drop the input, leaving the playlist advancing on a frozen picture:\nframe rate 30000/1001 → 24/1",
		);
		expect(
			feederErrorEnglish(
				feederError("ingestUnsatisfied", { detail: "ingest needs audio" }),
			),
		).toBe(
			"Source cannot satisfy the channel's ingest: ingest needs audio. The encoder would accept the connection and publish nothing.",
		);
		// The heartbeat origin resolves to its own phrase.
		expect(
			feederErrorEnglish(
				feederError("sourceMismatch", {
					originKind: "heartbeat",
					differences: "x",
				}),
			),
		).toContain("the encoder's last heartbeat");
	});

	// The crux of the review: a structured payload must NOT surface as JSON.
	it("never leaves the code, params keys or JSON braces in the output", () => {
		const out = feederErrorEnglish(
			feederError("slateMismatch", {
				differences: "resolution 1920×1080 → 1280×720",
			}),
		);
		expect(out).toContain("insert would fail at air time");
		expect(out).toContain("resolution 1920×1080 → 1280×720");
		expect(out).not.toContain("slateMismatch");
		expect(out).not.toContain("differences");
		expect(out).not.toContain("{");
	});

	it("returns a legacy plain string unchanged", () => {
		expect(feederErrorEnglish("ffprobe failed (code 1): no output")).toBe(
			"ffprobe failed (code 1): no output",
		);
		expect(feederErrorEnglish("feeder failed")).toBe("feeder failed");
	});

	it("uses natural generic English on a malformed structured payload", () => {
		// Missing the {differences}/{origin} params → interpolation would throw.
		expect(() =>
			feederErrorEnglish(feederError("sourceMismatch", {})),
		).not.toThrow();
		expect(feederErrorEnglish(feederError("sourceMismatch", {}))).toBe(
			"The file input could not continue. Ask an administrator to review Diagnostics.",
		);
		// A bad originKind cannot resolve to a phrase → generic prose, no throw.
		expect(
			feederErrorEnglish(
				feederError("sourceMismatch", { originKind: "nope", differences: "x" }),
			),
		).toBe(
			"The file input could not continue. Ask an administrator to review Diagnostics.",
		);
		const optionalUnknown = JSON.stringify({
			code: "slateMismatch",
			params: {},
			differences: [{ attribute: "color primaries" }],
		});
		expect(feederErrorEnglish(optionalUnknown)).toBe(
			"The file input could not continue. Ask an administrator to review Diagnostics.",
		);
	});

	it("covers every known code without throwing", () => {
		for (const code of FEEDER_ERROR_CODES) {
			expect(() =>
				feederErrorEnglish(
					feederError(code, {
						detail: "d",
						differences: "d",
						found: "audio",
						originKind: "runSource",
					}),
				),
			).not.toThrow();
		}
	});
});
