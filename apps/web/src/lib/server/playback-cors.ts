import "server-only";
import {
	checkPlaybackCors,
	declaredBaseFor,
	encodingPlanSchema,
	liveChannelPlanSchema,
	normalizeBaseUrl,
	type PlaybackCorsVerdict,
	planOutputBucket,
} from "@bitovp/core";
import { describeStorageError } from "@bitovp/storage";
import type { ServerContext } from "./context";
import { browserForCredentialId } from "./storage";

/**
 * "Is this manifest's bucket configured for in-browser playback?"
 *
 *
 * Keyed by JOB (or CHANNEL) + manifest key rather than by credential + bucket,
 * so the browser never needs a credential id to ask — PR 3 removed those from
 * the job page and this must not put them back. The server already holds the
 * plan, so it resolves manifest → output → credential → bucket itself.
 */
export type PlaybackCorsResult =
	| {
			supported: true;
			origin: string;
			bucket: string;
			verdict: PlaybackCorsVerdict;
	  }
	/**
	 * Why no verdict — never conflated with "the bucket has no CORS rules",
	 * which is itself a finding.
	 */
	| {
			supported: false;
			origin: string;
			reason:
				| "DRIVER"
				| "FORBIDDEN"
				| "NO_BUCKET"
				| "NOT_FOUND"
				/**
				 * A `publicBaseUrls` entry declares a CDN or custom domain in front of
				 * this bucket, so playback goes to that host — and this check can only
				 * see the ORIGIN bucket. A verdict about the bucket would be a verdict
				 * about a host the player never touches: `OK` on a correct bucket
				 * behind a CORS-stripping CDN, or a false alarm in the reverse case.
				 * Both are wrong answers to the question the panel exists to answer,
				 * and for a live channel it is currently 100% of cases (design §19.3).
				 */
				| "DECLARED_BASE";
	  };

/**
 * The page's own origin as the BROWSER sees it, which is what a bucket's
 * `AllowedOrigins` is matched against.
 *
 * DIAGNOSTIC ONLY — this must never become an authorization input. Reading a
 * header is not a trust boundary that a query parameter isn't: `Origin` and
 * `Referer` are equally settable by any non-browser client, and the request gate
 * constrains only the hostname, not the scheme or port, which are exactly what
 * distinguishes an origin to a bucket. It is never an AUTHORIZATION input — nothing
 * is granted or denied by it — but "only ever rendered back to the operator" was too
 * narrow (review catch): it is also a COMPARISON input, reaching `checkPlaybackCors`
 * → `originMatches`, where it is string-matched against the bucket's own
 * `AllowedOrigins`. That reach is allowlist-shaped, which is precisely the place a
 * future reader who believed "only rendered" could relocate it unsafely.
 * `Origin` is absent on same-origin GETs, so `Referer` carries it in the normal
 * case; the request URL is the last resort and the one a scheme-rewriting proxy
 * can make wrong, which is why the forwarded headers are consulted first.
 */
export function pageOrigin(req: Request): string {
	const origin = req.headers.get("origin");
	if (origin && origin !== "null") {
		return origin;
	}
	const referer = req.headers.get("referer");
	if (referer) {
		try {
			return new URL(referer).origin;
		} catch {
			// Malformed Referer — fall through.
		}
	}
	const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
	const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
	// Scheme constrained to the two that can carry a manifest. Unvalidated, the pair
	// `x-forwarded-proto: javascript` + `x-forwarded-host: evil.tld` produced
	// `"javascript://evil.tld"` (review measured it) — diagnostic-only output, but
	// this is the branch the docblock above already flags as proxy-corruptible, and a
	// scheme-shaped string is the one part of it that could travel.
	if ((proto === "http" || proto === "https") && host) {
		return `${proto}://${host}`;
	}
	return new URL(req.url).origin;
}

/** VOD jobs and live channels hold their plans in different tables. */
export type PlaybackScope = "vod" | "live";

