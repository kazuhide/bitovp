import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publicObjectUrl } from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import { pageOrigin, playbackCorsForManifest } from "./playback-cors";

const browserForCredentialId = vi.fn();
/**
 * The config the mocked store would have loaded. The declared-base decision is now
 * passed INTO `browserForCredentialId` as a `stopIf` hook — so that it runs before
 * the secret is decrypted — which means a mock that ignores the hook would report
 * "no early exit" no matter what the config says. `mockStore` below models the
 * contract instead: run the hook, return "stopped" when it says so.
 */
let credentialConfig: Record<string, unknown> = {};
vi.mock("./storage", async () => {
	const actual = await vi.importActual<typeof import("./storage")>("./storage");
	return {
		...actual,
		browserForCredentialId: (...args: unknown[]) =>
			browserForCredentialId(...args),
	};
});

const PLAN = JSON.parse(
	readFileSync(
		join(
			__dirname,
			"../../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
		),
		"utf8",
	),
) as {
	manifests: { key: string }[];
	outputs: { credentialId: string; bucket?: string }[];
};

const MANIFEST_KEY = PLAN.manifests[0]?.key ?? "";
const BUCKET = PLAN.outputs[0]?.bucket ?? "";
const ORIGIN = "http://localhost:3100";

/**
 * The credential config no longer comes from `prisma` here — it reaches the code
 * through `browserForCredentialId`'s `stopIf` hook, so it is handed to `mockStore`
 * via the module-level `credentialConfig`. Naming this parameter `credentialConfig`
 * shadowed that variable and silently disarmed every declared-base assertion.
 */
function ctxFor(
	plan: unknown,
	config: Record<string, unknown> = {},
): ServerContext {
	credentialConfig = config;
	return {
		prisma: {
			encodingJob: { findUnique: vi.fn(async () => (plan ? { plan } : null)) },
		},
	} as unknown as ServerContext;
}

const dispose = vi.fn();

function driver(over: Record<string, unknown> = {}) {
	return { dispose, ...over };
}

/** Honours the `stopIf` hook exactly as the real store does. */
function mockStore(result: unknown) {
	browserForCredentialId.mockImplementation(
		async (
			_ctx: unknown,
			_id: string,
			stopIf?: (config: Record<string, unknown>) => boolean,
		) => (stopIf?.(credentialConfig) ? "stopped" : result),
	);
}

beforeEach(() => {
	// `mockReset`, not `clearAllMocks`: the latter clears calls but NOT
	// implementations, so a `mockImplementation`/`mockResolvedValueOnce` set in one
	// test silently serves the next. That has now bitten this file twice.
	browserForCredentialId.mockReset();
	vi.clearAllMocks();
	credentialConfig = {};
});

