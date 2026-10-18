import { describe, expect, it } from "vitest";
import { createRetryingFetch, isRetryable } from "./retrying-fetch";
import { createBitmovinSdkOps } from "./sdk-ops";

/**
 * The distinction that matters is REJECTED vs RESPONDED. A dropped connection is
 * worth another socket; a 4xx/5xx is the API's answer and repeating it is waste.
 */

function response(status: number): Response {
	return new Response("{}", { status });
}

/** A fetch that rejects for the first `failures` calls, then responds. */
function flaky(failures: number, error: Error = prematureClose()) {
	let calls = 0;
	const impl = async () => {
		calls += 1;
		if (calls <= failures) {
			throw error;
		}
		return response(201);
	};
	return { impl, calls: () => calls };
}

/** The shape undici actually produces: a wrapper whose `cause` holds the reason. */
function prematureClose(): Error {
	const err = new TypeError(
		"Invalid response body while trying to fetch https://api.bitmovin.com/v1/encoding/manifests/hls: Premature close",
	);
	(err as { cause?: unknown }).cause = Object.assign(
		new Error("Premature close"),
		{ code: "UND_ERR_SOCKET" },
	);
	return err;
}

const noSleep = async () => {};

describe("createRetryingFetch", () => {
	it("refuses RTMP reassignment retries with URL query/trailing slash, while preserving reads", () => {
		const path =
			"https://api.bitmovin.com/v1/encoding/live/encodings/owned/actions/update-rtmp-ingest-points";
		for (const url of [path, `${path}/`, `${path}?x=1`])
			expect(isRetryable(url, { method: "PATCH" })).toBe(false);
		expect(isRetryable(path, { method: "GET" })).toBe(true);
	});
	it("retries a transport rejection and returns the eventual response", async () => {
		const target = flaky(2);
		const warnings: string[] = [];
		const doFetch = createRetryingFetch({
			fetchImpl: target.impl,
			sleep: noSleep,
			warn: (m) => warnings.push(m),
		});

		const res = await doFetch(
			"https://api.bitmovin.com/v1/encoding/manifests/hls",
			{
				method: "POST",
			},
		);

		expect(res.status).toBe(201);
		expect(target.calls()).toBe(3);
		expect(warnings).toHaveLength(2);
		// The log names the method and url, and the cause undici buries.
		expect(warnings[0]).toContain("POST https://api.bitmovin.com");
		expect(warnings[0]).toContain("UND_ERR_SOCKET");
		expect(warnings[0]).toContain("retrying 1/2");
	});

	it("gives up after the attempt budget and rethrows the LAST error", async () => {
		const target = flaky(99);
		const doFetch = createRetryingFetch({
			fetchImpl: target.impl,
			sleep: noSleep,
			warn: () => {},
		});

		await expect(doFetch("https://x/y", { method: "POST" })).rejects.toThrow(
			/Premature close/,
		);
		// Three attempts, not four: `attempts` counts the first one.
		expect(target.calls()).toBe(3);
	});

	it("does NOT retry a response that arrived, whatever its status", async () => {
		for (const status of [400, 404, 409, 500, 503]) {
			let calls = 0;
			const doFetch = createRetryingFetch({
				fetchImpl: async () => {
					calls += 1;
					return response(status);
				},
				sleep: noSleep,
				warn: () => {},
			});

			const res = await doFetch("https://x/y", { method: "POST" });
			expect(res.status, `status ${status}`).toBe(status);
			expect(calls, `status ${status} must not be retried`).toBe(1);
		}
	});

	it("backs off exponentially from the base delay", async () => {
		const waits: number[] = [];
		const target = flaky(3);
		const doFetch = createRetryingFetch({
			attempts: 4,
			delayMs: 100,
			fetchImpl: target.impl,
			sleep: async (ms) => {
				waits.push(ms);
			},
			warn: () => {},
		});

		await doFetch("https://x/y", { method: "POST" });
		expect(waits).toEqual([100, 200, 400]);
	});

	it("attempts: 1 disables retrying entirely", async () => {
		const target = flaky(1);
		const doFetch = createRetryingFetch({
			attempts: 1,
			fetchImpl: target.impl,
			sleep: noSleep,
			warn: () => {},
		});

		await expect(doFetch("https://x/y")).rejects.toThrow(/Premature close/);
		expect(target.calls()).toBe(1);
	});

	it("reports GET when init carries no method", async () => {
		const warnings: string[] = [];
		const doFetch = createRetryingFetch({
			fetchImpl: flaky(1).impl,
			sleep: noSleep,
			warn: (m) => warnings.push(m),
		});

		await doFetch("https://x/y");
		expect(warnings[0]).toContain("GET https://x/y");
	});

	it("never blind-retries a verification-stamped create whose response was lost", async () => {
		const target = flaky(99);
		const doFetch = createRetryingFetch({
			fetchImpl: target.impl,
			sleep: noSleep,
			warn: () => {},
		});
		const init = {
			method: "POST",
			body: JSON.stringify({
				name: "paid verification encoding",
				customData: {
					bitovp: {
						job: "job-1",
						step: "encoding",
						verification: {
							key: "verify:run-1:s1:VOD_JOB",
							requestSha256: "b".repeat(64),
						},
					},
				},
			}),
		};

		await expect(
			doFetch("https://api.bitmovin.com/v1/encoding/encodings", init),
		).rejects.toThrow(/Premature close/);
		expect(target.calls()).toBe(1);
		expect(
			isRetryable("https://api.bitmovin.com/v1/encoding/encodings", init),
		).toBe(false);
	});
});

