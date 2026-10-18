/**
 * The idempotency stamp for create ops — 's first half.
 *
 * A create step whose response was lost re-POSTs on resume, and if the first
 * POST reached Bitmovin the account keeps an inert duplicate. This wrapper
 * stamps every eligible create with `customData: { "bitovp": { job, step } }`
 * at ONE seam — the SDK's fetch — so the duplicates become identifiable (and,
 * in the second half, adoptable) without touching the executor's seventy
 * CREATE_ cases or the compiler's golden payloads. The stamp is RUNTIME
 * identity; the plan cannot know it, which is why this cannot live in the
 * compiler.
 *
 * What gets stamped: POST bodies under `/v1/encoding/` that are JSON objects
 * without their own `customData`, while a step is executing. What never does:
 *
 *  - `/start` and `/stop` — action requests, not resources (all four
 *    Start*Request models genuinely lack customData);
 *  - the whole DASH manifest-children tree (`/manifests/dash/{id}/periods…`:
 *    periods, adaptation sets, representations, DASH contentprotection) and
 *    the HLS media infos (`/manifests/hls/{id}/media/…`) — their models stop
 *    at BitmovinResponse, no customData (review of PR #163; SMOOTH's
 *    representation/contentprotection models DO carry it and stay stamped);
 *  - `/kantar-watermark` — KantarWatermark has no customData;
 *  - `/live/` runtime actions (scte-35-cue, reset-live-manifest-timeshift);
 *  - `/customData` — dead in practice (all 128 such SDK endpoints are GETs),
 *    kept as belt;
 *  - anything outside `/v1/encoding/` (analytics, player) — out of scope;
 *  - non-object bodies: `Array.isArray` excludes `/streams/{id}/filters`
 *    (its body IS an array of StreamFilter) and the string-body check
 *    excludes no-body action POSTs like `/live/restart`;
 *  - bodies that already carry customData — plan-provided customData wins.
 *
 * `/keyframes` is deliberately NOT denied: Keyframe extends BitmovinResource
 * and takes the stamp (the first version denied it on a false premise —
 * review of PR #163, I1). The deny-list is pinned against the SDK ITSELF in
 * the test file: each family's model class is probed at runtime (the
 * generated constructors copy only declared fields, so
 * `new Model({customData}).customData === undefined` is authoritative), and a
 * divergence after an SDK upgrade fails by name. An unknown NEW endpoint still
 * gets stamped —  records the residual 400-vs-silently-ignored
 * question for the first real-credential run.
 *
 * AUDIT DIVERGENCE, stated: `audited` snapshots the hand-built request
 * BEFORE this layer runs, so C7 snapshots and the audit log show the body
 * WITHOUT the stamp while the wire carries it. An operator debugging adoption
 * must read the Bitmovin-side resource, not our audit log, to see the stamp.
 */

import type { SdkFetch } from "./retrying-fetch";

export type CreateStamp = {
	jobId: string;
	/** The step currently executing, read at CALL time — undefined outside a step. */
	currentStep: () => string | undefined;
	/**
	 * True while the current step is RE-executing after a crash mid-step —
	 * 's adoption window. Read by sdk-ops' adopt-before-create
	 * (part 1 of the discipline runs only here; a list + per-candidate GET on
	 * every happy-path create would tax the common case for the rare one).
	 * The FETCH layer never reads it: stamping is unconditional.
	 */
	adoptWindow?: () => boolean;
	/** Cancellation recovery may adopt a prior CREATE, but must not POST. */
	allowCreate?: () => boolean;
	/**
	 * Durable verification identity. Both fields are derived and committed by
	 * the server before any provider create; they ride the provider resource so
	 * recovery never has to infer which paid request produced it.
	 */
	verification?: {
		key: string;
		requestSha256: string;
	};
	/**
	 * Encoding-only durability barrier. The facade awaits this callback after
	 * resolving the provider id and before returning it to the step executor.
	 */
	onEncodingCreated?: (
		providerId: string,
		source: "created" | "adopted",
	) => Promise<"PERSISTED" | "OWNERSHIP_LOST">;
};

export type VerificationCreateIdentity = NonNullable<
	CreateStamp["verification"]
>;

export class VerificationIdentityError extends Error {
	readonly code:
		| "VERIFICATION_IDENTITY_INCOMPLETE"
		| "VERIFICATION_IDENTITY_INVALID";
	constructor(
		code: "VERIFICATION_IDENTITY_INCOMPLETE" | "VERIFICATION_IDENTITY_INVALID",
	) {
		super(
			`${code}: durable verification key and canonical request SHA are required as one valid pair`,
		);
		this.name = "VerificationIdentityError";
		this.code = code;
	}
}

