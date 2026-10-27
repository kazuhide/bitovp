import type { AkamaiMslStreamFormat, PlanOutput } from "./schema";
import type { PlanIssue } from "./validate";

/**
 * C31  — an Akamai MSL output's `streamFormat` constrains the
 * ENCODING, and Bitmovin's rejection names muxings rather than the output the
 * operator chose in a dropdown.
 *
 * SHARED, and that is the whole point of the file existing. The first cut put
 * this in the VOD validator only, and the live plan reuses the very same
 * `planOutputSchema` while going through `validateLiveChannel` — a completely
 * separate issue set. So the constraint did not run on the path this feature
 * was built for, and at the time that was the only path there was — the
 * wizard gained a destination selector on 2026-08-18. Caught by review-4; the fix is one checker both
 * validators call.
 *
 * TWO STRENGTHS, on purpose (review-5 I4):
 *
 *  - MISSING the format's own container or manifest is an `error`. The SDK is
 *    explicit about what to configure, and without it the format has nothing
 *    to deliver — there is no reading under which such a plan works.
 *  - An EXTRA incompatible container or manifest is a `warning`. That half is
 *    our INFERENCE from "one container per format", not something anyone has
 *    watched Akamai reject; an earlier revision of the COVERAGE row stated it
 *    as observed fact while READINESS in the same commit said "zero real
 *    contact", and both could not be true. A wrong hard block costs the
 *    customer a working configuration and offers no override, since every
 *    submit path validates after the parse. Promote it to `error` once one
 *    real MSL stream says so.
 */

/**
 * The output kind this checker is about, bound to the schema at COMPILE time.
 *
 * `output.kind !== "AKAMAI_MSL"` against a `string` field silently stops
 * matching if the schema literal is ever renamed — the checker would then run
 * over nothing and every test still pass, which is precisely the failure this
 * file was extracted to fix, one rename away (review-5 I2).
 */
const MSL_KIND: PlanOutput["kind"] = "AKAMAI_MSL";

/**
 * What each stream format demands, and what it cannot tolerate beside it.
 *
 * `satisfies Record<AkamaiMslStreamFormat, …>` is load-bearing and was dropped
 * in the extraction: with a bare `as const` plus a `string` lookup, adding a
 * fourth member to `akamaiMslStreamFormatSchema` compiles clean, passes the
 * whole suite, and silently turns C31 off for every plan using it.
 * Kill-verified by review-5: planting `"MSS"` into the enum left
 * `tsc --noEmit` at exit 0.
 *
 * ATTRIBUTION CORRECTED : an earlier revision said
 * "the ledger explicitly plans MSL5 as an SDK bump plus one entry here" —
 * wrong enum. MSL5 is a VERSION (`AKAMAI_MSL_VERSIONS`, MSL4|MSL5), not a
 * fourth STREAM FORMAT; the version's own exhaustiveness anchor lives at
 * the bottom of this file so a future MSL5 entry cannot compile past the
 * gate/constraint either.
 */
export const AKAMAI_MSL_REQUIREMENTS = {
	DASH: {
		/** SDK supports distinct fMP4 and CMAF resources. */
		muxings: ["FMP4", "CMAF"],
		manifests: ["DASH"],
		/**
		 * Incompatible CONTAINERS, not "anything unlisted": CHUNKED_TEXT is a
		 * legitimate WebVTT companion to any ladder, so a subset check would
		 * reject valid plans. What breaks is mixing the segment container the
		 * format does not use.
		 */
		forbidden: ["TS", "MP4", "WEBM", "TEXT"],
		/**
		 * The manifest half of the same idea, and it was declared 3× and read
		 * 0× for one commit (review-5 I3). The case it exists for is real and
		 * was a false negative: a DASH-format output carrying a DASH manifest
		 * AND an HLS one is the CMAF configuration wearing a DASH label, and
		 * it passed silently. SMOOTH is on every list — Smooth Streaming is
		 * not a delivery family MSL offers at all.
		 */
		forbiddenManifests: ["HLS", "SMOOTH"],
	},
	HLS: {
		muxings: ["TS"],
		manifests: ["HLS"],
		forbidden: ["FMP4", "CMAF", "MP4", "WEBM", "TEXT"],
		forbiddenManifests: ["DASH", "SMOOTH"],
	},
	CMAF: {
		muxings: ["FMP4", "CMAF"],
		manifests: ["DASH", "HLS"],
		forbidden: ["TS", "MP4", "WEBM", "TEXT"],
		forbiddenManifests: ["SMOOTH"],
	},
} as const satisfies Record<
	AkamaiMslStreamFormat,
	{
		muxings: readonly string[];
		manifests: readonly string[];
		forbidden: readonly string[];
		forbiddenManifests: readonly string[];
	}