describe("playbackCorsForManifest", () => {
	it("resolves manifest → output → credential → bucket and returns the verdict", async () => {
		const getBucketCors = vi.fn(async () => [
			{
				allowedOrigins: ["*"],
				allowedMethods: ["GET"],
				allowedHeaders: ["*"],
				exposeHeaders: [],
			},
		]);
		mockStore(driver({ getBucketCors }));

		const result = await playbackCorsForManifest(ctxFor(PLAN), {
			scope: "vod",
			id: "job-1",
			manifestKey: MANIFEST_KEY,
			origin: ORIGIN,
		});

		// The bucket has to come from the PLAN, not from the caller.
		expect(getBucketCors).toHaveBeenCalledWith(BUCKET);
		expect(result).toEqual({
			supported: true,
			origin: ORIGIN,
			bucket: BUCKET,
			verdict: {
				code: "MISSING_EXPOSE_HEADERS",
				headers: ["content-range", "accept-ranges", "content-length"],
			},
		});
		// Sockets are pooled; a leaked driver leaks them.
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("reports DRIVER, not 'no rules', when the provider cannot be asked", async () => {
		// Azure/GCS: the difference between "unknown" and "misconfigured" is the
		// whole point — conflating them would send an operator to fix a bucket
		// that is already correct.
		mockStore(driver());
		const result = await playbackCorsForManifest(ctxFor(PLAN), {
			scope: "vod",
			id: "job-1",
			manifestKey: MANIFEST_KEY,
			origin: ORIGIN,
		});
		expect(result).toEqual({
			supported: false,
			origin: ORIGIN,
			reason: "DRIVER",
		});
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("reports FORBIDDEN for a key without s3:GetBucketCORS", async () => {
		const denied = Object.assign(new Error("AccessDenied"), {
			name: "AccessDenied",
			$metadata: { httpStatusCode: 403 },
		});
		mockStore(
			driver({
				getBucketCors: vi.fn(async () => {
					throw denied;
				}),
			}),
		);
		const result = await playbackCorsForManifest(ctxFor(PLAN), {
			scope: "vod",
			id: "job-1",
			manifestKey: MANIFEST_KEY,
			origin: ORIGIN,
		});
		expect(result).toMatchObject({ supported: false, reason: "FORBIDDEN" });
	});

	it("rethrows a genuine storage failure so the route can 502 it", async () => {
		const boom = Object.assign(new Error("kaboom"), {
			$metadata: { httpStatusCode: 500 },
		});
		mockStore(
			driver({
				getBucketCors: vi.fn(async () => {
					throw boom;
				}),
			}),
		);
		await expect(
			playbackCorsForManifest(ctxFor(PLAN), {
				scope: "vod",
				id: "job-1",
				manifestKey: MANIFEST_KEY,
				origin: ORIGIN,
			}),
		).rejects.toThrow("kaboom");
		// Still disposed on the throwing path.
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("NOT_FOUNDs a missing job, plan, or manifest key without building a driver", async () => {
		for (const [label, ctx, key] of [
			["missing job", ctxFor(null), MANIFEST_KEY],
			["unparseable plan", ctxFor({ planVersion: 1 }), MANIFEST_KEY],
			["unknown manifest key", ctxFor(PLAN), "no-such-manifest"],
		] as const) {
			const result = await playbackCorsForManifest(ctx, {
				scope: "vod",
				id: "job-1",
				manifestKey: key,
				origin: ORIGIN,
			});
			expect(result, label).toEqual({
				supported: false,
				origin: ORIGIN,
				reason: "NOT_FOUND",
			});
		}
		// No credential was decrypted for any of them.
		expect(browserForCredentialId).not.toHaveBeenCalled();
	});

	it("reports NO_BUCKET for an output that is not HTTP-addressable", async () => {
		const plan = JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../../packages/core/src/plan/__fixtures__/dash-hls-sftp-output-just-in-time.plan.json",
				),
				"utf8",
			),
		) as { manifests: { key: string }[] };
		const result = await playbackCorsForManifest(ctxFor(plan), {
			scope: "vod",
			id: "job-1",
			manifestKey: plan.manifests[0]?.key ?? "",
			origin: ORIGIN,
		});
		expect(result).toMatchObject({ supported: false, reason: "NO_BUCKET" });
		expect(browserForCredentialId).not.toHaveBeenCalled();
	});
});

describe("pageOrigin", () => {
	function req(headers: Record<string, string>): Request {
		return new Request("http://internal:3000/api/x", { headers });
	}

	it("prefers the Origin header", () => {
		expect(pageOrigin(req({ origin: "https://ovp.example.com" }))).toBe(
			"https://ovp.example.com",
		);
	});

	it("falls back to the Referer's origin — same-origin GETs send no Origin", () => {
		expect(
			pageOrigin(req({ referer: "https://ovp.example.com/vod/jobs/1" })),
		).toBe("https://ovp.example.com");
	});

	it("ignores a literal null Origin and a malformed Referer", () => {
		expect(pageOrigin(req({ origin: "null", referer: "not a url" }))).toBe(
			"http://internal:3000",
		);
	});

	it("uses the forwarded headers before the request URL", () => {
		// Behind a TLS-terminating proxy the request URL's scheme is the INTERNAL
		// one, and a verdict compared against http:// when the browser sent
		// https:// would be wrong in the direction that reports a false problem.
		expect(
			pageOrigin(
				req({
					"x-forwarded-proto": "https, http",
					"x-forwarded-host": "ovp.example.com, internal",
				}),
			),
		).toBe("https://ovp.example.com");
	});

	it("last resort is the request URL's own origin", () => {
		expect(pageOrigin(req({}))).toBe("http://internal:3000");
	});
});

describe("playbackCorsForManifest — the live scope", () => {
	const LIVE_PLAN = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
			),
			"utf8",
		),
	) as { liveManifests: { key: string }[]; outputs: { bucket?: string }[] };

	function liveCtx(plan: unknown): ServerContext {
		return {
			prisma: {
				liveChannel: {
					findUnique: vi.fn(async () => (plan ? { plan } : null)),
				},
				// No declared base in these rows, so the bucket is still the host.
				credential: { findUnique: vi.fn(async () => ({ config: {} })) },
				// If the live scope read this table the test would still pass with a
				// VOD plan, so it is deliberately absent.
			},
		} as unknown as ServerContext;
	}

	it("reads the CHANNEL table and the live plan's own manifest list", async () => {
		const getBucketCors = vi.fn(async () => null);
		mockStore(driver({ getBucketCors }));
		const result = await playbackCorsForManifest(liveCtx(LIVE_PLAN), {
			scope: "live",
			id: "chan-1",
			manifestKey: LIVE_PLAN.liveManifests[0]?.key ?? "",
			origin: ORIGIN,
		});
		expect(getBucketCors).toHaveBeenCalledWith(LIVE_PLAN.outputs[0]?.bucket);
		// A bucket with no CORS configuration at all — the finding, not an error.
		expect(result).toMatchObject({
			supported: true,
			verdict: { code: "NO_RULES" },
		});
	});

	it("does not resolve a VOD manifest key against a live channel", async () => {
		const result = await playbackCorsForManifest(liveCtx(LIVE_PLAN), {
			scope: "live",
			id: "chan-1",
			manifestKey: "no-such-manifest",
			origin: ORIGIN,
		});
		expect(result).toMatchObject({ supported: false, reason: "NOT_FOUND" });
		expect(browserForCredentialId).not.toHaveBeenCalled();
	});

	it("NOT_FOUNDs a VOD plan asked for through the live scope", async () => {
		// The two schemas are different; a mis-scoped request must not half-work.
		const result = await playbackCorsForManifest(liveCtx(PLAN), {
			scope: "live",
			id: "chan-1",
			manifestKey: MANIFEST_KEY,
			origin: ORIGIN,
		});
		expect(result).toMatchObject({ supported: false, reason: "NOT_FOUND" });
	});

	it("answers DRIVER, not NO_BUCKET, for an Akamai MSL manifest — the edge IS served over HTTP", async () => {
		/**
		 * Since the credential's `edgeBaseUrl` (2026-09-02) an MSL link is
		 * playable, so a player error reaches this diagnosis. NO_BUCKET renders
		 * "not served over HTTP", which is false of the Akamai edge; DRIVER's
		 * "neither confirmed nor ruled out" is the true answer, because the
		 * property's CORS is Akamai's and this app cannot read it.
		 */
		const MSL_PLAN = JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../../packages/core/src/live/__fixtures__/live-akamai-msl.plan.json",
				),
				"utf8",
			),
		) as { liveManifests: { key: string }[] };
		const result = await playbackCorsForManifest(liveCtx(MSL_PLAN), {
			scope: "live",
			id: "chan-1",
			manifestKey: MSL_PLAN.liveManifests[0]?.key ?? "",
			origin: ORIGIN,
		});
		expect(result).toMatchObject({ supported: false, reason: "DRIVER" });
		// And no credential is decrypted for a question it cannot answer.
		expect(browserForCredentialId).not.toHaveBeenCalled();
	});
});

