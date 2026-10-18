import { describe, expect, it } from "vitest";
import { REDACTED } from "../crypto/redact";
import { canCurlStep, curlForStep } from "./curl-from-step";
import { OPERATION_KINDS, type StepLogEntry } from "./steplog";

/**
 * curl-from-step rebuilds an HTTP method + URL for a step from the
 * OPERATION_KIND→endpoint table (the persisted `request` snapshot carries no
 * method/url — only the redacted body + resolved refs). These tests pin the
 * mapping for representative kinds, prove path-param substitution and the
 * secret-free contract, and pin the graceful "unavailable" path for reads.
 */

function step(
	over: Partial<StepLogEntry> & Pick<StepLogEntry, "kind">,
): StepLogEntry {
	return {
		step: over.step ?? "s1",
		kind: over.kind,
		status: over.status ?? "DONE",
		payload: over.payload ?? {},
		refs: over.refs ?? {},
		resourceId: over.resourceId,
		request: over.request,
		response: over.response,
		error: over.error,
	};
}

describe("curlForStep — endpoint mapping", () => {
	it.each([
		"HD",
		"CUSTOM",
		undefined,
	] as const)("routes Live %s and strips the application selector", (encodingOption) => {
		const result = curlForStep(
			step({
				kind: "START_LIVE_ENCODING",
				refs: { encodingId: "enc-hd" },
				payload: encodingOption ? { encodingOption } : {},
				request: { streamKey: "example", encodingOption, refs: {} },
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.command).toContain(
			`/encoding/encodings/enc-hd/live/${encodingOption === "HD" ? "hd/" : ""}start`,
		);
		expect(result.command).not.toContain("encodingOption");
		expect(result.command).toContain('"streamKey": "example"');
	});
	it("does not guess a start endpoint for unresolved AUTO or malformed selectors", () => {
		for (const encodingOption of ["AUTO", "invalid", null]) {
			expect(
				curlForStep(
					step({
						kind: "START_LIVE_ENCODING",
						refs: { encodingId: "enc" },
						payload: { encodingOption },
					}),
				).ok,
			).toBe(false);
		}
	});
	it("maps a POST-with-body create (S3 input) to the right method/url and body", () => {
		const result = curlForStep(
			step({
				kind: "CREATE_INPUT_S3",
				request: {
					name: "Test S3 Input",
					bucketName: "sample-input-bucket",
					refs: {},
				},
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.command).toContain(
			"curl -X POST 'https://api.bitmovin.com/v1/encoding/inputs/s3'",
		);
		expect(result.command).toContain("-H 'X-Api-Key: $BITMOVIN_API_KEY'");
		expect(result.command).toContain("-H 'Content-Type: application/json'");
		// Body is the snapshot minus the `refs` bookkeeping key.
		expect(result.command).toContain("--data");
		expect(result.command).toContain('"bucketName": "sample-input-bucket"');
		expect(result.command).not.toContain('"refs"');
	});

	it("fills :encodingId path params from the resolved refs (muxing)", () => {
		const result = curlForStep(
			step({
				kind: "CREATE_MUXING_FMP4",
				refs: { encodingId: "enc-123", streamId: "stream-9" },
				request: { name: "video fmp4", outputPath: "out/v", refs: {} },
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.command).toContain(
			"'https://api.bitmovin.com/v1/encoding/encodings/enc-123/muxings/fmp4'",
		);
	});

	it("splices the lowercase muxingKind path segment for DRM (CENC on fmp4)", () => {
		const result = curlForStep(
			step({
				kind: "CREATE_DRM_CENC",
				refs: { encodingId: "enc-1", muxingId: "mux-2" },
				payload: { muxingKind: "FMP4" },
				request: { muxingKind: "FMP4", kid: "abc", refs: {} },
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.command).toContain(
			"/encoding/encodings/enc-1/muxings/fmp4/mux-2/drm/cenc",
		);
	});

	it("maps a deep DASH representation with three path params", () => {
		const result = curlForStep(
			step({
				kind: "CREATE_DASH_REPRESENTATION_FMP4",
				refs: {
					manifestId: "man-1",
					periodId: "per-2",
					adaptationSetId: "as-3",
					encodingId: "enc-4",
					muxingId: "mux-5",
				},
				request: { type: "TEMPLATE", segmentPath: "v/360", refs: {} },
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.command).toContain(
			"/encoding/manifests/dash/man-1/periods/per-2/adaptationsets/as-3/representations/fmp4",
		);
	});

	it("maps START_ENCODING (no --data when body is just refs)", () => {
		const result = curlForStep(
			step({
				kind: "START_ENCODING",
				refs: { encodingId: "enc-1", vodHlsManifestIds: ["m1", "m2"] },
				// real START snapshots are `{ refs: {...} }` when payload is empty
				request: { refs: {} },
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.command).toContain(
			"curl -X POST 'https://api.bitmovin.com/v1/encoding/encodings/enc-1/start'",
		);
		// Empty (refs-only) body ⇒ no --data / no Content-Type.
		expect(result.command).not.toContain("--data");
		expect(result.command).not.toContain("Content-Type");
	});

	it("maps START_ENCODING WITH a non-empty body (perTitle/manifestGenerator)", () => {
		const result = curlForStep(
			step({
				kind: "START_ENCODING",
				refs: { encodingId: "enc-1" },
				request: { manifestGenerator: "V2", refs: {} },
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.command).toContain("--data");
		expect(result.command).toContain('"manifestGenerator": "V2"');
	});

	it("renders an unavailable reason for an AWAIT read (no write endpoint)", () => {
		const result = curlForStep(
			step({
				kind: "AWAIT_ENCODING",
				refs: { encodingId: "enc-1" },
				response: { status: "FINISHED" },
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("NO_ENDPOINT");
		expect(result.kind).toBe("AWAIT_ENCODING");
		expect(canCurlStep(step({ kind: "AWAIT_ENCODING" }))).toBe(false);
	});

	it("renders unavailable for CREATE_INPUT_RTMP (resolve-by-list; no POST)", () => {
		expect(canCurlStep(step({ kind: "CREATE_INPUT_RTMP" }))).toBe(false);
	});

	it("renders unavailable for per-title expansion ops (many calls, not one)", () => {
		expect(
			canCurlStep(step({ kind: "CREATE_DASH_PER_TITLE_REPRESENTATIONS" })),
		).toBe(false);
		expect(canCurlStep(step({ kind: "CREATE_HLS_PER_TITLE_VARIANTS" }))).toBe(
			false,
		);
	});

	it("returns unavailable (not a wrong url) when a path param is missing", () => {
		const result = curlForStep(
			step({
				kind: "CREATE_MUXING_FMP4",
				refs: {}, // no encodingId
				request: { name: "x", refs: {} },
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("UNRESOLVED_PATH_PARAMS");
		expect(result.kind).toBe("CREATE_MUXING_FMP4");
	});
});

describe("curlForStep — options", () => {
	it("honours a custom baseUrl and an org-header placeholder", () => {
		const result = curlForStep(
			step({
				kind: "CREATE_ENCODING",
				request: { name: "e", cloudRegion: "AWS_US_EAST_1", refs: {} },
			}),
			{ baseUrl: "https://api.bitmovin.com/v1/", includeOrgHeader: true },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Trailing slash on baseUrl is normalized (no double slash).
		expect(result.command).toContain(
			"'https://api.bitmovin.com/v1/encoding/encodings'",
		);
		expect(result.command).toContain(
			"-H 'X-Tenant-Org-Id: $BITMOVIN_TENANT_ORG_ID'",
		);
	});

	it("omits the org header by default", () => {
		const result = curlForStep(step({ kind: "CREATE_ENCODING" }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.command).not.toContain("X-Tenant-Org-Id");
	});
});

describe("curlForStep — secret-free by construction", () => {
	it("never emits a real key: auth is a shell placeholder, body is already redacted", () => {
		// The executor persists request bodies already redacted; a DRM create's
		// content key is masked to REDACTED before it reaches the step log (and
		// the sdk-ops snapshot omits `key` entirely). Simulate the redacted body.
		const result = curlForStep(
			step({
				kind: "CREATE_INPUT_S3",
				request: {
					name: "S3",
					bucketName: "b",
					// A defensively-redacted secret-looking field, as persisted.
					secretAccessKey: REDACTED,
					refs: {},
				},
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The only auth material is the placeholder var — never an inline secret.
		expect(result.command).toContain("$BITMOVIN_API_KEY");
		expect(result.command).not.toMatch(/X-Api-Key: (?!\$)/);
		// Whatever the (already-redacted) body carries, it is the REDACTED token,
		// not a live secret.
		expect(result.command).toContain(REDACTED);
	});

	it("escapes single quotes in the body so the shell arg stays well-formed", () => {
		const result = curlForStep(
			step({
				kind: "CREATE_ENCODING",
				request: { name: "it's a name", refs: {} },
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// POSIX close-quote/escaped-quote/reopen pattern.
		expect(result.command).toContain(`'\\''`);
	});
});

describe("every operation kind is classified", () => {
	/**
	 * `ENDPOINTS` is a Partial map, so a kind that is missing simply produces no
	 * cURL — indistinguishable from a kind that is deliberately unreproducible.
	 * That makes "forgot to add it" a silent outcome, which is how copy-as-cURL
	 * would quietly lose coverage as the compiler grows. Every kind must
	 * therefore be either curl-able or listed below WITH a reason.
	 */
	const NO_CURL_BY_DESIGN: Record<string, string> = {
		AWAIT_ENCODING: "status read, not a reproducible mutation",
		AWAIT_MANIFEST_HLS: "status read",
		AWAIT_MANIFEST_DASH: "status read",
		AWAIT_MANIFEST_SMOOTH: "status read",
		AWAIT_LIVE_RUNNING: "status read",
		SCTE35_CUE: "runtime record; the request lives in the C7 audit row",
		// A POST endpoint DOES exist for this one (the ESAM route calls it), so if
		// anyone maps it here, check `request` still holds the real body shape —
		// this guard would stay green either way.
		ESAM_MEDIA_POINT: "runtime record; the request lives in the C7 audit row",
		// Same class : the scheduled-insertable-content POST
		// is audited by sdk-ops; the step entry is the record that it happened.
		SLATE_INSERTED: "runtime record; the request lives in the C7 audit row",
		// 's three verdicts describe a READ of the provider's own
		// scheduled entry, not a call the operator could replay — reproducing
		// one would mean re-running a GET whose answer has already moved on.
		SLATE_CONFIRMED: "runtime record; describes a status read, not a mutation",
		SLATE_FAILED: "runtime record; describes a status read, not a mutation",
		SLATE_UNCONFIRMED:
			"runtime record; describes a status read, not a mutation",
		CREATE_INPUT_RTMP: "resolved by list — Bitmovin has no POST for it",
		CAPTURE_PER_TITLE_RESULTS:
			"read-only capture — a streams list, then one codec-config GET per rung",
		CREATE_DASH_PER_TITLE_REPRESENTATIONS: "expansion op — many calls, not one",
		CREATE_HLS_PER_TITLE_VARIANTS: "expansion op — many calls, not one",
		CREATE_SMOOTH_PER_TITLE_ENTRIES: "expansion op — many calls, not one",
	};

	/**
	 * WHAT THIS GUARD DOES NOT PROVE (review catch). It asserts a kind is
	 * *classified* — curl-able or exempted-with-a-reason — never that the cURL it
	 * produces is a request Bitmovin would accept. And the evidence differs per
	 * kind: the goldens cover every VOD kind, so a reviewer could diff real ops
	 * against this stub and confirm zero mismatches, but 13 kinds (mostly live)
	 * have no `.ops.json` coverage at all, so for those the stub below is the only
	 * evidence. `START_LIVE_ENCODING` is the one uncovered kind with a path param,
	 * which makes it the one most worth a real fixture.
	 */
	/** A minimal well-formed entry: `canCurlStep` reads refs and payload. */
	const stub = (kind: string): StepLogEntry =>
		({
			step: kind,
			kind,
			payload: { muxingKind: "FMP4" },
			// Every path param any template uses (`:param` in ENDPOINTS), so "no
			// curl" means the kind is genuinely unmapped rather than this stub
			// merely lacking an id. muxingKind rides the payload, not refs.
			refs: {
				encodingId: "enc",
				manifestId: "man",
				streamId: "str",
				streamInfoId: "sinf",
				muxingId: "mux",
				periodId: "per",
				adaptationSetId: "ada",
				representationId: "rep",
				drmId: "drm",
			},
			status: "DONE",
		}) as unknown as StepLogEntry;

	it("is exhaustive over OPERATION_KINDS", () => {
		const unclassified = OPERATION_KINDS.filter(
			(kind) => !canCurlStep(stub(kind)) && !NO_CURL_BY_DESIGN[kind],
		);
		expect(
			unclassified,
			"add an ENDPOINTS entry, or list the kind in NO_CURL_BY_DESIGN with why",
		).toEqual([]);
	});

	it("has no stale exemptions", () => {
		const stale = Object.keys(NO_CURL_BY_DESIGN).filter(
			(kind) => !(OPERATION_KINDS as readonly string[]).includes(kind),
		);
		expect(stale).toEqual([]);
	});

	it("no exempted kind is ALSO curl-able (the reason would be a lie)", () => {
		const contradictory = Object.keys(NO_CURL_BY_DESIGN).filter((kind) =>
			canCurlStep(stub(kind)),
		);
		expect(contradictory).toEqual([]);
	});
});