>;

type MslCheckInput = {
	outputs: readonly {
		key: string;
		kind: string;
		streamFormat?: string;
		/** Structural, like the rest of this input — callers hold plans at
		 * different stages of parsing. Rails 3b and 6 read it. */
		mslVersion?: string;
		/** Rail 3b resolves the Digest pair's presence through this. */
		credentialId?: string;
	}[];
	/**
	 * Which plan language this is. REQUIRED, not optional, and that is the
	 * lesson two other slots in this repo paid for: an optional cross-layer
	 * fact is a slot the caller forgets, and the guard then reports clean over
	 * a population it never received ('s own gate, review-161-162
	 * B4). Required makes tsc name every call site.
	 *
	 * Rail 6 needs it: MSL5 is live-only upstream, and the VOD union carries
	 * `AKAMAI_MSL` because MSL4 legitimately appears there.
	 */
	encodingKind: "LIVE" | "VOD";
	/**
	 * Credential ids KNOWN to carry an MSL5 Digest publishing pair — rail 3b.
	 *
	 * REQUIRED-BUT-NULLABLE, which is a third thing from optional and is the
	 * `AuditEntry.actor` idiom this repo already uses: an optional property is
	 * the chokepoint's own bypass, because a caller that forgets it looks
	 * identical to a caller that has nothing to say. Required makes tsc name
	 * every call site; nullable lets a caller say "I cannot know" ON PURPOSE.
	 *
	 * `undefined` means exactly that — a CLIENT preview or import, which cannot
	 * read vault material and must not warn about it (the same shape
	 * `secretEgressAllowedHosts` uses, and the same reason: a browser refusing
	 * what a server accepts is the inverted-divergence failure). A Set, even an
	 * empty one, means the server resolved it and silence is a finding.
	 */
	credentialHasPublishingAuth: ReadonlySet<string> | undefined;
	/** `destination` is optional: a DRM'd muxing writes through its DRM entry. */
	muxings: readonly {
		key: string;
		kind: string;
		destination?: { outputKey: string } | undefined;
		/** Present on segmented muxings; the schema defaults it per kind. */
		segmentNaming?: string | undefined;
		/** fMP4 only — arm 3. A TS muxing has no init segment. */
		initSegmentName?: string | undefined;
		/** Where placeholder tokens belong — Bitmovin expands this one. */
		segmentNamingTemplate?: string | undefined;
	}[];
	manifests: readonly { kind: string; destination: { outputKey: string } }[];
	/** Mirror fan-out — VOD since #115; the live schema joined 2026-08-23. */
	deliveryMirrors?: readonly { outputKey: string }[] | undefined;
	/** VOD only. A DRM entry carries the destination its muxing writes through. */
	drm?:
		| readonly {
				muxingKey: string;
				destination?: { outputKey: string } | undefined;
		  }[]
		| undefined;
	/**
	 * `plan.qc.only` — a measure-only plan. The compiler emits no delivery
	 * muxings and no manifests for one, so the MISSING-half checks would be
	 * judging a topology that is never built. It does NOT switch C31 off: see
	 * `qcMirrors`. VOD only; live has no QC-only mode.
	 */
	qcOnly?: boolean | undefined;
	/**
	 * The SYNTHESIZED QC mirrors — one per VIDEO rendition whenever `qc.vmaf`
	 * or `qc.psnr` is on (`compiler.ts`, `qc-muxing:<rendition>`, written to
	 * `renditionOutputBase(...)`) — as the output each lands on and the
	 * CONTAINER it is: progressive MP4 for every codec but VP9, which rides a
	 * progressive WebM . The first shape of
	 * this field was a list of output keys with "MP4" hard-coded in the reader
	 * — a third consumer of the mirror's container that #205 did not enumerate,
	 * so a VP9 ladder on an MSL output drew a C31 naming MP4 (review-324 I1).
	 *
	 * This exists because of the root cause review-6 named: **C31 judges
	 * `plan.muxings`, and the compiler builds muxings the plan never declares.**
	 * My first cut simply returned early on `qc.only`, which looked like a
	 * narrowing and was a hole — a QC-only plan whose ladder points at an MSL
	 * output still writes MP4 files there, and MP4 is on every format's
	 * `forbidden` list precisely to stop that. The same gap was open under
	 * `qc.vmaf` alone, where no early return was involved at all.
	 *
	 * Computed by the caller, which has the whole plan; the checker stays
	 * structural so the live path can share it.
	 */
	qcMirrors?: readonly { outputKey: string; muxingKind: string }[] | undefined;
};

