/**
 * : module-level helpers moved VERBATIM from sdk-ops.ts (the
 * pre-split freeze in facade-freeze.test.ts guards the facade these serve).
 * Types referenced here still live in sdk-ops.ts — the imports below are
 * type-only, so the sdk-ops ↔ ops cycle is erased at runtime.
 */

import {
	type AbstractCondition,
	AclEntry,
	AclPermission,
	CacheControl,
	ChromaLocation,
	ColorConfig,
	ColorPrimaries,
	ColorRange,
	ColorSpace,
	ColorTransfer,
	Condition,
	ConditionOperator,
	EncodingOutput,
	Label,
	type Task,
} from "@bitmovin/api-sdk";
import {
	type VerificationEncodingIdentity,
	verificationKeyLabel,
} from "@bitovp/core";
import type {
	ColorConfigParams,
	Destination,
	TaskStatusResult,
} from "../sdk-ops";
import type { CreateStamp } from "../stamping-fetch";

/** Resolves a known enum name or wire value; inherited/non-string members reject. */
export function sdkEnumValue<T extends Record<string, string>>(
	enumObject: T,
	name: string,
	label: string,
): T[keyof T] {
	if (Object.hasOwn(enumObject, name)) {
		const value = enumObject[name as keyof T];
		if (typeof value === "string") return value;
	}
	const wire = Object.values(enumObject).find(
		(value) => typeof value === "string" && value === name,
	);
	if (wire !== undefined) return wire as T[keyof T];
	throw new Error(`Unknown ${label} "${name}"`);
}

/** sdkEnumValue for optional fields — undefined passes through as unset. */
export function optEnum<T extends Record<string, string>>(
	enumObject: T,
	name: string | undefined,
	label: string,
): T[keyof T] | undefined {
	return name === undefined ? undefined : sdkEnumValue(enumObject, name, label);
}

/** A Bitmovin API error — identified structurally (no runtime SDK class). */
export function isBitmovinError(err: unknown): err is {
	httpStatusCode?: number;
	shortMessage?: string;
	errorCode?: number;
	/** Bitmovin's per-call correlation id — the ONE token support can use. */
	requestId?: string;
	/** Bitmovin's diagnostic prose. Kept OUT of `message` (see the class note). */
	developerMessage?: string;
} {
	if (typeof err !== "object" || err === null) {
		return false;
	}
	const e = err as { httpStatusCode?: unknown; shortMessage?: unknown };
	return (
		typeof e.httpStatusCode === "number" || typeof e.shortMessage === "string"
	);
}

/**
 * Body-free text for a Bitmovin failure: the API's own `shortMessage` (and
 * error code) only. NEVER `.message` — see the BitmovinCallError note.
 */
export function bitmovinErrorText(err: unknown): string {
	if (isBitmovinError(err)) {
		const code =
			typeof err.errorCode === "number" ? ` (code ${err.errorCode})` : "";
		return err.shortMessage
			? `${err.shortMessage}${code}`
			: `Bitmovin request failed with status ${err.httpStatusCode ?? "unknown"}${code}`;
	}
	return err instanceof Error ? err.message : "failed";
}

/**
 * The error every sdk-ops call throws for a Bitmovin API failure. It carries
 * the API's curated `shortMessage` plus the method/path/status we already
 * know — deliberately NOT the SDK's own `message`, which concatenates the raw
 * request body and would leak any secret the call carried into every place we
 * persist an error string. `cause` keeps the original reachable for a debugger
 * without putting it in the message (nothing serializes `cause`).
 */
export class BitmovinCallError extends Error {
	readonly httpStatusCode?: number;
	readonly shortMessage?: string;
	/**
	 * Structured capture (E2E 2026-08-14, I-01): the start-1004 investigation
	 * stalled because three audited failures carried only "HTTP 500, code
	 * 1004, short message" — no requestId to hand Bitmovin support, no
	 * developerMessage to read. The requestId RIDES THE MESSAGE (an opaque
	 * correlation token, safe everywhere error strings persist — step log,
	 * audit, UI); developerMessage stays a FIELD ONLY, same caution as the
	 * SDK's own `.message` (diagnostic prose we did not vet for echoes of
	 * the request body).
	 */
	readonly requestId?: string;
	readonly developerMessage?: string;
	readonly errorCode?: number;
	constructor(method: string, path: string, source: unknown) {
		const bm = isBitmovinError(source) ? source : undefined;
		const status = bm?.httpStatusCode;
		// review-206 N1: the field is SERVER-controlled response-body JSON —
		// nothing made "opaque correlation token" true until this clamp. A
		// non-conforming value (object, prose, 2 KB string, newlines) is
		// dropped rather than ridden into every persisted error string.
		const requestId =
			typeof bm?.requestId === "string" && /^[\w.:-]{1,128}$/.test(bm.requestId)
				? bm.requestId
				: undefined;
		super(
			`${method} ${path} failed${status ? ` (${status})` : ""}: ${bitmovinErrorText(source)}${
				requestId ? ` [request ${requestId}]` : ""
			}`,
			{ cause: source },
		);
		this.name = "BitmovinCallError";
		this.httpStatusCode = status;
		this.shortMessage = bm?.shortMessage;
		this.requestId = requestId;
		this.developerMessage = bm?.developerMessage;
		this.errorCode = bm?.errorCode;
	}
}