describe("playbackCorsForManifest — a declared base makes the bucket the wrong host", () => {
	/**
	 * `publicBaseUrls` exists to declare a CDN or custom domain in FRONT of the
	 * bucket, and this check can only read the origin bucket. A verdict about the
	 * bucket is therefore a verdict about a host the player never touches: `OK` on a
	 * correct bucket behind a CORS-stripping CDN, or a false alarm in reverse. For a
	 * live channel it is 100% of cases today, since a declared base is the only route
	 * to a playable live URL (design §19.3).
	 */
	it("declines to claim, and never asks storage", async () => {
		/**
		 * The store mock honours `stopIf`, so this exercises the real contract: the
		 * hook fires, the store stops, and `getBucketCors` is never reached. That the
		 * SECRET is never decrypted is a property of `browserForCredentialId` itself
		 * and is asserted in `storage.test.ts`, where it can be observed.
		 */
		const getBucketCors = vi.fn(async () => null);
		mockStore(driver({ getBucketCors }));
		const result = await playbackCorsForManifest(
			ctxFor(PLAN, {
				publicBaseUrls: { [BUCKET]: "https://cdn.example.com/vod" },
			}),
			{ scope: "vod", id: "job-1", manifestKey: MANIFEST_KEY, origin: ORIGIN },
		);
		expect(result).toEqual({
			supported: false,
			origin: ORIGIN,
			reason: "DECLARED_BASE",
		});
		expect(getBucketCors).not.toHaveBeenCalled();
	});

	it("still checks the bucket when the declared base is for ANOTHER bucket", async () => {
		const getBucketCors = vi.fn(async () => null);
		mockStore(driver({ getBucketCors }));
		const result = await playbackCorsForManifest(
			ctxFor(PLAN, {
				publicBaseUrls: { "some-other-bucket": "https://x.dev" },
			}),
			{ scope: "vod", id: "job-1", manifestKey: MANIFEST_KEY, origin: ORIGIN },
		);
		expect(result).toMatchObject({ supported: true });
		expect(getBucketCors).toHaveBeenCalledWith(BUCKET);
	});

	it("checks the bucket when the declared base is UNUSABLE", async () => {
		/**
		 * Presence is not the test — validity is. A base that fails
		 * `normalizeBaseUrl` produces no playable URL at all, so the operator should
		 * see `MISSING_BASE_URL` from the link rather than "no verdict given" here.
		 */
		const getBucketCors = vi.fn(async () => null);
		mockStore(driver({ getBucketCors }));
		const result = await playbackCorsForManifest(
			ctxFor(PLAN, { publicBaseUrls: { [BUCKET]: "cdn.example.com" } }),
			{ scope: "vod", id: "job-1", manifestKey: MANIFEST_KEY, origin: ORIGIN },
		);
		expect(result).toMatchObject({ supported: true });
		expect(getBucketCors).toHaveBeenCalledWith(BUCKET);
	});
});