/**
 * Which muxing kinds actually reach `outputKey`, counting the two indirect
 * routes the first cut missed:
 *
 *  - a DRM'd muxing has NO destination of its own and writes through its DRM
 *    entry (`schema.ts`: "destination is optional because DRM'd muxings write
 *    through the DRM destination"). Ignoring that made C31 reject a correct
 *    CENC ladder with "it has none".
 *  - a delivery mirror re-writes every destination to the mirror output, so an
 *    MSL output named only as a mirror receives everything while appearing in
 *    no muxing's destination. Confirmed against `mirrorOutputRefs`
 *    (`compiler.ts`), which spreads the mirror refs unconditionally at every
 *    destination — muxings of every kind, DRM, thumbnails, sprites and all
 *    three manifest builders — so "everything reaches a mirror" is the
 *    compiler's actual behaviour, not an approximation of it.
 *
 * Both routes shipped unpinned and BOTH mutations survived the full suite
 * (review-5 I1); the arms that kill them now live beside the direct ones.
 */
/**
 * Does this muxing WRITE to this output — directly, through its DRM entry, or
 * because the output is a delivery mirror and therefore receives everything?
 *
 * EXTRACTED so there is one copy . The mixed-version
 * rail below needs the same question answered, and a second copy of a
 * three-branch reachability rule is the drift this file has already paid for
 * twice — both mirror routes shipped unpinned once (review-5 I1).
 */
function muxingReaches(
	input: MslCheckInput,
	muxing: MslCheckInput["muxings"][number],
	outputKey: string,
): boolean {
	if ((input.deliveryMirrors ?? []).some((m) => m.outputKey === outputKey)) {
		return true;
	}
	if (muxing.destination?.outputKey === outputKey) {
		return true;
	}
	return (input.drm ?? []).some(
		(entry) =>
			entry.muxingKey === muxing.key &&
			entry.destination?.outputKey === outputKey,
	);
}

function muxingKindsReaching(input: MslCheckInput, outputKey: string) {
	const kinds = new Set<string>();
	// The synthesized QC mirrors, counted before anything declared: real files
	// written to real outputs that the plan does not mention — in the container
	// the compiler actually chose for each (MP4, or WebM for VP9).
	for (const mirror of input.qcMirrors ?? []) {
		if (mirror.outputKey === outputKey) {
			kinds.add(mirror.muxingKind);
		}
	}
	for (const muxing of input.muxings) {
		if (muxingReaches(input, muxing, outputKey)) {
			kinds.add(muxing.kind);
		}
	}
	return kinds;
}

/**
 * One muxing writing to two MSL outputs of DIFFERENT versions — ,
 * rewritten on review F8.
 *
 * WHAT THE FIRST CUT DID WRONG, because it is the class this file keeps
 * relearning: it asserted the relation instead of deriving it. The predicate
 * was "two MSL outputs with different `mslVersion` exist on this plan", and the
 * message said "They share the same muxings" — which is FALSE for the one
 * dual-version topology that actually works. Two independent ladders to two
 * Akamai streams, each with its own muxing carrying its own correct grammar, is
 * how you would validate MSL5 beside MSL4 before cutting over. It costs double
 * encoding, which is exactly why an operator would reach for the mirror; being
 * told to "split them into separate channels" when they already had is the
 * wrong instruction, at error level, on a representable plan.
 *
 * 「presence is not association」 — both outputs being present is not the same
 * as being joined, and the test could not tell the two apart because its
 * fixture had no muxings at all.
 *
 * ONE issue per plan, not per muxing: the operator's fix is topological (split
 * the channel), so a four-rung ladder saying it four times would be four copies
 * of one instruction.
 *
 * Outputs with an ABSENT version are skipped rather than defaulted. A parsed
 * plan cannot have one (`.default("MSL4")` fills it), so this only concerns
 * structural callers — and restating the schema's default here would be a
 * second place that decides what absent means.
 */