export function taskResult(task: Task): TaskStatusResult {
	return {
		status: String(task.status),
		progress: task.progress,
		messages: (task.messages ?? [])
			.map((m) => m.text ?? "")
			.filter((t) => t.length > 0),
	};
}

export function acl(permission: string | undefined): AclEntry[] | undefined {
	return permission
		? [
				new AclEntry({
					permission: sdkEnumValue(AclPermission, permission, "AclPermission"),
				}),
			]
		: undefined;
}

/**
 * Destination → SDK outputs array; absent destination → no outputs.
 * : a destination carrying resolved mirrorOutputIds expands to
 * one EncodingOutput per mirror at the SAME path and acl — one encode,
 * N storages; this is the single point where the fan-out becomes wire.
 */
export function outputs(destination: Destination | undefined) {
	return destination
		? [
				new EncodingOutput({
					outputId: destination.outputId,
					outputPath: destination.outputPath,
					acl: acl(destination.acl),
				}),
				...(destination.mirrorOutputIds ?? []).map(
					(mirrorId, i) =>
						new EncodingOutput({
							outputId: mirrorId,
							// : a mirror may carry its own wire path (MSL form).
							outputPath:
								destination.mirrorOutputPaths?.[i] ?? destination.outputPath,
							acl: acl(destination.acl),
						}),
				),
			]
		: undefined;
}

/** One Cache-Control leaf; absent (or blank) ⇒ no SDK object at all. */
export function cacheControl(
	leaf: { cacheControl?: string } | undefined,
): CacheControl | undefined {
	return leaf?.cacheControl
		? new CacheControl({ cacheControl: leaf.cacheControl })
		: undefined;
}

export function conditions(
	c: { attribute: string; operator: string; value: string } | undefined,
): AbstractCondition | undefined {
	return c
		? new Condition({
				attribute: c.attribute,
				operator: sdkEnumValue(
					ConditionOperator,
					c.operator,
					"ConditionOperator",
				),
				value: c.value,
			})
		: undefined;
}

export function colorConfig(
	c: ColorConfigParams | undefined,
): ColorConfig | undefined {
	return c
		? new ColorConfig({
				copyChromaLocationFlag: c.copyChromaLocationFlag,
				copyColorSpaceFlag: c.copyColorSpaceFlag,
				copyColorPrimariesFlag: c.copyColorPrimariesFlag,
				copyColorRangeFlag: c.copyColorRangeFlag,
				copyColorTransferFlag: c.copyColorTransferFlag,
				chromaLocation: optEnum(
					ChromaLocation,
					c.chromaLocation,
					"ChromaLocation",
				),
				colorSpace: optEnum(ColorSpace, c.colorSpace, "ColorSpace"),
				colorPrimaries: optEnum(
					ColorPrimaries,
					c.colorPrimaries,
					"ColorPrimaries",
				),
				colorRange: optEnum(ColorRange, c.colorRange, "ColorRange"),
				colorTransfer: optEnum(ColorTransfer, c.colorTransfer, "ColorTransfer"),
			})
		: undefined;
}

/**
 * The newest HLS manifest with this `manifestName` writing to this output, if any.
 *
 * Paginated at the C6 ceiling (limit 100) and BOUNDED: a shop with thousands of
 * manifests must not turn one step into an unbounded scan. `sort=createdAt:DESC` puts
 * the interesting ones on page one, and giving up is logged rather than silent — a
 * quiet "not found" here would create a duplicate instead of adopting.
 *
 * `encodingId` is deliberately NOT used as a filter: a custom manifest is linked to an
 * encoding through its variant/media streams, which do not exist yet at the point this
 * runs, so filtering by it would find nothing.
 */
