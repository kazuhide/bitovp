import { describe, expect, it, vi } from "vitest";
import { createStampingFetch } from "./stamping-fetch";

/**
 * 's stamp, at its one seam. Each case is a boundary of the gate:
 * the wrapper must stamp exactly the eligible creates and pass EVERYTHING
 * else through byte-identical — a stamp on a start request is a 400 in
 * production, and an altered non-create body is corruption.
 */

const CREATE_URL = "https://api.bitmovin.com/v1/encoding/inputs/s3";

function harness(
	step: string | null = "input:main",
	verification?: { key: string; requestSha256: string },
) {
	// null, not undefined: `harness(undefined)` would trigger the DEFAULT
	// parameter — the classic gotcha this very test tripped on first run.
	const inner = vi.fn(async (_url: string, _init?: unknown) => {
		return new Response("{}", { status: 200 });
	});
	const fetch = createStampingFetch(inner, {
		jobId: "job-1",
		currentStep: () => step ?? undefined,
		verification,
	});
	return { inner, fetch };
}

function sentBody(inner: ReturnType<typeof vi.fn>): unknown {
	const init = inner.mock.calls[0]?.[1] as { body?: string };
	return init?.body === undefined ? undefined : JSON.parse(init.body);
}

describe("createStampingFetch", () => {
	it("stamps an eligible create with job + step under the bitovp key", async () => {
		const { inner, fetch } = harness();
		await fetch(CREATE_URL, {
			method: "POST",
			body: JSON.stringify({ name: "S3 in", bucketName: "b" }),
		});
		expect(sentBody(inner)).toEqual({
			name: "S3 in",
			bucketName: "b",
			customData: { bitovp: { job: "job-1", step: "input:main" } },
		});
	});

	it("binds a verification create to the exact durable key and canonical request SHA", async () => {
		const verification = {
			key: "verify:run-1:scenario-1:VOD_JOB",
			requestSha256: "a".repeat(64),
		};
		const { inner, fetch } = harness("encoding", verification);
		await fetch("https://api.bitmovin.com/v1/encoding/encodings", {
			method: "POST",
			body: JSON.stringify({ name: "verification encoding" }),
		});
		expect(sentBody(inner)).toMatchObject({
			customData: {
				bitovp: {
					job: "job-1",
					step: "encoding",
					verification,
				},
			},
		});
	});

	it("never overwrites customData the plan itself provided", async () => {
		const { inner, fetch } = harness();
		const body = JSON.stringify({ name: "x", customData: { mine: 1 } });
		await fetch(CREATE_URL, { method: "POST", body });
		expect(inner).toHaveBeenCalledWith(CREATE_URL, {
			method: "POST",
			body,
		});
	});

	it("passes a START request through untouched — a stamp there is a 400", async () => {
		const { inner, fetch } = harness("start");
		const body = JSON.stringify({ trimming: undefined });
		const init = { method: "POST", body };
		await fetch(
			"https://api.bitmovin.com/v1/encoding/encodings/e1/start",
			init,
		);
		expect(inner).toHaveBeenCalledWith(
			"https://api.bitmovin.com/v1/encoding/encodings/e1/start",
			init,
		);
	});

	/**
	 * The measured one (2026-08-15). An output stamp is not a 400 and not a
	 * silent discard — the create succeeds, and then every JIT manifest start
	 * on that output answers 500/1004. Isolated to this single variable
	 * against the real API: all-stamped 1004, output-excluded 202,
	 * output-only-stamped 1004, and the fix re-proved 202 through the same
	 * product code path. The S3Output MODEL carries customData, so no
	 * model-derived pin can find this — only the deny-list can, which is why
	 * the test states the consequence rather than the shape.
	 */
	it("passes OUTPUT creates through untouched — a stamp there breaks JIT manifest generation", async () => {
		// SIX, not five (review-208b I6): gcs-service-account is the only
		// hyphenated multi-token segment — the member most likely to break a
		// path-shape assumption, and the one the first cut left out.
		for (const kind of [
			"s3",
			"gcs",
			"gcs-service-account",
			"azure",
			"sftp",
			"generic-s3",
		]) {
			const { inner, fetch } = harness("output:origin");
			const init = { method: "POST", body: JSON.stringify({ name: "out" }) };
			const url = `https://api.bitmovin.com/v1/encoding/outputs/${kind}`;
			await fetch(url, init);
			expect(inner, `${kind} output must not be stamped`).toHaveBeenCalledWith(
				url,
				init,
			);
		}
	});

	it("still stamps INPUT creates — proven harmless in the same isolation", async () => {
		const { inner, fetch } = harness("input:main");
		await fetch("https://api.bitmovin.com/v1/encoding/inputs/s3", {
			method: "POST",
			body: JSON.stringify({ name: "in" }),
		});
		const sent = inner.mock.calls[0]?.[1] as { body: string };
		expect(JSON.parse(sent.body)).toMatchObject({
			customData: { bitovp: { step: "input:main" } },
		});
	});

	it("passes every no-customData family through untouched — pinned against the SDK itself", async () => {
		// The deny-list's authority is the SDK's own generated constructors: they
		// copy only DECLARED fields, so `new Model({customData}).customData ===
		// undefined` proves the model cannot carry the stamp. Each entry pairs a
		// denied path with its model; an SDK upgrade that grows customData on one
		// of these fails HERE by name, telling us to un-deny it (exactly how
		// /keyframes was wrongly denied at first — Keyframe DOES extend
		// BitmovinResource; review of PR #163, I1).
		const sdk = await import("@bitmovin/api-sdk");
		const DENIED: Array<[string, new (o: object) => object]> = [
			[
				"https://api.bitmovin.com/v1/encoding/encodings/e1/kantar-watermark",
				sdk.KantarWatermark,
			],
			[
				"https://api.bitmovin.com/v1/encoding/manifests/dash/m1/periods",
				sdk.Period,
			],
			[
				"https://api.bitmovin.com/v1/encoding/manifests/dash/m1/periods/p1/adaptationsets/video",
				sdk.VideoAdaptationSet,
			],
			[
				"https://api.bitmovin.com/v1/encoding/manifests/dash/m1/periods/p1/adaptationsets/a1/representations/fmp4",
				sdk.DashFmp4Representation,
			],
			[
				"https://api.bitmovin.com/v1/encoding/manifests/dash/m1/periods/p1/adaptationsets/a1/representations/fmp4/r1/contentprotection",
				sdk.ContentProtection,
			],
			[
				"https://api.bitmovin.com/v1/encoding/manifests/hls/m1/media/audio",
				sdk.AudioMediaInfo,
			],
			[
				"https://api.bitmovin.com/v1/encoding/encodings/e1/live/scte-35-cue",
				sdk.Scte35Cue,
			],
			[
				"https://api.bitmovin.com/v1/encoding/encodings/e1/live/reset-live-manifest-timeshift",
				sdk.ResetLiveManifestTimeShift,
			],
			[
				"https://api.bitmovin.com/v1/encoding/encodings/e1/customData",
				// No POST model exists (all 128 customData endpoints are GETs);
				// the entry is belt, probed against a knowably-bare class.
				sdk.ResetLiveManifestTimeShift,
			],
		];
		const { inner, fetch } = harness();
		for (const [url, Model] of DENIED) {
			// The premise, per entry: the model really cannot carry customData.
			const probe = new Model({ customData: { probe: 1 } }) as {
				customData?: unknown;
			};
			expect(probe.customData, url).toBeUndefined();
			await fetch(url, { method: "POST", body: "{}" });
		}
		for (const call of inner.mock.calls) {
			expect((call[1] as { body: string }).body).toBe("{}");
		}
	});

	it("STAMPS the families whose models carry customData — smooth and keyframes stay in", async () => {
		// The other direction of the same pin: paths that LOOK deniable but whose
		// models support the stamp must not be denied. Smooth's representation and
		// contentprotection models both extend BitmovinResource (narrower than the
		// review's first table), and Keyframe does too.
		const sdk = await import("@bitmovin/api-sdk");
		const STAMPED: Array<[string, new (o: object) => object]> = [
			[
				"https://api.bitmovin.com/v1/encoding/manifests/smooth/m1/representations/mp4",
				sdk.SmoothStreamingRepresentation,
			],
			[
				"https://api.bitmovin.com/v1/encoding/manifests/smooth/m1/contentprotection",
				sdk.SmoothManifestContentProtection,
			],
			[
				"https://api.bitmovin.com/v1/encoding/encodings/e1/keyframes",
				sdk.Keyframe,
			],
		];
		const { inner, fetch } = harness();
		for (const [url, Model] of STAMPED) {
			const probe = new Model({ customData: { probe: 1 } }) as {
				customData?: unknown;
			};
			expect(probe.customData, url).toBeDefined();
			await fetch(url, { method: "POST", body: JSON.stringify({ name: "x" }) });
		}
		for (const call of inner.mock.calls) {
			const body = JSON.parse((call[1] as { body: string }).body) as {
				customData?: unknown;
			};
			expect(body.customData, String(call[0])).toBeDefined();
		}
	});

	it("stamps nothing outside /v1/encoding/", async () => {
		const { inner, fetch } = harness();
		const body = JSON.stringify({ name: "x" });
		await fetch("https://api.bitmovin.com/v1/analytics/queries", {
			method: "POST",
			body,
		});
		expect((inner.mock.calls[0]?.[1] as { body: string }).body).toBe(body);
	});

	it("stamps nothing when NO step is executing — polls and finalize traffic", async () => {
		const { inner, fetch } = harness(null);
		const body = JSON.stringify({ name: "x" });
		await fetch(CREATE_URL, { method: "POST", body });
		expect((inner.mock.calls[0]?.[1] as { body: string }).body).toBe(body);
	});

	it("leaves GETs and non-JSON bodies alone", async () => {
		const { inner, fetch } = harness();
		await fetch(CREATE_URL);
		await fetch(CREATE_URL, { method: "POST", body: "not json" });
		expect(inner.mock.calls[0]?.[1]).toBeUndefined();
		expect((inner.mock.calls[1]?.[1] as { body: string }).body).toBe(
			"not json",
		);
	});

	it("reads the step at CALL time, not construction time", async () => {
		// The processor mutates one slot per job; the wrapper must see the value
		// of the step DURING which the SDK call happens.
		let step: string | undefined = "step-a";
		const inner = vi.fn(async (_url: string, _init?: unknown) => {
			return new Response("{}", { status: 200 });
		});
		const fetch = createStampingFetch(inner, {
			jobId: "j",
			currentStep: () => step,
		});
		await fetch(CREATE_URL, { method: "POST", body: "{}" });
		step = "step-b";
		await fetch(CREATE_URL, { method: "POST", body: "{}" });
		const bodies = inner.mock.calls.map(
			(call) =>
				(
					JSON.parse((call[1] as { body: string }).body) as {
						customData: { bitovp: { step: string } };
					}
				).customData["bitovp"].step,
		);
		expect(bodies).toEqual(["step-a", "step-b"]);
	});
});