function mixedMslVersionIssue(input: MslCheckInput): PlanIssue | null {
	for (const [muxIndex, muxing] of input.muxings.entries()) {
		const reached = input.outputs.filter(
			(o) =>
				o.kind === MSL_KIND &&
				o.mslVersion !== undefined &&
				muxingReaches(input, muxing, o.key),
		);
		const versions = new Set(reached.map((o) => o.mslVersion as string));
		if (versions.size > 1) {
			return {
				code: "C31",
				level: "error",
				message: `Muxing "${muxing.key}" writes to Akamai MSL outputs of different versions (${reached.map((o) => `"${o.key}" (${o.mslVersion})`).join(", ")}). One muxing carries one segmentNaming and each version demands its own grammar, so no naming satisfies both — give each version its own muxing, or split them into separate channels.`,
				path: `muxings.${muxIndex}.destination`,
			};
		}
	}
	return null;
}

function manifestKindsReaching(input: MslCheckInput, outputKey: string) {
	const mirrored = (input.deliveryMirrors ?? []).some(
		(m) => m.outputKey === outputKey,
	);
	return new Set(
		input.manifests
			.filter((m) => mirrored || m.destination.outputKey === outputKey)
			.map((m) => m.kind),
	);
}

/**
 * MSL segment naming, MEASURED to completion against the real API on
 * 2026-08-21 — four arms, one variable each (measurement doc Parts 2-8):
 *
 *   segmentNaming "seg_%number%.ts" (schema default) -> live/start 400, 2025
 *   segmentNaming "seg-{rand_chars:8}-%number%.ts"   -> ACCEPTED; ran, was
 *                                                       published, PLAYED
 *   segmentNamingTemplate with that token            -> live/start 400, 2025
 *   segmentNaming "seg-k7Qw2xP9-%number%.ts"         -> live/start 400, 2025
 *                  (pre-expanded, no token)
 *
 * Conclusion the rule encodes: Bitmovin's MSL start check demands the
 * `{rand_chars[:number]}` token VERBATIM in `segmentNaming`, and its MSL
 * publisher then ships the braces unexpanded — the SDK's documented
 * segmentNamingTemplate expansion does not hold on this path. (Their
 * inconsistency; raised rather than papered over. An intermediate revision
 * here required the TEMPLATE because the docs say so, which made every
 * wizard-built MSL channel unable to start.)
 *
 * ERRORS, not warnings, on both arms below: each is a refusal we watched,
 * with the grammar quoted back by the API.
 */
const MSL_SEGMENT_NAMING =
	/^[^/]*-\{rand_chars(:\d+)?\}-%number%\.[A-Za-z0-9]+$/;

/**
 * MSL5 media names must contain both representation and segment-number tokens.
 * Init segments have no segment number and use the representation token only.
 * Accept prefixes and nested paths rather than requiring one literal name.
 * Media-token violations are errors; init naming remains advisory.
 */
const MSL5_MEDIA_TOKENS = ["$RepresentationID$", "$Number$"] as const;
const MSL5_INIT_TOKEN = "$RepresentationID$";

/**
 * Every MSL5 media token present, AND an extension — containment for the
 * tokens, per the vendor's own wording.
 *
 * The extension half is NOT part of what the evidence loosened (review, minor).
 * The old regex ended `\.[A-Za-z0-9]+$`; the vendor's sentence licensed
 * relaxing the TOKEN rule, not deleting the extension rule, and MSL4's arm
 * still enforces it. Dropping it accepted `$RepresentationID$_$Number$` with no
 * extension at all — a loosening nothing asked for, in the same edit that fixed
 * a loosening something did.
 */
function msl5MediaNamingOk(naming: string): boolean {
	return (
		MSL5_MEDIA_TOKENS.every((token) => naming.includes(token)) &&
		/\.[A-Za-z0-9]+$/.test(naming)
	);
}

/**
 * The naming we suggest, per container AND per version, when a plan's does not
 * conform. `mslVersion` is optional so the MSL4 callers that predate MSL5 keep
 * working; an unknown version gets MSL4's, which is the incumbent.
 */
export function akamaiMslSegmentNaming(
	muxingKind: string,
	mslVersion?: string,
): string {
	const extension = muxingKind === "TS" ? "ts" : "m4s";
	return mslVersion === "MSL5"
		? `$RepresentationID$_$Number$.${extension}`
		: `seg-{rand_chars:8}-%number%.${extension}`;
}