export const MANIFEST_SCAN_PAGES = 5;

/**
 * The HLS scanner's shape, generalized (: a lost-response resume
 * orphaned a DASH/Smooth manifest where HLS adopted — the asymmetry the #163
 * review surfaced). Newest-first pages, name+output identity, first id wins.
 */
export async function findManifestByOutput<M extends { id?: string }>(
	list: (q: {
		limit: number;
		offset: number;
		sort: string;
	}) => Promise<{ items?: M[] }>,
	matches: (m: M) => boolean,
	label: string,
): Promise<string | undefined> {
	for (let page = 0; page < MANIFEST_SCAN_PAGES; page++) {
		const result = await list({
			limit: 100,
			offset: page * 100,
			sort: "createdAt:DESC",
		});
		const items = result.items ?? [];
		const hit = items.filter(matches).find((m) => Boolean(m.id));
		if (hit?.id) {
			return hit.id;
		}
		if (items.length < 100) {
			return undefined;
		}
	}
	console.warn(
		`[sdk-ops] stopped scanning ${label} manifests after ${MANIFEST_SCAN_PAGES * 100}; ` +
			"a match may exist beyond the horizon — creating rather than hanging the step",
	);
	return undefined;
}

export class ManifestIdentityAmbiguousError extends Error {
	constructor(label: string, matches: number) {
		super(`${label} manifest identity is ambiguous: ${matches} matches`);
		this.name = "ManifestIdentityAmbiguousError";
	}
}

export class ManifestIdentityScanIncompleteError extends Error {
	constructor(label: string) {
		super(
			`${label} manifest identity lookup reached the ${MANIFEST_SCAN_PAGES * 100}-item scan limit`,
		);
		this.name = "ManifestIdentityScanIncompleteError";
	}
}