/** The DB failure was proven to occur before the persistence write was sent. */
export class VerificationProviderIdDefinitelyNotPersistedError extends Error {
	readonly code = "VERIFICATION_PROVIDER_ID_DEFINITELY_NOT_PERSISTED" as const;
	constructor(cause?: unknown) {
		super(
			"provider id persistence did not reach the database",
			cause === undefined ? undefined : { cause },
		);
		this.name = "VerificationProviderIdDefinitelyNotPersistedError";
	}
}

/** The worker's write fence says another process now owns this resource. */
export class VerificationProviderOwnershipLostError extends Error {
	readonly code = "VERIFICATION_PROVIDER_OWNERSHIP_LOST" as const;
	readonly providerId: string;
	constructor(providerId: string) {
		super(
			`VERIFICATION_PROVIDER_OWNERSHIP_LOST: provider encoding ${providerId} belongs to the winning recovery attempt`,
		);
		this.name = "VerificationProviderOwnershipLostError";
		this.providerId = providerId;
	}
}

/** Validates persisted DB identity before a worker can reach a paid create. */
export function verificationCreateIdentity(
	key: unknown,
	requestSha256: unknown,
): VerificationCreateIdentity | undefined {
	const hasKey = key !== null && key !== undefined;
	const hasSha = requestSha256 !== null && requestSha256 !== undefined;
	if (hasKey !== hasSha) {
		throw new VerificationIdentityError("VERIFICATION_IDENTITY_INCOMPLETE");
	}
	if (!hasKey) {
		return undefined;
	}
	if (
		typeof key !== "string" ||
		key.length === 0 ||
		key.length > 512 ||
		typeof requestSha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(requestSha256)
	) {
		throw new VerificationIdentityError("VERIFICATION_IDENTITY_INVALID");
	}
	return { key, requestSha256 };
}

/**
 * OUTPUTS ARE DENIED, AND THIS ONE WAS MEASURED THE EXPENSIVE WAY.
 *
 * A `customData` stamp on an OUTPUT resource makes every JIT (just-in-time)
 * manifest start fail: `POST /encoding/encodings/{id}/start` carrying
 * `vodHlsManifests` answers HTTP 500 / errorCode 1004 ("An undefined error
 * occurred"). Isolated 2026-08-15 to a single variable, same code path, same
 * account, virgin encodings, one start attempt each:
 *
 *   every create stamped .................... 1004
 *   nothing stamped ......................... 202
 *   all but input+output stamped ............ 202
 *   all but output stamped (input stamped) .. 202
 *   all but input stamped (OUTPUT stamped) .. 1004
 *
 * It cost a day of wrong attribution first: the failures were read as a
 * provider-side regime because plain starts kept working (they never touch
 * JIT generation) and because a corpus run with stamping disabled passed
 * 14/14 in the middle of it. The owner's rule — suspect our own API usage
 * before the vendor's service — is what turned it into a five-run bisect.
 *
 * Inputs stay stamped (proven harmless above); only the output resource,
 * which the JIT generator resolves while writing playlists mid-encode, is
 * excluded.  wanted account-scoped resources stamped so duplicates
 * stay identifiable — that value does not survive breaking JIT delivery.
 */
const DENIED_PATH =
	/\/(start|stop|customData)(\/|\?|$)|\/encoding\/outputs\/|\/manifests\/dash\/[^/]+\/periods|\/manifests\/hls\/[^/]+\/media\/|\/kantar-watermark(\/|\?|$)|\/live\//;

export function createStampingFetch(
	inner: SdkFetch,
	stamp: CreateStamp,
): SdkFetch {
	return async (url, init) => {
		const step = stamp.currentStep();
		const request = (init ?? {}) as { method?: string; body?: unknown };
		const method = (request.method ?? "GET").toUpperCase();
		if (
			step === undefined ||
			method !== "POST" ||
			!url.includes("/v1/encoding/") ||
			DENIED_PATH.test(url) ||
			typeof request.body !== "string"
		) {
			return inner(url, init);
		}
		let body: unknown;
		try {
			body = JSON.parse(request.body);
		} catch {
			return inner(url, init);
		}
		if (
			typeof body !== "object" ||
			body === null ||
			Array.isArray(body) ||
			"customData" in body
		) {
			return inner(url, init);
		}
		const stamped = {
			...body,
			customData: {
				bitovp: {
					job: stamp.jobId,
					step,
					...(stamp.verification ? { verification: stamp.verification } : {}),
				},
			},
		};
		return inner(url, {
			...(init as Record<string, unknown>),
			body: JSON.stringify(stamped),
		});
	};
}