/**
 * The MSL5 init segment name. fMP4 only — a TS muxing has no init segment.
 *
 * MSL5-SCOPED, no version parameter, because the MSL4 branch it used to have
 * was dead (review F11) and would have stayed dead: MSL4 uses the schema
 * default `init.mp4`, every landed MSL4 golden carries it, and those channels
 * have started for real. A parameter whose other value is never passed is the
 * `forbiddenManifests` shape this file already has a comment about — "declared
 * 3x, read 0x".
 *
 * For the record, since it is evidence rather than a value we emit: the
 * vendor's MSL4 tests use `init_{rand_chars:10}.mp4`. We do not, and nothing
 * has asked us to.
 */
export function akamaiMsl5InitSegmentName(): string {
	return "$RepresentationID$_init.mp4";
}

/** Every C31 issue for a plan, VOD or live. `path` prefixes differ per caller. */
export function checkAkamaiMslConstraints(input: MslCheckInput): PlanIssue[] {
	const issues: PlanIssue[] = [];
	// Plan-level, and DERIVED from the muxing→output relation rather than from
	// the mere presence of two versions (review F8).
	const mixed = mixedMslVersionIssue(input);
	if (mixed !== null) {
		issues.push(mixed);
	}
	for (const [index, output] of input.outputs.entries()) {
		if (output.kind !== MSL_KIND) {
			continue;
		}
		const format = output.streamFormat;
		// `Object.hasOwn` rather than a truthiness test on the lookup: a
		// `streamFormat` of "constructor" finds Object.prototype's, which is
		// truthy and has no `.muxings` (review-5 I2, latent because every
		// caller passes parsed data — latent is not the same as absent).
		if (
			format === undefined ||
			!Object.hasOwn(AKAMAI_MSL_REQUIREMENTS, format)
		) {
			continue;
		}
		// Validate format and encoding kind from the shared version rules.
		// Encoder-version availability depends on external state and remains a warning.
		const behavior = Object.hasOwn(
			AKAMAI_MSL_VERSION_BEHAVIOR,
			output.mslVersion ?? "",
		)
			? AKAMAI_MSL_VERSION_BEHAVIOR[output.mslVersion as AkamaiMslVersion]
			: undefined;
		if (behavior !== undefined) {
			/*
			 * RAIL 3b — an MSL5 output whose credential carries no Digest pair
			 * publishes UNAUTHENTICATED, silently and permanently.
			 *
			 * This is F3's own hole, reopened one trigger over by F3's own fix.
			 * Deriving `enabled` from credential presence closes "the operator
			 * left the checkbox off"; it does not close "the vault half is
			 * empty" — and that state is HARDER to notice, because removing the
			 * checkbox removed the only affordance that would have shown it.
			 *
			 * WARNING, not error: omitting `publishingAuthentication` is legal
			 * per the SDK and the encoder simply publishes unauthenticated, so
			 * refusing would reject a deliberately-unauthenticated setup the API
			 * accepts. The message names the credential, because the fix is
			 * there and not in the plan.
			 *
			 * Derives `publishingAuth` from the anchor rather than testing
			 * `mslVersion === "MSL5"`: the version that forbids the field must
			 * not be warned about for lacking it, and that is a fact about the
			 * VERSION, which is what the Record is for.
			 */
			if (
				behavior.publishingAuth !== "FORBIDDEN" &&
				input.credentialHasPublishingAuth !== undefined &&
				output.credentialId !== undefined &&
				!input.credentialHasPublishingAuth.has(output.credentialId)
			) {
				issues.push({
					code: "MSL_PUBLISHING_AUTH_ABSENT",
					level: "warning",
					message: `Akamai MSL output "${output.key}" is ${output.mslVersion} and its credential carries no Digest publishing pair — the encoder will publish to Akamai UNAUTHENTICATED. Add the username/password to the credential, or accept this deliberately.`,
					path: `outputs.${index}.credentialId`,
				});
			}
			if (
				!(behavior.encodingKinds as readonly string[]).includes(
					input.encodingKind,
				)
			) {
				issues.push({
					code: "MSL_VERSION_ENCODING_KIND",
					level: "error",
					message: `Akamai MSL output "${output.key}" is ${output.mslVersion}, which Bitmovin accepts on ${behavior.encodingKinds.join("/")} encodings only — this is a ${input.encodingKind} plan`,
					path: `outputs.${index}.mslVersion`,
				});
			}
		}

		const need = AKAMAI_MSL_REQUIREMENTS[format as AkamaiMslStreamFormat];
		const muxingKinds = muxingKindsReaching(input, output.key);
		const manifestKinds = manifestKindsReaching(input, output.key);
		const path = `outputs.${index}.streamFormat`;

		// Under `qc.only` the compiler builds neither delivery muxings nor
		// manifests, so demanding them would object to a topology that is never
		// constructed. The FORBIDDEN halves below still run — they are about
		// what DOES get written, and under qc.only that is the mirror MP4.
		if (!input.qcOnly && !need.muxings.some((k) => muxingKinds.has(k))) {
			issues.push({
				code: "C31",
				level: "error",
				message: `Akamai MSL output "${output.key}" is ${format}, which needs ${need.muxings.join(" or ")} muxings written to it — it has ${muxingKinds.size === 0 ? "none" : [...muxingKinds].join(", ")}`,
				path,
			});
		}
		/*
		 * Segment naming — the failure that only real contact could find. Every
		 * muxing that WRITES to this MSL output must use the grammar the API
		 * quoted at us; ours default to the S3-shaped `seg_%number%.ts`.
		 * Reported per muxing, because the operator has to fix each one and a
		 * single aggregate issue would not say which.
		 */
		// review-292 I3: the naming arms were the ONLY C31 arms still blind to
		// mirrors — muxingKindsReaching/manifestKindsReaching learned the
		// mirror topology, this loop kept destination-equality, so an MSL
		// output receiving everything AS A MIRROR skipped the one rule real
		// contact produced (the measured naming refusal).
		const mirroredHere = (input.deliveryMirrors ?? []).some(
			(m) => m.outputKey === output.key,
		);
		for (const [muxIndex, muxing] of input.muxings.entries()) {
			if (!mirroredHere && muxing.destination?.outputKey !== output.key) {
				continue;
			}
			if (mirroredHere && muxing.destination === undefined) {
				// A DRM-owned muxing without its own destination cannot be
				// judged here even under a mirror (same rule as the direct arm).
				continue;
			}
			/*
			 * Only the containers this FORMAT delivers — the ones the refusal
			 * was measured on. A CHUNKED_TEXT WebVTT companion also writes here
			 * and I have not watched Akamai reject its naming, so extending the
			 * rule to it would be inference wearing an error's clothes. This
			 * file already splits those two things (measured → error, inferred
			 * → warning); an unmeasured hard block costs a working
			 * configuration and offers no override.
			 */
			// `.some`, not `.includes`: the requirement table is a readonly tuple
			// of literals, so `includes(string)` narrows the parameter to `never`.
			if (!need.muxings.some((k) => k === muxing.kind)) {
				continue;
			}
			/*
			 * A PARSED plan never arrives here with `undefined` — the schema
			 * fills the per-kind default (`seg_%number%.ts`) first, and that
			 * default is exactly what Akamai refused. The `undefined` branch
			 * below is for callers passing a raw object, and it reports rather
			 * than skips: absent is not permission.
			 */
			/*
			 * Arm 1 — a TEMPLATE on an MSL-bound muxing cannot start (measured:
			 * with template-only the start check finds nothing conforming in
			 * segmentNaming and refuses). Say it here, at plan time, instead of
			 * thirty ops later.
			 */
			if (muxing.segmentNamingTemplate !== undefined) {
				issues.push({
					code: "C31",
					level: "error",
					message: `Muxing "${muxing.key}" writes to Akamai MSL output "${output.key}" and sets segmentNamingTemplate — Bitmovin refuses live/start for MSL with a template (code 2025, measured 2026-08-21). Put the token in segmentNaming verbatim: "${akamaiMslSegmentNaming(muxing.kind)}"`,
					path: `muxings.${muxIndex}.segmentNamingTemplate`,
				});
				continue;
			}
			/*
			 * Arm 2 — segmentNaming must carry the token VERBATIM. A parsed
			 * plan never arrives with `undefined` (the schema fills the
			 * S3-shaped default, which is exactly the refused shape); a
			 * pre-expanded name without the token is refused too, so the
			 * pattern is the token grammar, not a looser shape.
			 */
			const naming = muxing.segmentNaming;
			// Version-scoped: MSL4's token grammar and MSL5's DASH-style
			// template variables are different languages, and applying either
			// to the other refuses a correct plan.
			const isMsl5 = output.mslVersion === "MSL5";
			const suggestion = akamaiMslSegmentNaming(muxing.kind, output.mslVersion);
			const observed =
				naming === undefined
					? "It is unset, so the S3-shaped default applies."
					: `It is "${naming}".`;
			const namingOk =
				naming !== undefined &&
				(isMsl5 ? msl5MediaNamingOk(naming) : MSL_SEGMENT_NAMING.test(naming));
			if (!namingOk) {
				issues.push({
					code: "C31",
					// ERROR on BOTH versions, because both have a watched refusal
					// at the same code and the same endpoint. This was a WARNING
					// on MSL5 for one commit, on an evidence claim that the cited
					// commit's own body refutes — see the grammar block above.
					level: "error",
					message: isMsl5
						? `Muxing "${muxing.key}" writes to Akamai MSL5 output "${output.key}", so its segmentNaming must CONTAIN ${MSL5_MEDIA_TOKENS.join(" and ")} — Bitmovin rejected MSL4-style {rand_chars} naming with code 2025 on live/start (bitmovin-java-internal adab58537b). Suggested: "${suggestion}". ${observed}`
						: `Muxing "${muxing.key}" writes to Akamai MSL output "${output.key}", so its segmentNaming must carry the token verbatim, like "${suggestion}" — Bitmovin refuses live/start otherwise (code 2025). ${observed}`,
					path: `muxings.${muxIndex}.segmentNaming`,
				});
			}
			/*
			 * Arm 3 — the INIT segment name, MSL5 only, and a WARNING.
			 *
			 * The commit that moved the media naming moved this one too, on
			 * every fMP4 site, and it is the axis review found unregistered:
			 * MSL4 `init_{rand_chars:10}.mp4` -> MSL5
			 * `$RepresentationID$_init.mp4`. `$Number$` is absent by design —
			 * an init segment has no number.
			 *
			 * A warning, not an error, for the reason the media arm just STOPPED
			 * being one: there is no watched refusal here on either version. The
			 * vendor changed it in the same commit without recording a 400 for
			 * it, so the honest strength is "the shape the vendor uses", not
			 * "the shape the API demands". Two things sharpen that. The refusal
			 * the commit body DOES record is scoped to "media segment names",
			 * and an init segment is not a media segment — so that 400 is not
			 * evidence about this field at all. And corroboration arrives from a
			 * direction the stale encoder checkout cannot spoil, because it is
			 * DASH semantics rather than MSL: the manifest service's own tests
			 * assert `SegmentTemplate@initialization` of
			 * `$RepresentationID$/init.mp4` as ordinary template convention. The
			 * MSL5 init form looks like DASH convention, not an MSL demand.
			 *
			 * MSL4 is left alone entirely: `init.mp4` is what every landed MSL4
			 * golden carries, and those channels have started for real.
			 */
			const initName = muxing.initSegmentName;
			if (
				isMsl5 &&
				initName !== undefined &&
				!initName.includes(MSL5_INIT_TOKEN)
			) {
				issues.push({
					code: "C31",
					level: "warning",
					message: `Muxing "${muxing.key}" writes to Akamai MSL5 output "${output.key}"; Bitmovin's own MSL5 end-to-end tests name the init segment "${akamaiMsl5InitSegmentName()}", containing ${MSL5_INIT_TOKEN}. This one is "${initName}". No refusal has been watched for the init name on either version, so this is a warning rather than a block.`,
					path: `muxings.${muxIndex}.initSegmentName`,
				});
			}
		}

		const missingManifests = input.qcOnly
			? []
			: need.manifests.filter((k) => !manifestKinds.has(k));
		if (missingManifests.length > 0) {
			issues.push({
				code: "C31",
				level: "error",
				message: `Akamai MSL output "${output.key}" is ${format}, which needs ${need.manifests.join(" and ")} manifest(s) written to it — missing ${missingManifests.join(", ")}`,
				path,
			});
		}
		// The false NEGATIVE half: "at least one right kind" let a DASH output
		// carry an FMP4 *and* a TS muxing. Warning, not error — see the header.
		const wrongContainers = need.forbidden.filter((k) => muxingKinds.has(k));
		if (wrongContainers.length > 0) {
			issues.push({
				code: "C31",
				level: "warning",
				message: `Akamai MSL output "${output.key}" is ${format}, which we do not expect to accept ${wrongContainers.join(", ")} muxings beside its own — split them to another output (unverified against a real Akamai stream)`,
				path,
			});
		}
		const wrongManifests = need.forbiddenManifests.filter((k) =>
			manifestKinds.has(k),
		);
		if (wrongManifests.length > 0) {
			issues.push({
				code: "C31",
				level: "warning",
				message: `Akamai MSL output "${output.key}" is ${format}, which we do not expect to accept ${wrongManifests.join(", ")} manifest(s) beside its own — split them to another output (unverified against a real Akamai stream)`,
				path,
			});
		}
	}
	return issues;
}