/** Provider LIST failed, so absence is unknown and CREATE is unsafe. */
export class ManifestIdentityLookupError extends Error {
	constructor(label: string, cause: unknown) {
		super(
			`${label} manifest identity lookup failed: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
			{ cause },
		);
		this.name = "ManifestIdentityLookupError";
	}
}

export class ManifestCreateNotAuthorizedError extends Error {
	constructor(label: string) {
		super(
			`${label} manifest is absent but this delivery does not own its create intent`,
		);
		this.name = "ManifestCreateNotAuthorizedError";
	}
}

/**
 * Billing-safe variant used by live-to-VOD. It reads every bounded page,
 * rejects duplicate matches, and treats a full scan horizon as unknown.
 * Either ambiguity must block CREATE; picking the first match is not
 * reconciliation.
 */
export async function findUniqueManifestByOutput<M extends { id?: string }>(
	list: (q: {
		limit: number;
		offset: number;
		sort: string;
	}) => Promise<{ items?: M[] }>,
	matches: (m: M) => boolean,
	label: string,
): Promise<string | undefined> {
	const ids = new Set<string>();
	for (let page = 0; page < MANIFEST_SCAN_PAGES; page++) {
		const result = await list({
			limit: 100,
			offset: page * 100,
			sort: "createdAt:DESC",
		});
		const items = result.items ?? [];
		for (const item of items) {
			if (item.id && matches(item)) {
				ids.add(item.id);
				if (ids.size > 1) {
					throw new ManifestIdentityAmbiguousError(label, ids.size);
				}
			}
		}
		if (items.length < 100) {
			return [...ids][0];
		}
	}
	throw new ManifestIdentityScanIncompleteError(label);
}

/**
 * The FULL manifest adopt-or-create discipline — all three parts (* the first port replicated only two, and the missed third was exactly the
 * production failure mode: "each attempt succeeds server-side and loses its
 * answer" — review of PR #164, I2):
 *
 *  1. adopt BEFORE creating when an identity match exists;
 *  2. a FAILED lookup creates rather than failing the step;
 *  3. a FAILED create re-looks and adopts — the create may have reached the
 *     API and only its response died (undici `Premature close`); retrying
 *     re-creates, so the answer is to look, not to re-send.
 *
 * Adoption identity is name + (outputId, outputPath). SAFE against cross-job
 * collision because every job mints its own Bitmovin output resource
 * (CREATE_OUTPUT_* is an unconditional POST with no dedup), so two jobs never
 * share an outputId — including re-run-as-new, which clones the plan but mints
 * a fresh output. THAT SAFETY DEPENDS ON OUTPUTS NEVER BEING DEDUPED: if #38's
 * account-scoped-dedup idea ever reaches outputs, this identity must move to
 * the customData stamp (review of PR #164, Q2). Two bounds, both from the same
 * review's addendum: (S8) a CREATE_OUTPUT_* left RUNNING by a crash re-executes
 * on resume and mints a NEW outputId, so the lookup misses the previous
 * attempt's manifest — adoption degrades to pre-adoption behaviour (benign
 * duplicate, never a wrong artefact); and (S6) LIVE outputs are per-CHANNEL,
 * not per-run, so this name+output identity is UNSAFE ON ITS OWN for the
 * default live-to-VOD manifests: the second recording would adopt the first
 * recording's manifest.
 *
 * The default families therefore use BOTH halves, and an earlier revision of
 * this comment  prescribed only one — "key on encodingId,
 * never on name+output". That is insufficient, and reads as safe: the
 * live-to-VOD encodingId is `row.bitmovinEncodingId`, which is stable across
 * a channel's life because `restartLiveEncoding` reuses the encoding, so one
 * channel can record twice under a SINGLE id. encodingId alone therefore
 * reintroduces exactly the collision it was prescribed to prevent. The
 * shipped lookups filter the LIST by encodingId server-side and then narrow
 * within it by manifestName + (outputId, outputPath), which is why a
 * deliberate re-run to a different path still creates fresh.
 *
 * The adopt branches audit as GETs (C7): an adopted manifest previously left
 * ZERO audit rows — console.warn was the only trace (review of PR #164, I4).
 */
export async function adoptOrCreateManifest(args: {
	label: string;
	lookup: () => Promise<string | undefined>;
	create: () => Promise<string>;
	/** Lookup failure/ambiguity means UNKNOWN and must block a billable POST. */
	strictLookup?: boolean;
	/** False reconciles an earlier durable intent but can never POST. */
	allowCreate?: boolean;
	auditAdopt: (
		adoptedId: string,
		phase: "pre" | "post-failure",
	) => Promise<void>;
}): Promise<string> {
	const strictLookup = async () => {
		try {
			return await args.lookup();
		} catch (err) {
			if (
				err instanceof ManifestIdentityAmbiguousError ||
				err instanceof ManifestIdentityScanIncompleteError
			) {
				throw err;
			}
			throw new ManifestIdentityLookupError(args.label, err);
		}
	};
	const existing = args.strictLookup
		? await strictLookup()
		: await args.lookup().catch((err) => {
				console.warn(
					`[sdk-ops] ${args.label} manifest lookup failed ` +
						`(${err instanceof Error ? err.message : String(err)}); creating without adoption`,
				);
				return undefined;
			});
	if (existing) {
		console.warn(
			`[sdk-ops] adopting existing ${args.label} manifest ${existing} ` +
				"(a previous attempt created it and lost the response)",
		);
		await args.auditAdopt(existing, "pre").catch((recordErr) => {
			// Visible, like audited's safeRecord — a broken recorder was silent
			// on the adopt path and logged everywhere else (review of PR #164, nit).
			console.error(
				"[sdk-ops] adopt audit failed:",
				recordErr instanceof Error ? recordErr.message : recordErr,
			);
		});
		return existing;
	}
	if (args.allowCreate === false) {
		throw new ManifestCreateNotAuthorizedError(args.label);
	}
	return args.create().catch(async (err) => {
		// The create may have reached the API and only its response died.
		const adopted = args.strictLookup
			? await strictLookup()
			: await args.lookup().catch(() => undefined);
		if (adopted) {
			console.warn(
				`[sdk-ops] ${args.label} manifest create reported a failure but the ` +
					`resource EXISTS (${adopted}); adopting it`,
			);
			await args.auditAdopt(adopted, "post-failure").catch((recordErr) => {
				console.error(
					"[sdk-ops] adopt audit failed:",
					recordErr instanceof Error ? recordErr.message : recordErr,
				);
			});
			return adopted;
		}
		throw err;
	});
}

export const STAMP_SCAN_PAGES = 5;

export type VerificationProviderLookupCode =
	| "VERIFICATION_PROVIDER_LOOKUP_UNKNOWN"
	| "VERIFICATION_PROVIDER_LOOKUP_HORIZON"
	| "VERIFICATION_PROVIDER_ADOPTION_MISS"
	| "VERIFICATION_PROVIDER_DUPLICATE"
	| "VERIFICATION_PROVIDER_SHA_CONFLICT"
	| "VERIFICATION_PROVIDER_IDENTITY_CONFLICT";

/** Machine-readable, secret-free terminal/unknown provider identity failure. */
export class VerificationProviderLookupError extends Error {
	readonly code: VerificationProviderLookupCode;
	readonly provenIdentities: readonly VerificationEncodingIdentity[];
	readonly ownedCandidateIds: readonly string[];
	constructor(
		code: VerificationProviderLookupCode,
		label: string,
		provenIdentities: readonly VerificationEncodingIdentity[] = [],
		ownedCandidateIds: readonly string[] = [],
	) {
		super(`${code}: exact ${label} verification identity could not be proven`);
		this.name = "VerificationProviderLookupError";
		this.code = code;
		this.provenIdentities = [...provenIdentities];
		this.ownedCandidateIds = [...new Set(ownedCandidateIds)].sort();
	}
}

/**
 * The stamped-resource scanner — 's adoption half. Identity is the
 * `{"bitovp": {job, step}}` customData the stamping fetch wrote on the lost
 * create, so a match can never collide across jobs or steps by construction
 * (contrast the manifest scanner's name+output identity and its S8/S6 bounds).
 *
 * List endpoints have NO customData filter , so this
 * lists a bounded candidate set — the parent's own children, or the encodings
 * list pre-narrowed server-side — and reads each candidate's customData
 * subresource. Newest-first where the endpoint sorts; per-candidate GETs are
 * acceptable because this only ever runs on the rare resume path.
 *
 * Every failure returns undefined: a failed lookup must CREATE, never fail
 * the step (discipline part 2).
 */
export async function findStampedResource(opts: {
	label: string;
	expect: {
		job: string;
		step: string;
		verification?: { key: string; requestSha256: string };
	};
	/** Encoding-only provider fields that must agree with the verification marker. */
	verificationResource?: { name: string; label: string };
	list: (q: { limit: number; offset: number }) => Promise<{
		items?: Array<{ id?: string; name?: string; labels?: string[] }>;
	}>;
	customData: (id: string) => Promise<{ customData?: unknown } | undefined>;
}): Promise<string | undefined> {
	const strict = opts.expect.verification !== undefined;
	const exact: string[] = [];
	for (let page = 0; page < STAMP_SCAN_PAGES; page++) {
		let result: Awaited<ReturnType<typeof opts.list>>;
		try {
			result = await opts.list({ limit: 100, offset: page * 100 });
		} catch (err) {
			if (strict) {
				throw new VerificationProviderLookupError(
					"VERIFICATION_PROVIDER_LOOKUP_UNKNOWN",
					opts.label,
				);
			}
			throw err;
		}
		const rawItems = result.items ?? [];
		if (strict && rawItems.some((item) => !item.id)) {
			throw new VerificationProviderLookupError(
				"VERIFICATION_PROVIDER_LOOKUP_UNKNOWN",
				opts.label,
			);
		}
		const items = rawItems.filter((item) => Boolean(item.id));
		for (const item of items) {
			let holder: Awaited<ReturnType<typeof opts.customData>>;
			try {
				holder = await opts.customData(item.id as string);
			} catch {
				if (strict) {
					throw new VerificationProviderLookupError(
						"VERIFICATION_PROVIDER_LOOKUP_UNKNOWN",
						opts.label,
					);
				}
				// Ordinary jobs preserve the historical fail-open behavior: a
				// broken candidate does not prevent a later candidate from matching.
				continue;
			}
			const stamped = (
				holder?.customData as
					| {
							bitovp?: {
								job?: unknown;
								step?: unknown;
								verification?: { key?: unknown; requestSha256?: unknown };
							};
					  }
					| undefined
			)?.["bitovp"];
			const jobStepMatch =
				stamped?.job === opts.expect.job && stamped?.step === opts.expect.step;
			if (!strict) {
				if (jobStepMatch) {
					return item.id;
				}
				continue;
			}
			const expected = opts.expect.verification as {
				key: string;
				requestSha256: string;
			};
			const actual = stamped?.verification;
			if (actual?.key === expected.key) {
				if (actual.requestSha256 !== expected.requestSha256) {
					throw new VerificationProviderLookupError(
						"VERIFICATION_PROVIDER_SHA_CONFLICT",
						opts.label,
					);
				}
				if (
					stamped?.job !== opts.expect.job ||
					typeof stamped.step !== "string"
				) {
					throw new VerificationProviderLookupError(
						"VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
						opts.label,
					);
				}
				if (
					opts.verificationResource &&
					(item.name !== opts.verificationResource.name ||
						item.labels?.includes(opts.verificationResource.label) !== true)
				) {
					throw new VerificationProviderLookupError(
						"VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
						opts.label,
					);
				}
				if (stamped.step !== opts.expect.step) {
					// One verification job shares key+SHA across all of its resource
					// steps. A sibling is expected in the same provider collection;
					// only this exact step may be adopted, but the sibling is not a
					// collision and must not hide a later exact candidate.
					continue;
				}
				exact.push(item.id as string);
				if (exact.length > 1) {
					throw new VerificationProviderLookupError(
						"VERIFICATION_PROVIDER_DUPLICATE",
						opts.label,
					);
				}
			} else if (
				jobStepMatch ||
				(opts.verificationResource !== undefined &&
					item.labels?.includes(opts.verificationResource.label) === true)
			) {
				// A legacy/partial marker on the exact local step might already be
				// this paid resource, and a different key on the same exact step is
				// an outright identity collision. Neither can prove this request;
				// creating beside either would be the unsafe guess.
				throw new VerificationProviderLookupError(
					"VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
					opts.label,
				);
			}
		}
		if ((result.items ?? []).length < 100) {
			return exact[0];
		}
	}
	if (strict) {
		throw new VerificationProviderLookupError(
			"VERIFICATION_PROVIDER_LOOKUP_HORIZON",
			opts.label,
		);
	}
	console.warn(
		`[sdk-ops] stopped scanning ${opts.label} for the stamp after ${STAMP_SCAN_PAGES * 100} candidates; ` +
			"a match may exist beyond the horizon — creating rather than hanging the step",
	);
	return undefined;
}

/**
 * Provider-side recovery for a verification intent whose CREATE response or
 * local provider-id write was lost. The provider list is narrowed by the
 * exact verification label, then every candidate is re-bound to the exact
 * canonical request SHA through customData. Multi-encoding VOD jobs may
 * legitimately return several ids; ambiguity is about identity, not count.
 */
export async function findVerificationEncodingResources(opts: {
	label: string;
	jobId: string;
	verificationKey: string;
	requestSha256: string;
	resources: ReadonlyArray<{ step: string; name: string }>;
	list: (q: {
		limit: number;
		offset: number;
		sort: string;
		search: string;
	}) => Promise<{
		items?: Array<{ id?: string; name?: string; labels?: string[] }>;
	}>;
	customData: (id: string) => Promise<{ customData?: unknown } | undefined>;
}): Promise<VerificationEncodingIdentity[]> {
	const exactLabel = verificationKeyLabel(opts.verificationKey);
	if (opts.resources.length === 0) {
		throw new VerificationProviderLookupError(
			"VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
			opts.label,
		);
	}
	const matches = new Map<string, VerificationEncodingIdentity>();
	const ownedCandidateIds = new Set<string>();
	let failureCode: VerificationProviderLookupCode | undefined;
	const recordFailure = (code: VerificationProviderLookupCode) => {
		const conflict =
			code === "VERIFICATION_PROVIDER_SHA_CONFLICT" ||
			code === "VERIFICATION_PROVIDER_IDENTITY_CONFLICT" ||
			code === "VERIFICATION_PROVIDER_DUPLICATE";
		const currentConflict =
			failureCode === "VERIFICATION_PROVIDER_SHA_CONFLICT" ||
			failureCode === "VERIFICATION_PROVIDER_IDENTITY_CONFLICT" ||
			failureCode === "VERIFICATION_PROVIDER_DUPLICATE";
		if (!failureCode || (conflict && !currentConflict)) failureCode = code;
	};
	const fail = (code: VerificationProviderLookupCode) =>
		new VerificationProviderLookupError(
			code,
			opts.label,
			[...matches.values()],
			[...ownedCandidateIds],
		);
	for (let page = 0; page < STAMP_SCAN_PAGES; page++) {
		let result: Awaited<ReturnType<typeof opts.list>>;
		try {
			result = await opts.list({
				limit: 100,
				offset: page * 100,
				sort: "createdAt:DESC",
				search: `labels:${luceneQuoted(exactLabel)}`,
			});
		} catch {
			throw fail("VERIFICATION_PROVIDER_LOOKUP_UNKNOWN");
		}
		const items = result.items ?? [];
		for (const item of items) {
			if (!item.id) {
				recordFailure("VERIFICATION_PROVIDER_LOOKUP_UNKNOWN");
				continue;
			}
			const labelMatches = item.labels?.includes(exactLabel) === true;
			if (labelMatches) {
				// The exact run-scoped label is sufficient only for the possible-resource
				// cleanup set, never for identity completion. Retain it before reading
				// customData so an unreadable/conflicting marker cannot orphan billing.
				ownedCandidateIds.add(item.id);
			}
			let holder: Awaited<ReturnType<typeof opts.customData>>;
			try {
				holder = await opts.customData(item.id);
			} catch {
				recordFailure("VERIFICATION_PROVIDER_LOOKUP_UNKNOWN");
				continue;
			}
			const markerHolder = (
				holder?.customData as
					| {
							bitovp?: {
								job?: unknown;
								step?: unknown;
								verification?: { key?: unknown; requestSha256?: unknown };
							};
					  }
					| undefined
			)?.["bitovp"];
			const marker = markerHolder?.verification;
			if (marker?.key === opts.verificationKey) {
				if (marker.requestSha256 !== opts.requestSha256) {
					recordFailure("VERIFICATION_PROVIDER_SHA_CONFLICT");
					continue;
				}
				if (
					markerHolder?.job !== opts.jobId ||
					typeof markerHolder.step !== "string" ||
					!labelMatches ||
					typeof item.name !== "string" ||
					!opts.resources.some(
						(resource) =>
							resource.step === markerHolder.step &&
							resource.name === item.name,
					)
				) {
					recordFailure("VERIFICATION_PROVIDER_IDENTITY_CONFLICT");
					continue;
				}
				const localResource = opts.resources.find(
					(resource) =>
						resource.step === markerHolder.step && resource.name === item.name,
				);
				if (!localResource) {
					recordFailure("VERIFICATION_PROVIDER_IDENTITY_CONFLICT");
					continue;
				}
				matches.set(item.id, {
					encodingId: item.id,
					jobId: opts.jobId,
					step: localResource.step,
					name: localResource.name,
					label: exactLabel,
					verificationKey: opts.verificationKey,
					requestSha256: opts.requestSha256,
				});
				ownedCandidateIds.add(item.id);
			} else if (labelMatches) {
				// The exact label claims this intent while customData names another
				// one (or none). Never resolve that contradiction by creating again.
				recordFailure("VERIFICATION_PROVIDER_IDENTITY_CONFLICT");
			}
		}
		if (items.length < 100) {
			if (failureCode) throw fail(failureCode);
			return [...matches.values()].sort((a, b) =>
				a.encodingId.localeCompare(b.encodingId),
			);
		}
	}
	throw fail(failureCode ?? "VERIFICATION_PROVIDER_LOOKUP_HORIZON");
}

function luceneQuoted(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * DRM lookups build their pager per CONCRETE branch: the generated SDK's DRM
 * list-query types disagree with each other — fmp4/webm CENC page by STRING
 * offset/limit while mp4 CENC and both FairPlay variants take NUMBERS (read
 * from the resolved .d.ts files, 1.269; same wire bytes either way). A shared
 * structural helper cannot satisfy both shapes without casts, so each branch
 * adapts inline.
 */
export type StampPageQuery = { limit: number; offset: number };

/**
 * Adopt-or-create for STAMPED resources (encodings, streams, muxings, DRM) —
 * the second family of 's discipline, beside adoptOrCreateManifest:
 *
 *  1. adopt BEFORE creating — gated on the CRASH WINDOW (stamp.adoptWindow:
 *     the step was left RUNNING by a previous attempt). Unlike manifests, the
 *     happy path pays nothing: no list, no GETs.
 *  2. a FAILED lookup creates rather than failing the step;
 *  3. a FAILED create re-looks and adopts — UNCONDITIONALLY when stamped,
 *     window or not: the stamp rode the failed POST itself, so if that POST
 *     reached the API the resource is findable by this very attempt.
 *
 * The adopt branches audit as GETs (C7, the manifest precedent — an adopted
 * resource must not leave zero audit rows).
 */
export async function adoptOrCreateStamped(args: {
	label: string;
	stamp: CreateStamp | undefined;
	lookup: (expect: {
		job: string;
		step: string;
		verification?: { key: string; requestSha256: string };
	}) => Promise<string | undefined>;
	create: (
		beforeAudit?: (createdId: string) => Promise<void>,
	) => Promise<string>;
	auditAdopt: (
		adoptedId: string,
		phase: "pre" | "post-failure",
	) => Promise<void>;
	onResolved?: (id: string, source: "created" | "adopted") => Promise<void>;
}): Promise<string> {
	const step = args.stamp?.currentStep();
	const expect =
		args.stamp && step !== undefined
			? {
					job: args.stamp.jobId,
					step,
					...(args.stamp.verification
						? { verification: args.stamp.verification }
						: {}),
				}
			: undefined;
	const adoptWindow =
		expect !== undefined && args.stamp?.adoptWindow?.() === true;
	if (adoptWindow) {
		let existing: string | undefined;
		try {
			existing = await args.lookup(expect);
		} catch (err) {
			if (expect.verification || args.stamp?.allowCreate?.() === false) {
				throw err;
			}
			console.warn(
				`[sdk-ops] ${args.label} stamp lookup failed ` +
					`(${err instanceof Error ? err.message : String(err)}); creating without adoption`,
			);
		}
		if (existing) {
			console.warn(
				`[sdk-ops] adopting existing ${args.label} ${existing} ` +
					"(a previous attempt created it and lost the response)",
			);
			// The provider id is the paid-resource safety boundary. Persist it
			// before waiting on the best-effort C7 recorder: a hung recorder must
			// never widen the create-before-persist crash window.
			await args.onResolved?.(existing, "adopted");
			await args.auditAdopt(existing, "pre").catch((recordErr) => {
				console.error(
					"[sdk-ops] adopt audit failed:",
					recordErr instanceof Error ? recordErr.message : recordErr,
				);
			});
			return existing;
		}
	}
	if (adoptWindow && expect?.verification) {
		// RUNNING means a previous process may already have handed this paid
		// create to the provider. A short empty list is only "not visible now";
		// eventual consistency or an in-flight commit can still make it appear.
		// Creating again would turn an honest unresolved intent into a duplicate.
		throw new VerificationProviderLookupError(
			"VERIFICATION_PROVIDER_ADOPTION_MISS",
			args.label,
		);
	}
	if (args.stamp?.allowCreate?.() === false)
		throw new Error(
			"Cancelled startup CREATE remains unresolved; no new resource was created",
		);
	let created: string;
	try {
		const onResolved = args.onResolved;
		created = await args.create(
			onResolved ? (createdId) => onResolved(createdId, "created") : undefined,
		);
	} catch (err) {
		if (err instanceof ProviderResponseBarrierError) {
			// The POST response was received and its id was handed to the durable
			// barrier. A barrier failure is not a provider-create failure, so never
			// reinterpret it as a lost response and run lookup/adoption again.
			throw err.cause;
		}
		if (!expect) {
			throw err;
		}
		let adopted: string | undefined;
		try {
			adopted = await args.lookup(expect);
		} catch (lookupErr) {
			if (expect.verification) {
				throw lookupErr;
			}
		}
		if (adopted) {
			console.warn(
				`[sdk-ops] ${args.label} create reported a failure but the ` +
					`resource EXISTS (${adopted}); adopting it`,
			);
			await args.onResolved?.(adopted, "adopted");
			await args.auditAdopt(adopted, "post-failure").catch((recordErr) => {
				console.error(
					"[sdk-ops] adopt audit failed:",
					recordErr instanceof Error ? recordErr.message : recordErr,
				);
			});
			return adopted;
		}
		throw err;
	}
	return created;
}

/**
 * `audited` uses this private protocol marker when a provider response was
 * received but the mandatory post-response durability barrier failed.  The
 * adopt-or-create helper must not mistake that state for an ambiguous POST and
 * re-enter provider lookup/adoption.
 */
export class ProviderResponseBarrierError extends Error {
	readonly cause: unknown;
	constructor(cause: unknown) {
		super("provider response durability barrier failed");
		this.name = "ProviderResponseBarrierError";
		this.cause = cause;
	}
}

export function labels(
	l: { value: string }[] | undefined,
): Label[] | undefined {
	return l?.map((label) => new Label({ value: label.value }));
}

/**
 * Terminal encoding states, from the SDK's own `Status` enum. Everything else is
 * still costing money, which is why the orphan sweep filters on the complement
 * rather than on an allow-list of live states that can go stale.
 */
export const TERMINAL_ENCODING_STATUSES: ReadonlySet<string> = new Set([
	"FINISHED",
	"ERROR",
	"CANCELED",
	"TRANSFER_ERROR",
]);
