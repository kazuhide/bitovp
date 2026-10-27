import { execFileSync } from "node:child_process";
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
		"CREATE_HLS_AUDIO_MEDIA",
		"CREATE_HLS_STREAM_INFO",
		"CREATE_HLS_SUBTITLES_MEDIA",
	] as const)("requires resolved snapshot IDs for %s", (kind) => {
		for (const missing of [
			"manifestId",
			"encodingId",
			"streamId",
			"muxingId",
			"drmId",
		]) {
			const refs: Record<string, string> = {
				manifestId: "manifest",
				encodingId: "encoding",
				streamId: "stream",
				muxingId: "muxing",
				drmId: "drm",
			};
			delete refs[missing];
			expect(
				curlForStep(
					step({
						kind,
						refs: {
							manifestId: "compiled-manifest-step",
							drmId: "compiled-drm-step",
						},
						request: { uri: "video.m3u8", refs },
					}),
				),
			).toEqual({ ok: false, code: "UNRESOLVED_PATH_PARAMS", kind });
		}
	});
	it.each([
		"L4_1",
		"4.1",
	])("uses the AV1 maximum-level wire value for request snapshot %s", (maxLevel) => {
		const request = Object.freeze({ width: 1280, maxLevel, refs: {} });
		const entry = step({
			kind: "CREATE_CODEC_AV1",
			payload: { width: 1280, maxLevel: "L4_1" },
			request,
		});
		const result = curlForStep(entry);
		if (!result.ok) throw new Error("Expected AV1 cURL");
		const body = result.command.match(/--data '([\s\S]*)'$/)?.[1];
		if (body === undefined) throw new Error("Missing cURL JSON body");
		expect(JSON.parse(body)).toEqual({ width: 1280, maxLevel: "4.1" });
		expect(request.maxLevel).toBe(maxLevel);
		expect(entry.payload.maxLevel).toBe("L4_1");
	});
	it("leaves an omitted AV1 maximum level absent from cURL", () => {
		const result = curlForStep(
			step({ kind: "CREATE_CODEC_AV1", request: { width: 1280, refs: {} } }),
		);
		if (!result.ok) throw new Error("Expected AV1 cURL");
		expect(result.command).toContain('"width": 1280');
		expect(result.command).not.toContain("maxLevel");
	});
	it.each([
		"",
		"toString",
		"constructor",
		"__proto__",
		"FUTURE_LEVEL",
		null,
		0,
		false,
		{},
		[],
	])("does not generate cURL for an invalid AV1 maximum level %j", (maxLevel) => {
		expect(
			curlForStep(
				step({ kind: "CREATE_CODEC_AV1", request: { maxLevel, refs: {} } }),
			),
		).toEqual({ ok: false, code: "NO_ENDPOINT", kind: "CREATE_CODEC_AV1" });
	});
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
		expect(result.command).toContain('-H "X-Api-Key: $BITMOVIN_API_KEY"');
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

	it.each([
		"CREATE_DRM_CENC",
		"CREATE_DRM_FAIRPLAY",
		"CREATE_DRM_SPEKE",
	] as const)("does not offer an incomplete vault-backed %s request", (kind) => {
		const result = curlForStep(
			step({
				kind,
				refs: { encodingId: "enc-1", muxingId: "mux-2" },
				payload: { muxingKind: "FMP4" },
				request: { muxingKind: "FMP4", kid: "abc", refs: {} },
			}),
		);
		expect(result).toEqual({ ok: false, code: "VAULT_FIELDS_OMITTED", kind });
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
				request: {
					type: "TEMPLATE",
					segmentPath: "v/360",
					refs: {
						manifestId: "man-1",
						periodId: "per-2",
						adaptationSetId: "as-3",
						encodingId: "enc-4",
						muxingId: "mux-5",
					},
				},
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.command).toContain(
			"/encoding/manifests/dash/man-1/periods/per-2/adaptationsets/as-3/representations/fmp4",
		);
	});

	it("does not invent body references from unresolved manifest snapshots", () => {
		for (const kind of [
			"CREATE_DASH_REPRESENTATION_FMP4",
			"CREATE_DASH_REPRESENTATION_SPRITE",
			"CREATE_HLS_VIDEO_MEDIA",
			"CREATE_HLS_CUSTOM_TAG",
		] as const) {
			expect(
				curlForStep(
					step({
						kind,
						refs: {
							manifestId: "manifest:planned",
							periodId: "planned-period",
							adaptationSetId: "planned-set",
							encodingId: "encoding",
							streamId: "stream:planned",
							muxingId: "muxing:planned",
						},
						request: { type: "TEMPLATE", positionMode: "KEYFRAME", refs: {} },
					}),
				).ok,
			).toBe(false);
		}
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
			'-H "X-Tenant-Org-Id: $BITMOVIN_TENANT_ORG_ID"',
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
		CREATE_DRM_CENC:
			"the content key is kept in the vault, outside the saved request",
		CREATE_DRM_FAIRPLAY:
			"the content key is kept in the vault, outside the saved request",
		CREATE_DRM_SPEKE:
			"key-provider settings are kept in the vault, outside the saved request",
		AWAIT_ENCODING: "status read, not a reproducible mutation",
		AWAIT_MANIFEST_HLS: "status read",
		AWAIT_MANIFEST_DASH: "status read",
		AWAIT_MANIFEST_SMOOTH: "status read",
		AWAIT_LIVE_RUNNING: "status read",
		SCTE35_CUE: "runtime record; the request lives in the C7 audit row",
		LIVE_AUTO_SHUTDOWN_UPDATE:
			"runtime record; the full replacement request lives in the audit row",
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
	/** A minimal completed entry with resolved request refs for manifest copies. */
	const stub = (kind: string): StepLogEntry => {
		const refs = {
			encodingId: "enc",
			manifestId: "man",
			streamId: "str",
			streamInfoId: "sinf",
			mediaId: "media",
			outputId: "output",
			muxingId: "mux",
			periodId: "per",
			adaptationSetId: "ada",
			representationId: "rep",
			drmId: "drm",
			spriteId: "sprite",
		};
		return {
			step: kind,
			kind: kind as StepLogEntry["kind"],
			payload: { muxingKind: "FMP4" },
			refs,
			request: {
				type: "SEGMENT_BASE",
				filePath: "video.mp4",
				...(kind === "CREATE_HLS_VTT_MEDIA" ||
				kind === "CREATE_DASH_REPRESENTATION_VTT"
					? { vttUrl: "https://cdn.example.test/sub.vtt" }
					: {}),
				refs,
			},
			status: "DONE",
		};
	};

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

describe("OnDemand MP4 cURL from persisted resolved request refs", () => {
	const payload = { type: "SEGMENT_BASE", filePath: "encrypted/video.mp4" };
	const resolved = {
		manifestId: "manifest-id",
		periodId: "period-id",
		adaptationSetId: "set-id",
		encodingId: "encoding-id",
		muxingId: "muxing-id",
		drmId: "drm-id",
	};
	function mp4(encrypted = true, refs: Record<string, unknown> = resolved) {
		return step({
			kind: "CREATE_DASH_REPRESENTATION_MP4",
			payload,
			refs: {
				manifestId: "manifest:dash",
				periodId: "manifest:dash:period",
				adaptationSetId: "manifest:dash:aset-video",
				encodingId: "encoding",
				muxingId: "muxing:video",
				...(encrypted ? { drmId: "drm:video" } : {}),
			},
			request: {
				...payload,
				refs: encrypted
					? refs
					: Object.fromEntries(
							Object.entries(refs).filter(([key]) => key !== "drmId"),
						),
			},
		});
	}
	it("uses the DRM MP4 endpoint and all required resolved body references", () => {
		const result = curlForStep(mp4());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.command).toContain(
			"/dash/manifest-id/periods/period-id/adaptationsets/set-id/representations/mp4/drm'",
		);
		expect(result.command).toContain('"drmId": "drm-id"');
		expect(result.command).toContain('"encodingId": "encoding-id"');
		expect(result.command).toContain('"muxingId": "muxing-id"');
		expect(result.command).toContain('"filePath": "encrypted/video.mp4"');
		expect(result.command).not.toContain('"refs"');
		expect(result.command).not.toContain("manifest:dash");
		expect(result.command).not.toContain("drm:video");
	});
	it("keeps clear MP4 on the plain endpoint without a DRM ID", () => {
		const result = curlForStep(mp4(false));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.command).toContain(
			"/dash/manifest-id/periods/period-id/adaptationsets/set-id/representations/mp4'",
		);
		expect(result.command).toContain('"encodingId": "encoding-id"');
		expect(result.command).toContain('"muxingId": "muxing-id"');
		expect(result.command).not.toContain('"drmId"');
		expect(result.command).not.toContain("/mp4/drm");
	});
	it.each([
		"manifestId",
		"periodId",
		"adaptationSetId",
		"encodingId",
		"muxingId",
		"drmId",
	])("does not fall back to compiled references when resolved %s is missing", (missing) => {
		const refs = Object.fromEntries(
			Object.entries(resolved).filter(([key]) => key !== missing),
		);
		expect(curlForStep(mp4(true, refs))).toEqual({
			ok: false,
			code: "UNRESOLVED_PATH_PARAMS",
			kind: "CREATE_DASH_REPRESENTATION_MP4",
		});
	});
	it.each([
		undefined,
		null,
		"",
		["not-a-path"],
	])("rejects a missing or malformed MP4 file path (%s)", (filePath) => {
		const entry = mp4();
		entry.request = { ...payload, filePath, refs: resolved };
		expect(curlForStep(entry)).toEqual({
			ok: false,
			code: "UNRESOLVED_PATH_PARAMS",
			kind: entry.kind,
		});
	});
	it.each([
		null,
		"",
		["not-a-scalar"],
	])("rejects a malformed resolved DRM ID (%s)", (drmId) => {
		expect(curlForStep(mp4(true, { ...resolved, drmId }))).toEqual({
			ok: false,
			code: "UNRESOLVED_PATH_PARAMS",
			kind: "CREATE_DASH_REPRESENTATION_MP4",
		});
	});
});