export async function playbackCorsForManifest(
	ctx: ServerContext,
	args: {
		scope: PlaybackScope;
		id: string;
		manifestKey: string;
		origin: string;
	},
): Promise<PlaybackCorsResult> {
	const { origin } = args;
	const row =
		args.scope === "live"
			? await ctx.prisma.liveChannel.findUnique({
					where: { id: args.id },
					select: { plan: true },
				})
			: await ctx.prisma.encodingJob.findUnique({
					where: { id: args.id },
					select: { plan: true },
				});
	if (!row) {
		return { supported: false, origin, reason: "NOT_FOUND" };
	}
	const parsed =
		args.scope === "live"
			? liveChannelPlanSchema.safeParse(row.plan)
			: encodingPlanSchema.safeParse(row.plan);
	if (!parsed.success) {
		return { supported: false, origin, reason: "NOT_FOUND" };
	}
	const manifests =
		"liveManifests" in parsed.data
			? parsed.data.liveManifests
			: parsed.data.manifests;
	const manifest = manifests.find((m) => m.key === args.manifestKey);
	const output = manifest
		? parsed.data.outputs.find((o) => o.key === manifest.destination.outputKey)
		: undefined;
	if (!manifest || !output) {
		return { supported: false, origin, reason: "NOT_FOUND" };
	}
	if (output.kind === "AKAMAI_MSL") {
		// The MSL link IS served over HTTP — the credential's `edgeBaseUrl`
		// (2026-09-02) — but its CORS belongs to the Akamai property in front
		// of the stream, which this app cannot read. DRIVER ("neither confirmed
		// nor ruled out") is the true answer; NO_BUCKET's "not served over
		// HTTP" would be false the moment a viewer's player errors on the edge.
		return { supported: false, origin, reason: "DRIVER" };
	}
	const bucket = planOutputBucket(output);
	if (!bucket || !("credentialId" in output)) {
		// SFTP: no bucket, and nothing HTTP-addressable to have CORS about.
		// NetStorage: the account is the container; no bucket to ask about.
		return { supported: false, origin, reason: "NO_BUCKET" };
	}

	/**
	 * Decline BEFORE the secret is decrypted, in the one case where the answer
	 * could not have been trustworthy anyway — passed into the store as a hook so
	 * the early exit costs no extra read on the common path.
	 *
	 * The test is presence AND validity: the same condition that makes
	 * `publicObjectUrl` report `via: "publicBaseUrls"`. A declared-but-unusable
	 * base yields `MISSING_BASE_URL` and no URL at all, so playback never happens
	 * and the operator should see that precise error rather than this one.
	 */
	const browser = await browserForCredentialId(
		ctx,
		output.credentialId,
		(config) => {
			const declared = declaredBaseFor(config, bucket);
			return declared !== undefined && normalizeBaseUrl(declared) !== null;
		},
	);
	if (browser === "stopped") {
		return { supported: false, origin, reason: "DECLARED_BASE" };
	}
	if (!browser) {
		return { supported: false, origin, reason: "NOT_FOUND" };
	}
	try {
		if (!browser.getBucketCors) {
			// Azure and GCS hold CORS behind their own APIs; until those drivers
			// implement it the honest answer is "unknown", which is NOT "no rules".
			return { supported: false, origin, reason: "DRIVER" };
		}
		const rules = await browser.getBucketCors(bucket);
		return {
			supported: true,
			origin,
			bucket,
			verdict: checkPlaybackCors(rules, { origin }),
		};
	} catch (err) {
		// Reading CORS needs its own permission (s3:GetBucketCORS). A key without
		// it is a common, benign configuration — reporting that as a storage
		// failure would turn "we cannot check" into "your storage is broken".
		if (describeStorageError(err).status === 403) {
			return { supported: false, origin, reason: "FORBIDDEN" };
		}
		throw err;
	} finally {
		browser.dispose?.();
	}
}