describe("DECLARED_BASE is reachable exactly when the declared base decides the host", () => {
	/**
	 * I claimed this equivalence in prose when I wrote the check and could not point
	 * at a measurement for it, so here it is as one.
	 *
	 * The invariant: the CORS helper declines with `DECLARED_BASE` for exactly the
	 * configurations in which `publicObjectUrl` reports `via: "publicBaseUrls"` — the
	 * two decisions are the same decision, taken in two files. If they ever diverge,
	 * the panel either declines about a bucket that IS the playback host (a withheld
	 * answer) or answers about one that is not (a wrong answer).
	 */
	const configs: { name: string; config: Record<string, unknown> }[] = [
		{
			name: "a usable base for this bucket",
			config: { publicBaseUrls: { [BUCKET]: "https://cdn.example.com/vod" } },
		},
		{
			name: "an UNUSABLE base for this bucket",
			config: { publicBaseUrls: { [BUCKET]: "cdn.example.com" } },
		},
		{
			name: "a base with URL userinfo (refused by the validator)",
			config: { publicBaseUrls: { [BUCKET]: "https://u:p@cdn.example.com" } },
		},
		{
			name: "a base for a DIFFERENT bucket",
			config: {
				publicBaseUrls: { "some-other-bucket": "https://cdn.example.com" },
			},
		},
		{ name: "no publicBaseUrls at all", config: {} },
		{
			name: "a prototype-key entry that is not this bucket",
			config: { publicBaseUrls: { constructor: "https://cdn.example.com" } },
		},
	];

	for (const { name, config } of configs) {
		it(name, async () => {
			const derived = publicObjectUrl({
				credential: {
					provider: "AWS_S3",
					config: { region: "eu-west-1", ...config },
				},
				bucket: BUCKET,
				key: "out/stream.m3u8",
				acl: "PUBLIC_READ",
			});
			mockStore(driver({ getBucketCors: vi.fn(async () => null) }));
			const verdict = await playbackCorsForManifest(
				ctxFor(PLAN, { region: "eu-west-1", ...config }),
				{
					scope: "vod",
					id: "job-1",
					manifestKey: MANIFEST_KEY,
					origin: ORIGIN,
				},
			);
			const declined =
				verdict.supported === false && verdict.reason === "DECLARED_BASE";
			expect(declined, `${name}: via=${derived.via}`).toBe(
				derived.via === "publicBaseUrls",
			);
		});
	}
});