describe("DASH ContentProtection cURL from resolved request refs", () => {
	const resolved = {
		manifestId: "manifest-id",
		periodId: "period-id",
		adaptationSetId: "set-id",
		representationId: "representation-id",
		encodingId: "encoding-id",
		muxingId: "muxing-id",
		drmId: "drm-id",
	};
	function cp(
		representationKind: unknown,
		refs: Record<string, unknown> = resolved,
	) {
		const payload =
			representationKind === undefined ? {} : { representationKind };
		return step({
			kind: "CREATE_DASH_CONTENT_PROTECTION",
			payload,
			refs: Object.fromEntries(
				Object.keys(resolved).map((key) => [key, `step:${key}`]),
			),
			request: { ...payload, refs },
		});
	}
	it.each([
		undefined,
		"FMP4",
		"WEBM",
	])("reconstructs the exact %s endpoint and SDK body without selectors", (kind) => {
		const result = curlForStep(cp(kind));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.command).toContain(
			`/dash/manifest-id/periods/period-id/adaptationsets/set-id/representations/${kind === "WEBM" ? "webm" : "fmp4"}/representation-id/contentprotection'`,
		);
		expect(result.command).toContain(
			'"typeDiscriminator": "CONTENT_PROTECTION"',
		);
		expect(result.command).toContain('"drmId": "drm-id"');
		expect(result.command).toContain('"encodingId": "encoding-id"');
		expect(result.command).toContain('"muxingId": "muxing-id"');
		expect(result.command).not.toContain('"representationKind"');
		expect(result.command).not.toContain('"refs"');
		expect(result.command).not.toContain("step:");
	});
	it.each(
		Object.keys(resolved),
	)("fails closed when resolved %s is missing", (missing) => {
		const refs = Object.fromEntries(
			Object.entries(resolved).filter(([key]) => key !== missing),
		);
		expect(curlForStep(cp("WEBM", refs))).toEqual({
			ok: false,
			code: "UNRESOLVED_PATH_PARAMS",
			kind: "CREATE_DASH_CONTENT_PROTECTION",
		});
	});
	it.each([
		"MP4",
		"unknown",
		null,
	])("does not guess an endpoint for unsupported representationKind %s", (kind) => {
		expect(curlForStep(cp(kind))).toEqual({
			ok: false,
			code: "NO_ENDPOINT",
			kind: "CREATE_DASH_CONTENT_PROTECTION",
		});
	});
});