/**
 * The wrapper working proves nothing about the client USING it. This calls a real
 * `SdkOps` method with the global fetch stubbed to drop the first connection, so it
 * fails if the `fetch:` option is ever removed from `new BitmovinApi({…})` — which a
 * comment claiming the wiring exists would not.
 */
describe("createBitmovinSdkOps wiring", () => {
	it("survives a dropped connection on a real ops call", async () => {
		const original = globalThis.fetch;
		// Counted by METHOD, not in total: `createHlsManifest` also GETs the manifest
		// list (see reconciliation below), so a raw call count would move whenever that
		// lookup changes and would stop being about the retry at all.
		let posts = 0;
		globalThis.fetch = (async (_url: string, init?: { method?: string }) => {
			if ((init?.method ?? "GET") === "GET") {
				return new Response(
					JSON.stringify({ data: { result: { items: [], totalCount: 0 } } }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			posts += 1;
			if (posts === 1) {
				throw prematureClose();
			}
			return new Response(
				JSON.stringify({ data: { result: { id: "hls-1" } } }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}) as typeof globalThis.fetch;
		try {
			const ops = createBitmovinSdkOps({ apiKey: "probe-key" }, async () => {});
			const id = await ops.createHlsManifest({
				manifestName: "stream.m3u8",
				name: "HLS Manifest",
				// The plan carries the enum NAME; sdkEnumValue turns it into the wire
				// value "4" (goldens: `"masterVersion": "HLS_V4"`). Passing "4" here
				// threw `Unknown HlsVersion "4"` — my first draft of this test, not a bug.
				masterVersion: "HLS_V4",
				mediaVersion: "HLS_V4",
				destination: {
					outputId: "00000000-0000-0000-0000-000000000000",
					outputPath: "output/probe/",
					acl: "PUBLIC_READ",
				},
			});
			expect(id).toBe("hls-1");
			expect(posts, "the dropped POST must have been retried").toBe(2);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("createHlsManifest reconciliation", () => {
	const OUTPUT = "d006e483-91f6-450d-befc-e8685824ed7e";
	const params = {
		manifestName: "stream.m3u8",
		name: "HLS Manifest",
		masterVersion: "HLS_V4",
		mediaVersion: "HLS_V4",
		destination: {
			outputId: OUTPUT,
			outputPath: "output/x/",
			acl: "PUBLIC_READ",
		},
	};

	/** A list page holding `manifests`, and a POST that behaves per `onCreate`. */
	function stubApi(opts: {
		manifests: unknown[];
		onCreate?: () => Response | never;
		/** Return a Response (e.g. a 500) or throw, in place of the list page. */
		onList?: () => Response | never;
	}) {
		const calls: string[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (url: string, init?: { method?: string }) => {
			const method = init?.method ?? "GET";
			calls.push(`${method} ${new URL(url).pathname}`);
			if (method === "GET") {
				if (opts.onList) {
					return opts.onList();
				}
				return new Response(
					JSON.stringify({
						data: {
							result: {
								items: opts.manifests,
								totalCount: opts.manifests.length,
							},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (opts.onCreate) {
				return opts.onCreate();
			}
			throw new Error("unexpected POST");
		}) as typeof globalThis.fetch;
		return {
			calls,
			restore: () => {
				globalThis.fetch = original;
			},
		};
	}

	it("adopts an existing manifest instead of creating a second one", async () => {
		const stub = stubApi({
			manifests: [
				{
					id: "already-there",
					manifestName: "stream.m3u8",
					outputs: [{ outputId: OUTPUT, outputPath: "output/x/" }],
				},
			],
		});
		try {
			const ops = createBitmovinSdkOps({ apiKey: "k" }, async () => {});
			expect(await ops.createHlsManifest(params)).toBe("already-there");
			// The POST must never have happened — that is the whole point.
			expect(stub.calls.some((c) => c.startsWith("POST"))).toBe(false);
		} finally {
			stub.restore();
		}
	});

	it("does NOT adopt a manifest at a DIFFERENT path on the same output", async () => {
		/**
		 * The review catch, and the reason `outputPath` is in the key.
		 *
		 * Every one of the 66 VOD fixtures names its HLS manifest `stream.m3u8` — it is
		 * the schema default and the wizard's extra-manifest row literally hints
		 * `Default "stream.m3u8"` — and primary and extra manifests share one output. So
		 * name+output is not a discriminator in practice. Keyed on those two alone, a
		 * plan with an SDR and an HDR master created only the first, and hung the
		 * second's variants on it: a silent WRONG artefact, worse than the duplicate the
		 * adoption exists to prevent.
		 */
		const stub = stubApi({
			manifests: [
				{
					id: "sdr-master",
					manifestName: "stream.m3u8",
					outputs: [{ outputId: OUTPUT, outputPath: "output/sdr/" }],
				},
			],
			onCreate: () =>
				new Response(
					JSON.stringify({ data: { result: { id: "hdr-master" } } }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		});
		try {
			const ops = createBitmovinSdkOps({ apiKey: "k" }, async () => {});
			const hdr = await ops.createHlsManifest({
				...params,
				destination: { ...params.destination, outputPath: "output/hdr/" },
			});
			expect(hdr, "the HDR master must be its own resource").toBe("hdr-master");
			expect(stub.calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
		} finally {
			stub.restore();
		}
	});

	it("creates anyway when the lookup itself fails — a 503 must not fail the step", async () => {
		// The lookup is new, so it is a new way for this step to die. `createHlsManifest`
		// must not start REQUIRING a successful GET /encoding/manifests/hls: a transient
		// list 503, or an API key without manifest-list scope, would break the exact step
		// this hardening exists for.
		const stub = stubApi({
			onList: () =>
				new Response(JSON.stringify({ data: { message: "boom" } }), {
					status: 503,
					headers: { "Content-Type": "application/json" },
				}),
			manifests: [],
			onCreate: () =>
				new Response(JSON.stringify({ data: { result: { id: "fresh" } } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		});
		try {
			const ops = createBitmovinSdkOps({ apiKey: "k" }, async () => {});
			expect(await ops.createHlsManifest(params)).toBe("fresh");
			expect(
				stub.calls.filter((c) => c.startsWith("POST")),
				"the create must still have been attempted",
			).toHaveLength(1);
		} finally {
			stub.restore();
		}
	});

	it("is not masked by an id-less match earlier on the page", async () => {
		// `find`-then-test-id would have returned undefined here and created a duplicate.
		const stub = stubApi({
			manifests: [
				{
					manifestName: "stream.m3u8",
					outputs: [{ outputId: OUTPUT, outputPath: "output/x/" }],
				},
				{
					id: "the-real-one",
					manifestName: "stream.m3u8",
					outputs: [{ outputId: OUTPUT, outputPath: "output/x/" }],
				},
			],
		});
		try {
			const ops = createBitmovinSdkOps({ apiKey: "k" }, async () => {});
			expect(await ops.createHlsManifest(params)).toBe("the-real-one");
		} finally {
			stub.restore();
		}
	});

	it("creates when nothing matches this output", async () => {
		const stub = stubApi({
			// Same manifestName, DIFFERENT output — another job's manifest.
			manifests: [
				{
					id: "other-job",
					manifestName: "stream.m3u8",
					outputs: [{ outputId: "other", outputPath: "output/x/" }],
				},
			],
			onCreate: () =>
				new Response(JSON.stringify({ data: { result: { id: "fresh" } } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		});
		try {
			const ops = createBitmovinSdkOps({ apiKey: "k" }, async () => {});
			expect(await ops.createHlsManifest(params)).toBe("fresh");
			expect(stub.calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
		} finally {
			stub.restore();
		}
	});

	it("adopts after a lost response — the exact failure seen in production", async () => {
		let posted = false;
		const stub = stubApi({
			manifests: [],
			onCreate: () => {
				throw prematureClose();
			},
		});
		const original = globalThis.fetch;
		// Re-wrap: the manifest appears only AFTER the POST, as it does in reality.
		globalThis.fetch = (async (_url: string, init?: { method?: string }) => {
			const method = init?.method ?? "GET";
			if (method === "POST") {
				posted = true;
				throw prematureClose();
			}
			return new Response(
				JSON.stringify({
					data: {
						result: {
							items: posted
								? [
										{
											id: "created-anyway",
											manifestName: "stream.m3u8",
											outputs: [{ outputId: OUTPUT, outputPath: "output/x/" }],
										},
									]
								: [],
							totalCount: posted ? 1 : 0,
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof globalThis.fetch;
		try {
			const ops = createBitmovinSdkOps({ apiKey: "k" }, async () => {});
			expect(await ops.createHlsManifest(params)).toBe("created-anyway");
		} finally {
			globalThis.fetch = original;
			stub.restore();
		}
	});

	it("rethrows when the create failed AND nothing exists", async () => {
		const stub = stubApi({
			manifests: [],
			onCreate: () => {
				throw prematureClose();
			},
		});
		try {
			const ops = createBitmovinSdkOps({ apiKey: "k" }, async () => {});
			await expect(ops.createHlsManifest(params)).rejects.toThrow(
				/Premature close/,
			);
		} finally {
			stub.restore();
		}
	});
});

describe("a START is never retried — VOD or live", () => {
	/**
	 * The owner overruled the original trade, and the evidence is on their side.
	 *
	 * This wrapper's own header accepts that a lost POST response leaves a duplicate resource,
	 * "the same trade the orchestrator already takes on a resumed create step — accepted P1 risk:
	 * benign orphan resources". The premise is that a duplicate is INERT. That holds for a spare
	 * manifest and fails completely for anything that STARTS WORK.
	 *
	 * It failed in production: four live encodings ran for up to 7h19m, and the audit log shows
	 * `live/start` issued twice — 249ms apart, against two encodings — with byte-identical create
	 * payloads before them.
	 *
	 * "The outcome is unknown" is a reason to go and LOOK, not a reason to send it again.
	 */
	const rejectingFetch = () => {
		let calls = 0;
		return {
			calls: () => calls,
			fetchImpl: async () => {
				calls++;
				throw new Error("Premature close");
			},
		};
	};

	it.each([
		"live/start",
		"live/hd/start",
	])("sends %s exactly ONCE and propagates the rejection", async (path) => {
		const f = rejectingFetch();
		const fetchWithRetry = createRetryingFetch({
			attempts: 3,
			delayMs: 0,
			sleep: async () => {},
			warn: () => {},
			fetchImpl: f.fetchImpl,
		});
		await expect(
			fetchWithRetry(
				`https://api.bitmovin.com/v1/encoding/encodings/abc/${path}`,
				{ method: "POST" },
			),
		).rejects.toThrow(/Premature close/);
		expect(f.calls(), "a live start must be attempted once").toBe(1);
	});

	it("sends a VOD start exactly ONCE too", async () => {
		// The owner's instruction covers both: a double-started VOD encoding is a second billable
		// run just as surely, it merely ends by itself.
		const f = rejectingFetch();
		const fetchWithRetry = createRetryingFetch({
			attempts: 3,
			delayMs: 0,
			sleep: async () => {},
			warn: () => {},
			fetchImpl: f.fetchImpl,
		});
		await expect(
			fetchWithRetry(
				"https://api.bitmovin.com/v1/encoding/encodings/abc/start",
				{
					method: "POST",
				},
			),
		).rejects.toThrow();
		expect(f.calls()).toBe(1);
	});

	it("still retries the create that motivated the retry in the first place", async () => {
		/**
		 * `POST /encoding/manifests/hls` is where a real 26-step VOD job died on undici's
		 * `Premature close` over an idle pooled socket, and a duplicate manifest genuinely is
		 * inert. Removing the retry from every create would trade a measured failure for an
		 * unmeasured one, so the guard is a denylist of starts rather than "no POST retries".
		 */
		const f = rejectingFetch();
		const fetchWithRetry = createRetryingFetch({
			attempts: 3,
			delayMs: 0,
			sleep: async () => {},
			warn: () => {},
			fetchImpl: f.fetchImpl,
		});
		await expect(
			fetchWithRetry("https://api.bitmovin.com/v1/encoding/manifests/hls", {
				method: "POST",
			}),
		).rejects.toThrow();
		expect(f.calls(), "three attempts, as before").toBe(3);
	});

	it("classifies the shapes a URL can take, so a guard cannot be slipped past", () => {
		const START = "https://api.bitmovin.com/v1/encoding/encodings/abc/start";
		const LIVE =
			"https://api.bitmovin.com/v1/encoding/encodings/abc/live/start";
		expect(isRetryable(START, { method: "POST" })).toBe(false);
		expect(isRetryable(LIVE, { method: "POST" })).toBe(false);
		// A trailing slash and a query string must not open the gate.
		expect(isRetryable(`${LIVE}/`, { method: "POST" })).toBe(false);
		expect(isRetryable(`${LIVE}?x=1`, { method: "POST" })).toBe(false);
		// A GET of the same path is a read: always safe.
		expect(isRetryable(LIVE, { method: "GET" })).toBe(true);
		// And endpoints that merely CONTAIN the word are not starts.
		expect(
			isRetryable("https://api.bitmovin.com/v1/encoding/start-requests", {
				method: "POST",
			}),
		).toBe(true);
		expect(
			isRetryable("https://api.bitmovin.com/v1/encoding/encodings/abc/stop", {
				method: "POST",
			}),
		).toBe(true);
	});
});