export type { AkamaiMslVersion } from "./schema";
/**
 *  — the VERSION enum's exhaustiveness anchor.
 * `akamaiMslStreamFormatSchema`'s `satisfies` guard protects the FORMAT axis;
 * this Record protects the VERSION axis: adding a member to the enum without
 * deciding its behavior is a tsc error here, never a runtime throw thirty ops
 * in. Kill-verified at landing (planting "MSL5" into the array turned tsc red
 * on the missing entry) and re-verified when the payload changed below.
 *
 * THE PAYLOAD CHANGED, AND THAT IS THE POINT (2026-08-27, Track 2b).
 * Track 2a's only property was `requiresExperimentalGate`, which became
 * meaningless the day MSL5 went GA and the gate was retired. The tempting edit
 * is to delete the Record along with the gate — and that would silently cost
 * the version axis its only guard, so a future MSL6 would be a runtime throw
 * rather than a compile error (review I3). It is REPLACED instead.
 *
 * `publishingAuth` is what the anchor now forces a decision about, and it is a
 * THREE-state fact rather than a boolean — which a review caught after the
 * boolean had already shipped. The field's own docstring in 1.278.0:
 *
 *   "MSL5 only. HTTP Digest publishing credentials. Sending this field with
 *    `mslVersion: MSL4` is rejected. Credentials (username, password) are
 *    write-only and not returned in responses."
 *
 * So MSL4 is not "does not support it" — sending it is a 400. And MSL5 is not
 * "requires it": `publishingAuthentication` is the ONLY field on
 * `AkamaiMslOutput` with no "(required)" marker in its prose, and the class
 * docstring says an omitted object means credentials are ignored. A boolean
 * collapses those two facts into one bit and loses whichever the reader needs.
 *
 * Worth knowing generally, because it defeats the obvious way of reading this
 * model: THIS GENERATOR EMITS EVERY FIELD WITH `?`, including ones the prose
 * marks "(required)" — `streamId?: number` is "(required)". TypeScript
 * optionality carries no information here. The docstring does.
 *
 * `minEncoderVersion` is required-but-nullable and a numeric tuple. The
 * version rail consumes it at Live validation/compilation; unresolved aliases
 * warn rather than being compared lexically. MSL4 has no documented floor.
 */