describe("curlForStep — POSIX shell variable headers", () => {
	it.each([
		false,
		true,
	])("expands synthetic header variables once without splitting arguments (org=%s)", (includeOrgHeader) => {
		const apiKey = [
			"synthetic key with spaces",
			"'single'",
			'"double"',
			"$BITMOVIN_TENANT_ORG_ID",
			"$(printf KEY_EXPANDED)",
			"`printf KEY_BACKTICK`",
			"; *",
		].join(" ");
		const orgId = [
			"synthetic org with spaces",
			"'single'",
			'"double"',
			"$BITMOVIN_API_KEY",
			"$(printf ORG_EXPANDED)",
			"`printf ORG_BACKTICK`",
			"; *",
		].join(" ");
		const baseUrl =
			"https://example.invalid/v1/quoted'path;$(printf URL_EXPANDED)";
		const body = {
			name: "literal 'quotes' and $(printf BODY_EXPANDED); `printf BODY_BACKTICK`",
			bucketName: "synthetic-bucket",
		};
		const result = curlForStep(
			step({ kind: "CREATE_INPUT_S3", request: { ...body, refs: {} } }),
			{ baseUrl, includeOrgHeader },
		);
		if (!result.ok) throw new Error("Expected runnable synthetic command");
		// This shell function captures argv; no curl executable or network is used.
		// Only these synthetic variables enter the child, never the parent's environment.
		const output = execFileSync(
			"/bin/sh",
			["-c", `curl() { printf '%s\\000' "$@"; }\n${result.command}`],
			{
				env: { BITMOVIN_API_KEY: apiKey, BITMOVIN_TENANT_ORG_ID: orgId },
				encoding: "utf8",
				timeout: 2000,
				maxBuffer: 65536,
			},
		);
		expect(output.endsWith("\0")).toBe(true);
		expect(output.split("\0").slice(0, -1)).toEqual([
			"-X",
			"POST",
			`${baseUrl}/encoding/inputs/s3`,
			"-H",
			`X-Api-Key: ${apiKey}`,
			...(includeOrgHeader ? ["-H", `X-Tenant-Org-Id: ${orgId}`] : []),
			"-H",
			"Content-Type: application/json",
			"--data",
			JSON.stringify(body, null, 2),
		]);
		expect(result.command).not.toContain(apiKey);
		expect(result.command).not.toContain(orgId);
	});
});