// review-161-162 M7: re-exported from the SCHEMA — the enum that decides
// whether a version can exist and the Record that decides its behavior key
// on one list. A local copy here was a parallel universe the anchor watched
// while schema.ts decided reality.
export { AKAMAI_MSL_VERSIONS } from "./schema";

import type { AkamaiMslVersion } from "./schema";
export const AKAMAI_MSL_VERSION_BEHAVIOR = {
	MSL4: {
		/** Sending `publishingAuthentication` here is REJECTED, not ignored —
		 * the account key authenticates (C31). */
		publishingAuth: "FORBIDDEN",
		/** No documented floor. NULL is a decision, not an omission — see the
		 * required-but-nullable note above. */
		minEncoderVersion: null,
		/** VOD is REPRESENTABLE (the output is in `planOutputSchema` and the VOD
		 * compiler emits the op), so this records what is allowed, not what is
		 * advisable. */
		encodingKinds: ["LIVE", "VOD"],
	},
	MSL5: {
		/** Optional, not required: `publishingAuthentication` is the only field
		 * on `AkamaiMslOutput` with no "(required)" marker, and an omitted
		 * object means the encoder publishes unauthenticated (§3 rail 3b). */
		publishingAuth: "OPTIONAL",
		/** Encoder 2.283.0 (BETA, 2026-08-26) is the release that shipped
		 * "[LIVE] Akamai MSL5 output is now supported". A TUPLE, never a
		 * string: `"2.9.0" >= "2.283.0"` is `true` and that bug must not be
		 * re-importable into the anchor itself. */
		minEncoderVersion: [2, 283, 0],
		/** Same upstream rule set: "MSL5 outputs rejected on non-live
		 * encodings". This is rail 6's data-driven home — without it the rail
		 * is a hardcoded `if` that the next version silently inherits MSL4's
		 * permissiveness from. */
		encodingKinds: ["LIVE"],
	},
} as const satisfies Record<
	AkamaiMslVersion,
	{
		publishingAuth: "FORBIDDEN" | "OPTIONAL" | "REQUIRED";
		minEncoderVersion: readonly [number, number, number] | null;
		encodingKinds: readonly ("LIVE" | "VOD")[];
	}
>;
