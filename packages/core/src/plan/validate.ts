import { vmafSourceFor } from "../vmaf/streamable-io";
import {
	enumerateFrameIndexQcTargets,
	enumerateQcTargets,
} from "../vmaf/targets";
import { checkAkamaiMslConstraints } from "./akamai-msl-constraint";
import {
	checkAv1CodecControls,
	checkH26xCodecControls,
} from "./codec-controls";
import { checkCodecDetailControls } from "./codec-detail-controls";
import { qcMirrorMuxingKind, renditionOutputBase } from "./compiler";
import { dashAudioLegSelected, dashVideoLegSelected } from "./dash-legs";
import { defaultHlsPathConflicts } from "./default-manifest-paths";
import { defaultManifestSelection } from "./default-manifest-selection";
import {
	checkSecretEgressHosts,
	type EgressSite,
	type SecretEgressAllowlist,
} from "./egress";
import { hlsLegSelected, hlsVersionForLegs } from "./hls-legs";
import {
	hlsAudioMediaDefaults,
	hlsChildEntries,
	hlsStaticChildUris,
	hlsSubtitleGroups,
	isHlsAudioRendition,
} from "./hls-media-defaults";
import { checkHlsVideoUris } from "./hls-video-uri-validation";
import {
	inputStreamAncestry,
	inputStreamDependencies,
	inputStreamLeaves,
} from "./input-stream-graph";
import { checkInternalHevcV2Plan } from "./internal-hevc-v2";
import { validateManifestDetails } from "./manifest-detail-validation";
import { filterFamily } from "./media-filters";
import { hasMuxedInAudio, muxingStreamKeys } from "./muxing-streams";
import { isPerTitleRendition } from "./per-title-results";
import { AUDIO_CODECS, type EncodingPlan, vmafModelNeedsFile } from "./schema";

const VIDEO_CODECS_FOR_MODE = new Set(["H264", "H265", "VP9", "AV1"]);

/**
 * Plan-level (cross-field) validation per ARCHITECTURE §3 — runs after zod
 * parsing, before compilation. Codes C1–C11 map to
 * docs/BITMOVIN-API-COVERAGE.md §0; PLAN_* codes are structural integrity.
 *
 * P1 notes:
 * - C1 (per-title + custom manifests ⇒ post-encoding) cannot trigger yet:
 *   renditions only allow STANDARD mode and manifests only the sample
 *   shape. The check is wired now so the constraint engine (and its tests)
 *   exist before P2 widens the schema.
 * - C2 (start-request trimming ⊻ InputStream resources) has no trimming
 *   field in v1 plans — guard arrives with the trimming schema (P2).
 * - C3 is enforced by construction: the compiler always emits
 *   manifestGenerator V2 on JIT starts.
 */

export type PlanIssueLevel = "error" | "warning";

export type PlanIssue = {
	code: string;
	level: PlanIssueLevel;
	message: string;
	path: string;
};

function checkUniqueKeys(
	items: { key: string }[],
	collection: string,
	issues: PlanIssue[],
): void {
	const seen = new Set<string>();
	for (const item of items) {
		if (seen.has(item.key)) {
			issues.push({
				code: "PLAN_DUPLICATE_KEY",
				level: "error",
				message: `Duplicate key "${item.key}" in ${collection}`,
				path: collection,
			});
		}
		seen.add(item.key);
	}
}

/**
 * Caller-supplied context that pure plan data cannot provide.
 *
 * Every field is optional and omitting one means "I am not the enforcement
 * point for this" — the client-side wizard preview passes nothing, the API
 * routes pass everything, and neither has to know about the other.
 */
export type PlanValidationOptions = {
	/**
	 * Hostnames permitted to receive vaulted credentials (COVERAGE C22).
	 * See `SecretEgressAllowlist` for what `undefined` vs `[]` mean — they are
	 * different states, not two spellings of "off".
	 */
	secretEgressAllowedHosts?: SecretEgressAllowlist;
	/**
	 * Credential ids known to carry an MSL5 Digest publishing pair — ledger
	 * #162, rail 3b. Resolved SERVER-SIDE (it needs the vault), threaded the
	 * way `credentialProviders` already is.
	 *
	 * Left `undefined` by client previews and imports on purpose: a browser
	 * cannot read vault material, and warning from there would be a warning
	 * about a fact it does not have. The rail says nothing rather than
	 * guessing.
	 */
	credentialHasPublishingAuth?: ReadonlySet<string>;
	/**
	 * Do not BLOCK on QC readability for a plan that was ALREADY submitted —
	 * report it as a warning instead .
	 *
	 * The `skipDeliveryCommitment` precedent (#82 / review-210 C1) says a rail
	 * added later must not retroactively make a FINISHED job un-re-runnable:
	 * there is no in-app way to strip `qc` from a persisted plan. The re-run
	 * path sets this; every fresh-submission door leaves it off.
	 *
	 * A DOWNGRADE rather than a skip, which review argued for and is strictly
	 * better than the first cut: skipping suppressed the issue entirely, so the
	 * operator re-running a QC'd job learned nothing about why the measurement
	 * would fail again — and the non-gated warning that finding 3 existed to
	 * preserve vanished on exactly the path that most needs it. Warnings are
	 * carried: `submitEncodingJob` returns them and `recordEgress` records
	 * them, so this keeps the record while removing the block.
	 */
	demoteQcIoReadable?: boolean;
	/**
	 * Demote the unpackaged-AUDIO refusal to a warning — RE-RUN ONLY.
	 *
	 * `PLAN_UNMUXED_RENDITION` became an error for audio in #192 so a plan that
	 * silently drops a track is stopped at the submit boundary. That is right
	 * for a NEW submission and wrong for an old one: `rerun-job.ts` validates
	 * the SOURCE job's persisted plan, so promoting the level retroactively
	 * made every already-FINISHED job with that shape un-re-runnable — and the
	 * jobs with that shape are exactly the ones the pre-fix wizard produced,
	 * i.e. the operators the rail was written to protect are the ones it locked
	 * out. There is no in-app way to edit a persisted plan, so their only route
	 * was rebuilding the job by hand.
	 *
	 * This file already states the principle, beside `skipDeliveryCommitment`:
	 * "a later tightening would retroactively make a FINISHED job
	 * un-re-runnable … History is not re-litigated; new submissions are."
	 *
	 * Demoted, not skipped — the same choice `demoteQcIoReadable` made and for
	 * the same reason. The warning is carried: `submitEncodingJob` returns it
	 * and `recordEgress` records it, so the operator re-running a silent job
	 * still learns it is silent. Re-running is safe on its own terms: it
	 * reproduces what the job already produced, and blocking it prevents no
	 * silence, because the silent delivery already happened.
	 *
	 * Deliberately NOT set for the watch-folder sweep, which auto-submits from
	 * a stored preset. That is a NEW submission of an old plan, and the
	 * precedent it follows is explicit that the skip is "ONLY for re-run" — a
	 * rule that would keep minting silent deliveries on every drop is the case
	 * the error exists for. See the ledger row for the door that leaves open.
	 */
	demoteUnmuxedAudio?: boolean;
	/**
	 * VMAF model names the SCORING worker can actually load — the built-ins it
	 * always has, plus whatever `VMAF_MODEL_DIR` holds. Omitted ⇒ the check is
	 * skipped (an unknown capability must not manufacture a refusal).
	 *
	 * Exists because a model that resolves to neither a built-in nor a bundled
	 * file fails at SCORING time, i.e. after the Bitmovin encode has finished
	 * and every QC mirror has been downloaded — a paid encode spent to learn
	 * the model was wrong (review-234 I2, live since the default became a
	 * file-only VMAF v1 model).
	 */
	availableVmafModels?: readonly string[];
	/** credentialId → provider, used to verify DRM credential compatibility. */
	credentialProviders?: ReadonlyMap<string, string>;
};

/** Every place this plan makes the encoder POST vault material to a host. */
function secretEgressSites(plan: EncodingPlan): EgressSite[] {
	const sites: EgressSite[] = [];
	if (plan.kantar) {
		sites.push({
			field: "kantar.serverUrl",
			url: plan.kantar.serverUrl,
			carries: "the Kantar watermarking login and password",
		});
	}
	return sites;
}

export function validatePlan(
	plan: EncodingPlan,
	options: PlanValidationOptions = {},
): PlanIssue[] {
	const issues: PlanIssue[] = checkInternalHevcV2Plan(plan);
	issues.push(...checkH26xCodecControls(plan.renditions));
	issues.push(...checkAv1CodecControls(plan.renditions));
	issues.push(...checkCodecDetailControls(plan.renditions));
	issues.push(...checkHlsVideoUris(plan));
	for (const [i, output] of plan.outputs.entries())
		if (output.kind === "LIVE_MEDIA_INGEST")
			issues.push({
				code: "PLAN_LIVE_OUTPUT_ONLY",
				level: "error",
				path: `outputs.${i}`,
				message: "Live Media Ingest is available for Live channels only",
			});

	if (plan.qc && options.availableVmafModels) {
		const model = plan.qc.model;
		if (!options.availableVmafModels.includes(model)) {
			issues.push({
				level: "error",
				code: "PLAN_VMAF_MODEL_UNAVAILABLE",
				path: "qc.model",
				message:
					`VMAF model "${model}" is not available on the scoring worker. ` +
					(vmafModelNeedsFile(model)
						? `It is not a libvmaf built-in, so it loads from a bundled ` +
							`"${model}.json" — run the Docker worker image (it ships the ` +
							`VMAF v1 models) or set VMAF_MODEL_DIR to a directory holding ` +
							`it. The vmaf_v0.6.1 family works as a built-in everywhere.`
						: `Available: ${options.availableVmafModels.join(", ")}.`),
			});
		}
	}

	checkUniqueKeys(plan.inputs, "inputs", issues);
	checkUniqueKeys(plan.outputs, "outputs", issues);
	// ingest + fileStreams + dolbyStreams + trimming/concat input streams all
	// share the `ingestKey` namespace (a rendition references any of them).
	checkUniqueKeys(
		[
			...plan.ingest,
			...plan.fileStreams,
			...plan.dolbyStreams,
			...plan.trimmingStreams,
			...plan.concatenationStreams,
			...plan.audioMixStreams,
		],
		"ingest",
		issues,
	);
	checkUniqueKeys(plan.encodings ?? [], "encodings", issues);
	checkUniqueKeys(plan.renditions, "renditions", issues);
	checkUniqueKeys(plan.filters, "filters", issues);
	checkUniqueKeys(plan.muxings, "muxings", issues);
	checkUniqueKeys(plan.drm, "drm", issues);
	checkUniqueKeys(plan.thumbnails, "thumbnails", issues);
	checkUniqueKeys(plan.sprites, "sprites", issues);
	checkUniqueKeys(plan.keyframes, "keyframes", issues);
	checkUniqueKeys(plan.manifests, "manifests", issues);
	issues.push(...validateManifestDetails(plan));

	const inputKeys = new Set(plan.inputs.map((i) => i.key));
	const outputKeys = new Set(plan.outputs.map((o) => o.key));
	const ingestKeys = new Set(plan.ingest.map((s) => s.key));
	const fileKeys = new Set(plan.fileStreams.map((f) => f.key));
	const ingestByKey = new Map(plan.ingest.map((s) => [s.key, s]));
	//  — deliveryMirrors: every key resolves, no key twice, and no
	// mirror may equal a destination's own output (the SDK would receive the
	// same output twice in one outputs array — a plan smell, not a feature).
	if (plan.deliveryMirrors) {
		const seenMirrors = new Set<string>();
		for (const [index, mirror] of plan.deliveryMirrors.entries()) {
			if (!outputKeys.has(mirror.outputKey)) {
				issues.push({
					code: "PLAN_UNRESOLVED_REF",
					level: "error",
					message: `deliveryMirrors[${index}] references unknown output "${mirror.outputKey}"`,
					path: `deliveryMirrors.${index}.outputKey`,
				});
			}
			if (seenMirrors.has(mirror.outputKey)) {
				issues.push({
					code: "PLAN_DUPLICATE_KEY",
					level: "error",
					message: `deliveryMirrors lists output "${mirror.outputKey}" twice`,
					path: `deliveryMirrors.${index}.outputKey`,
				});
			}
			seenMirrors.add(mirror.outputKey);
		}
		const destinationSites: [string, { outputKey: string } | undefined][] = [
			...plan.muxings.map(
				(m, i) =>
					[`muxings.${i}`, m.destination] as [
						string,
						{ outputKey: string } | undefined,
					],
			),
			...plan.drm.map(
				(d, i) =>
					[`drm.${i}`, d.destination] as [
						string,
						{ outputKey: string } | undefined,
					],
			),
			...plan.manifests.map(
				(m, i) =>
					[`manifests.${i}`, m.destination] as [
						string,
						{ outputKey: string } | undefined,
					],
			),
			// review-250 115-A3: EVERY family whose destination fans out at
			// compile — the first cut scanned 3 of 6, and a thumbnail colliding
			// with a mirror would have reached the SDK writing twice.
			...plan.thumbnails.map(
				(t, i) =>
					[`thumbnails.${i}`, t.destination] as [
						string,
						{ outputKey: string } | undefined,
					],
			),
			...plan.sprites.map(
				(s, i) =>
					[`sprites.${i}`, s.destination] as [
						string,
						{ outputKey: string } | undefined,
					],
			),
		];
		for (const [sitePath, destination] of destinationSites) {
			if (destination && seenMirrors.has(destination.outputKey)) {
				issues.push({
					code: "PLAN_DUPLICATE_KEY",
					level: "error",
					message: `${sitePath} writes to output "${destination.outputKey}" which is ALSO a delivery mirror — it would receive the same object twice`,
					path: `${sitePath}.destination.outputKey`,
				});
			}
		}
	}
	const fileByKey = new Map(plan.fileStreams.map((f) => [f.key, f]));
	const dolbyByKey = new Map(plan.dolbyStreams.map((d) => [d.key, d]));
	const trimmingKeys = new Set(plan.trimmingStreams.map((t) => t.key));
	const concatKeys = new Set(plan.concatenationStreams.map((c) => c.key));
	// Every key a rendition's ingestKey OR a trim/concat sourceKey may resolve
	// to — the full shared input-stream namespace.
	const inputStreamKeys = new Set<string>([
		...ingestKeys,
		...fileKeys,
		...dolbyByKey.keys(),
		...trimmingKeys,
		...concatKeys,
		...plan.audioMixStreams.map((s) => s.key),
	]);
	const filterKeys = new Set(plan.filters.map((f) => f.key));
	const renditionKeys = new Set(plan.renditions.map((r) => r.key));
	const renditionByKey = new Map(plan.renditions.map((r) => [r.key, r]));

	for (const [index, stream] of plan.ingest.entries()) {
		if (!inputKeys.has(stream.inputKey)) {
			issues.push({
				code: "PLAN_UNRESOLVED_REF",
				level: "error",
				message: `ingest "${stream.key}" references unknown input "${stream.inputKey}"`,
				path: `ingest[${index}].inputKey`,
			});
		}
	}
	for (const [index, file] of plan.fileStreams.entries()) {
		if (!inputKeys.has(file.inputKey)) {
			issues.push({
				code: "PLAN_UNRESOLVED_REF",
				level: "error",
				message: `fileStream "${file.key}" references unknown input "${file.inputKey}"`,
				path: `fileStreams[${index}].inputKey`,
			});
		}
	}

	if (
		plan.ingest.length + plan.fileStreams.length + plan.dolbyStreams.length ===
		0
	) {
		issues.push({
			code: "PLAN_NO_INPUT_STREAMS",
			level: "error",
			message: "the plan defines no input streams (ingest/file/dolby)",
			path: "ingest",
		});
	}
	for (const [index, dolby] of plan.dolbyStreams.entries()) {
		if (!inputKeys.has(dolby.inputKey)) {
			issues.push({
				code: "PLAN_UNRESOLVED_REF",
				level: "error",
				message: `dolbyStream "${dolby.key}" references unknown input "${dolby.inputKey}"`,
				path: `dolbyStreams[${index}].inputKey`,
			});
		}
	}

	// Trimming input streams wrap another declared input stream by sourceKey.
	for (const [index, trim] of plan.trimmingStreams.entries()) {
		if (trim.sourceKey === trim.key || !inputStreamKeys.has(trim.sourceKey)) {
			issues.push({
				code: "PLAN_TRIMMING_UNRESOLVED_SOURCE",
				level: "error",
				message: `trimming stream "${trim.key}" references unknown source input stream "${trim.sourceKey}"`,
				path: `trimmingStreams[${index}].sourceKey`,
			});
		}
	}

	// Concatenation input streams stitch ≥1 sources, exactly one main.
	for (const [index, concat] of plan.concatenationStreams.entries()) {
		let mainCount = 0;
		const seenPositions = new Set<number>();
		for (const [sIndex, source] of concat.sources.entries()) {
			if (
				source.sourceKey === concat.key ||
				!inputStreamKeys.has(source.sourceKey)
			) {
				issues.push({
					code: "PLAN_CONCAT_UNRESOLVED_SOURCE",
					level: "error",
					message: `concatenation stream "${concat.key}" references unknown source input stream "${source.sourceKey}"`,
					path: `concatenationStreams[${index}].sources[${sIndex}].sourceKey`,
				});
			}
			if (source.isMain) {
				mainCount += 1;
			}
			// position is the SDK ordering key — duplicates make order ambiguous.
			if (source.position !== undefined) {
				if (seenPositions.has(source.position)) {
					issues.push({
						code: "PLAN_CONCAT_DUPLICATE_POSITION",
						level: "error",
						message: `concatenation stream "${concat.key}" reuses position ${source.position}`,
						path: `concatenationStreams[${index}].sources[${sIndex}].position`,
					});
				}
				seenPositions.add(source.position);
			}
		}
		if (mainCount !== 1) {
			issues.push({
				code: "PLAN_CONCAT_MAIN_COUNT",
				level: "error",
				message: `concatenation stream "${concat.key}" must have exactly one source with isMain: true (got ${mainCount})`,
				path: `concatenationStreams[${index}].sources`,
			});
		}
	}

	// A trim/concat may wrap ANOTHER trim/concat, but the compiler emits them in
	// array order (all trimmingStreams, then all concatenationStreams) before any
	// CREATE_STREAM — so a source that targets another trim/concat must be
	// declared earlier in that emission order. Otherwise the compiler emits a
	// forward ref (or, for a cycle, a mutual pair) that the orchestrator cannot
	// resolve at run time. validatePlan must reject it here, not let it pass
	// pre-flight and fail mid-encode. Sources on ingest/file/dolby always precede
	// trim/concat, so only trim/concat→trim/concat edges need ordering.
	const emissionIndex = new Map<string, number>();
	plan.trimmingStreams.forEach((t, i) => {
		emissionIndex.set(t.key, i);
	});
	plan.concatenationStreams.forEach((c, j) => {
		emissionIndex.set(c.key, plan.trimmingStreams.length + j);
	});
	plan.audioMixStreams.forEach((s, i) => {
		emissionIndex.set(
			s.key,
			plan.trimmingStreams.length + plan.concatenationStreams.length + i,
		);
	});
	const isTrimOrConcatKey = (k: string) =>
		trimmingKeys.has(k) ||
		concatKeys.has(k) ||
		plan.audioMixStreams.some((s) => s.key === k);
	const forwardRef = (sourceKey: string, ownKey: string) =>
		sourceKey !== ownKey &&
		isTrimOrConcatKey(sourceKey) &&
		// biome-ignore lint/style/noNonNullAssertion: both keys are in the map.
		emissionIndex.get(sourceKey)! >= emissionIndex.get(ownKey)!;
	for (const [index, trim] of plan.trimmingStreams.entries()) {
		if (forwardRef(trim.sourceKey, trim.key)) {
			issues.push({
				code: "PLAN_INPUTSTREAM_FORWARD_REF",
				level: "error",
				message: `trimming stream "${trim.key}" wraps "${trim.sourceKey}", which is not declared earlier (forward reference or cycle — a trim/concat source must precede its use)`,
				path: `trimmingStreams[${index}].sourceKey`,
			});
		}
	}
	for (const [index, concat] of plan.concatenationStreams.entries()) {
		for (const [sIndex, source] of concat.sources.entries()) {
			if (forwardRef(source.sourceKey, concat.key)) {
				issues.push({
					code: "PLAN_INPUTSTREAM_FORWARD_REF",
					level: "error",
					message: `concatenation stream "${concat.key}" wraps "${source.sourceKey}", which is not declared earlier (forward reference or cycle)`,
					path: `concatenationStreams[${index}].sources[${sIndex}].sourceKey`,
				});
			}
		}
	}

	const allInputStreams = [
		...plan.ingest,
		...plan.fileStreams,
		...plan.dolbyStreams,
		...plan.trimmingStreams,
		...plan.concatenationStreams,
		...plan.audioMixStreams,
	];
	for (const [index, mix] of plan.audioMixStreams.entries()) {
		for (const [i, channel] of mix.audioMixChannels.entries()) {
			const path = `audioMixStreams[${index}].audioMixChannels[${i}].sourceKey`;
			const leaves = inputStreamLeaves(plan, channel.sourceKey);
			if (!leaves || channel.sourceKey === mix.key)
				issues.push({
					code: "PLAN_UNRESOLVED_REF",
					level: "error",
					path,
					message: `Audio mix "${mix.key}" has an unknown or cyclic source "${channel.sourceKey}"`,
				});
			if (forwardRef(channel.sourceKey, mix.key))
				issues.push({
					code: "PLAN_INPUTSTREAM_FORWARD_REF",
					level: "error",
					path,
					message: "Audio mix sources must precede their use",
				});
			if (
				inputStreamAncestry(plan, channel.sourceKey)?.some(
					(key) =>
						fileByKey.has(key) ||
						ingestByKey.get(key)?.selectionMode === "VIDEO_RELATIVE" ||
						(dolbyByKey.has(key) && dolbyByKey.get(key)?.kind !== "ATMOS"),
				)
			)
				issues.push({
					code: "PLAN_UNRESOLVED_REF",
					level: "error",
					path,
					message: "Audio mix requires audio input streams",
				});
			const source = allInputStreams.find((s) => s.key === channel.sourceKey);
			if (
				source?.encodingKey !== mix.encodingKey ||
				inputStreamAncestry(plan, channel.sourceKey)?.some(
					(key) =>
						allInputStreams.find((s) => s.key === key)?.encodingKey !==
						mix.encodingKey,
				)
			)
				issues.push({
					code: "PLAN_ENCODING_SOURCE_MISMATCH",
					level: "error",
					path,
					message: "Audio mix and its sources must belong to the same encoding",
				});
		}
	}
	for (const [index, rendition] of plan.renditions.entries()) {
		// A mix may also be reached through trimming/concatenation wrappers.
		const visitsMix = (key: string, seen = new Set<string>()): boolean => {
			if (seen.has(key)) return false;
			if (plan.audioMixStreams.some((s) => s.key === key)) return true;
			seen.add(key);
			return inputStreamDependencies(plan, key).some((k) => visitsMix(k, seen));
		};
		if (
			visitsMix(rendition.ingestKey) &&
			(!AUDIO_CODECS.has(rendition.codec) || rendition.codec === "DOLBY_ATMOS")
		)
			issues.push({
				code: "PLAN_STREAM_SOURCE_MISMATCH",
				level: "error",
				path: `renditions[${index}].ingestKey`,
				message:
					"Audio mix can only feed AAC, Opus, Dolby Digital or Dolby Digital Plus renditions",
			});
	}
	// Multi-encoding partition rails (Dolby ladders).
	const encodingKeys = new Set((plan.encodings ?? []).map((e) => e.key));
	const multi = (plan.encodings?.length ?? 0) > 0;
	const checkEncodingKey = (
		owner: string,
		encodingKey: string | undefined,
		path: string,
	) => {
		if (multi) {
			if (!encodingKey || !encodingKeys.has(encodingKey)) {
				issues.push({
					code: "PLAN_UNRESOLVED_REF",
					level: "error",
					message: `${owner} must reference one of plan.encodings (got "${encodingKey ?? "<absent>"}")`,
					path,
				});
			}
		} else if (encodingKey !== undefined) {
			issues.push({
				code: "PLAN_UNRESOLVED_REF",
				level: "error",
				message: `${owner} sets encodingKey but the plan declares no encodings`,
				path,
			});
		}
	};
	plan.ingest.forEach((s, i) => {
		checkEncodingKey(
			`ingest "${s.key}"`,
			s.encodingKey,
			`ingest[${i}].encodingKey`,
		);
	});
	plan.fileStreams.forEach((s, i) => {
		checkEncodingKey(
			`fileStream "${s.key}"`,
			s.encodingKey,
			`fileStreams[${i}].encodingKey`,
		);
	});
	plan.dolbyStreams.forEach((s, i) => {
		checkEncodingKey(
			`dolbyStream "${s.key}"`,
			s.encodingKey,
			`dolbyStreams[${i}].encodingKey`,
		);
	});
	plan.trimmingStreams.forEach((s, i) => {
		checkEncodingKey(
			`trimming stream "${s.key}"`,
			s.encodingKey,
			`trimmingStreams[${i}].encodingKey`,
		);
	});
	plan.audioMixStreams.forEach((s, i) => {
		checkEncodingKey(
			`audio mix "${s.key}"`,
			s.encodingKey,
			`audioMixStreams[${i}].encodingKey`,
		);
	});
	plan.concatenationStreams.forEach((s, i) => {
		checkEncodingKey(
			`concatenation stream "${s.key}"`,
			s.encodingKey,
			`concatenationStreams[${i}].encodingKey`,
		);
	});
	plan.renditions.forEach((r, i) => {
		checkEncodingKey(
			`rendition "${r.key}"`,
			r.encodingKey,
			`renditions[${i}].encodingKey`,
		);
	});
	plan.keyframes.forEach((k, i) => {
		checkEncodingKey(
			`keyframe "${k.key}"`,
			k.encodingKey,
			`keyframes[${i}].encodingKey`,
		);
	});
	if (multi && plan.generation.timing === "JUST_IN_TIME") {
		issues.push({
			code: "PLAN_MULTI_ENCODING_JIT",
			level: "error",
			message:
				"multi-encoding plans generate merged manifests post-encoding — JIT cannot reference muxings across encodings",
			path: "generation.timing",
		});
	}
	if (multi && plan.perTitle) {
		issues.push({
			code: "PLAN_MULTI_ENCODING_PER_TITLE",
			level: "error",
			message: "per-title and multi-encoding partitioning cannot combine",
			path: "perTitle",
		});
	}
	if (multi && plan.aiSceneAnalysis) {
		// The START payload would replicate the same analysis (and the same
		// asset-description output object) into every sibling encoding.
		issues.push({
			code: "PLAN_MULTI_ENCODING_AISA",
			level: "error",
			message:
				"AI Scene Analysis and multi-encoding partitioning cannot combine — every sibling start would race the same asset-description output",
			path: "aiSceneAnalysis",
		});
	}
	if (plan.bitmovin.infrastructure) {
		// C18: Cloud Connect encodings must set cloudRegion EXTERNAL — the
		// real region lives INSIDE InfrastructureSettings. A managed-cloud
		// region alongside an infrastructure block is rejected by Bitmovin
		// (or worse: silently runs on managed cloud while the BYOC fleet
		// idles and the customer double-pays).
		if (plan.bitmovin.cloudRegion !== "EXTERNAL") {
			issues.push({
				code: "PLAN_INFRASTRUCTURE_REQUIRES_EXTERNAL_REGION",
				level: "error",
				message: `bitmovin.infrastructure is set but cloudRegion is "${plan.bitmovin.cloudRegion}" — Cloud Connect requires cloudRegion EXTERNAL (the in-infrastructure region rides InfrastructureSettings.cloudRegion)`,
				path: "bitmovin.cloudRegion",
			});
		}
		(plan.encodings ?? []).forEach((enc, i) => {
			if (enc.cloudRegion !== undefined && enc.cloudRegion !== "EXTERNAL") {
				issues.push({
					code: "PLAN_INFRASTRUCTURE_REQUIRES_EXTERNAL_REGION",
					level: "error",
					message: `encoding "${enc.key}" overrides cloudRegion to "${enc.cloudRegion}" while bitmovin.infrastructure is set — every sibling of a Cloud Connect plan must use EXTERNAL`,
					path: `encodings[${i}].cloudRegion`,
				});
			}
		});
	} else {
		// C18 inverse (review round 2 catch): EXTERNAL declares a Cloud
		// Connect run — without an infrastructure block Bitmovin has nowhere
		// to run it. The wizard's clear-the-pair path (auto-switch does NOT
		// switch back) manufactures exactly this state, and imported plans
		// can carry it too.
		const externalSites: string[] = [];
		if (plan.bitmovin.cloudRegion === "EXTERNAL") {
			externalSites.push("bitmovin.cloudRegion");
		}
		(plan.encodings ?? []).forEach((enc, i) => {
			if (enc.cloudRegion === "EXTERNAL") {
				externalSites.push(`encodings[${i}].cloudRegion`);
			}
		});
		for (const path of externalSites) {
			issues.push({
				code: "PLAN_EXTERNAL_REGION_REQUIRES_INFRASTRUCTURE",
				level: "error",
				message:
					"cloudRegion EXTERNAL declares a Cloud Connect run but no bitmovin.infrastructure block is set — fill the infrastructure pair or pick a managed-cloud region",
				path,
			});
		}
	}
	if (plan.generation.timing === "JUST_IN_TIME") {
		// A preview-ONLY manifest is generated while the encoding runs but is
		// never finalized as a VOD manifest — legitimate (watch-while-encoding
		// throwaway), but worth a loud nudge toward VOD_AND_PREVIEW.
		plan.manifests.forEach((m, i) => {
			if (m.kind !== "SMOOTH" && m.jitPlacement === "PREVIEW") {
				issues.push({
					code: "PLAN_PREVIEW_ONLY_MANIFEST",
					level: "warning",
					message: `manifest "${m.key}" rides ONLY the preview list — it is generated during the run but never finalized as a VOD manifest (use VOD_AND_PREVIEW to also keep the final manifest)`,
					path: `manifests[${i}].jitPlacement`,
				});
			}
		});
	}
	if (plan.kantar) {
		// The report destination is a normal plan destination.
		if (!outputKeys.has(plan.kantar.reportDestination.outputKey)) {
			issues.push({
				code: "PLAN_UNRESOLVED_REF",
				level: "error",
				message: `kantar.reportDestination references unknown output "${plan.kantar.reportDestination.outputKey}"`,
				path: "kantar.reportDestination.outputKey",
			});
		}
		// Kantar is an AUDIO watermark: it embeds an inaudible signal in the
		// encode's audio. A plan with no audio rendition would configure the
		// service, be billed for the license, and watermark nothing.
		const hasAudio = plan.renditions.some((r) => AUDIO_CODECS.has(r.codec));
		if (!hasAudio) {
			issues.push({
				code: "PLAN_KANTAR_NEEDS_AUDIO",
				level: "error",
				message:
					"kantar watermarking needs at least one audio rendition — it embeds an inaudible signal in the audio, so a video-only encode watermarks nothing",
				path: "kantar",
			});
		}
	}
	if (plan.generation.audioVideoSyncMode) {
		// COVERAGE §0: Tweaks.audioVideoSyncMode does not work with Dolby
		// Digital (Plus) / Atmos — the API rejects the combination.
		const dolby = plan.renditions.find(
			(r) =>
				r.codec === "DOLBY_ATMOS" ||
				r.codec === "DDPLUS" ||
				r.codec === "DD" ||
				r.codec === "AC3" ||
				r.codec === "EAC3",
		);
		if (dolby) {
			issues.push({
				code: "PLAN_TWEAKS_DOLBY_CONFLICT",
				level: "error",
				message: `tweaks.audioVideoSyncMode does not work with Dolby Digital (Plus) / Atmos codecs (rendition "${dolby.key}")`,
				path: "generation.audioVideoSyncMode",
			});
		}
	}
	if (plan.generation.timing !== "JUST_IN_TIME") {
		// Preview manifests exist only as start-request lists — a
		// POST_ENCODING plan has no start-time manifest lists to ride.
		plan.manifests.forEach((m, i) => {
			if (
				m.kind !== "SMOOTH" &&
				(m.jitPlacement === "PREVIEW" || m.jitPlacement === "VOD_AND_PREVIEW")
			) {
				issues.push({
					code: "PLAN_PREVIEW_REQUIRES_JIT",
					level: "error",
					message: `manifest "${m.key}" requests a preview placement — preview manifests ride the start request, which requires generation.timing JUST_IN_TIME`,
					path: `manifests[${i}].jitPlacement`,
				});
			}
		});
	}

	const visionFormats = new Map<
		string,
		{ format: string; renditionKey: string }
	>();
	for (const [index, rendition] of plan.renditions.entries()) {
		if (rendition.burnInSrt) {
			if (!VIDEO_CODECS_FOR_MODE.has(rendition.codec))
				issues.push({
					code: "PLAN_BURN_IN_VIDEO_ONLY",
					level: "error",
					message: "SRT burn-in requires a video rendition",
					path: `renditions[${index}].burnInSrt`,
				});
			if (!inputKeys.has(rendition.burnInSrt.inputKey))
				issues.push({
					code: "PLAN_UNRESOLVED_REF",
					level: "error",
					message: "SRT burn-in references an unknown input",
					path: `renditions[${index}].burnInSrt.inputKey`,
				});
		}
		if (!inputStreamKeys.has(rendition.ingestKey)) {
			issues.push({
				code: "PLAN_UNRESOLVED_REF",
				level: "error",
				message: `rendition "${rendition.key}" references unknown ingest "${rendition.ingestKey}"`,
				path: `renditions[${index}].ingestKey`,
			});
		}
		// Subtitle tracks consume whole files; AV renditions consume tracks
		// (an ingest track or a trimming/concat intermediate stream over one).
		if (
			(rendition.codec === "WEBVTT" || rendition.codec === "IMSC") &&
			(ingestKeys.has(rendition.ingestKey) ||
				trimmingKeys.has(rendition.ingestKey) ||
				concatKeys.has(rendition.ingestKey))
		) {
			issues.push({
				code: "PLAN_STREAM_SOURCE_MISMATCH",
				level: "error",
				message: `${rendition.codec} rendition "${rendition.key}" must reference a fileStream, not an ingest/trimming/concatenation track`,
				path: `renditions[${index}].ingestKey`,
			});
		}
		if (
			rendition.codec !== "WEBVTT" &&
			rendition.codec !== "IMSC" &&
			fileKeys.has(rendition.ingestKey)
		) {
			issues.push({
				code: "PLAN_STREAM_SOURCE_MISMATCH",
				level: "error",
				message: `rendition "${rendition.key}" (${rendition.codec}) must reference an ingest track, not a fileStream`,
				path: `renditions[${index}].ingestKey`,
			});
		}
		if (rendition.codec === "IMSC" || rendition.codec === "WEBVTT") {
			const file = plan.fileStreams.find((f) => f.key === rendition.ingestKey);
			if (
				file &&
				file.fileType !== (rendition.codec === "IMSC" ? "TTML" : "WEBVTT")
			)
				issues.push({
					code: "PLAN_STREAM_SOURCE_MISMATCH",
					level: "error",
					message: `${rendition.codec} requires a ${rendition.codec === "IMSC" ? "TTML" : "WEBVTT"} fileStream`,
					path: `renditions[${index}].ingestKey`,
				});
		}
		// A shared Dolby Vision input has one conversion format per encoding,
		// including when a rendition consumes it through trimming/concatenation.
		if (
			(rendition.codec === "H265" || rendition.codec === "AV1") &&
			rendition.dynamicRangeFormat !== undefined
		) {
			for (const key of inputStreamAncestry(plan, rendition.ingestKey) ?? []) {
				const source = dolbyByKey.get(key);
				if (
					source?.kind !== "VISION" ||
					source.encodingKey !== rendition.encodingKey
				)
					continue;
				const identity = JSON.stringify([rendition.encodingKey ?? null, key]);
				const previous = visionFormats.get(identity);
				if (previous && previous.format !== rendition.dynamicRangeFormat) {
					issues.push({
						code: "PLAN_DOLBY_VISION_FORMAT_CONFLICT",
						level: "error",
						message: `Renditions "${previous.renditionKey}" and "${rendition.key}" request different dynamic range formats (${previous.format}, ${rendition.dynamicRangeFormat}) from Dolby Vision input stream "${key}" in the same encoding. Use a separate encoding for each format.`,
						path: `renditions[${index}].dynamicRangeFormat`,
					});
				} else if (!previous) {
					visionFormats.set(identity, {
						format: rendition.dynamicRangeFormat,
						renditionKey: rendition.key,
					});
				}
			}
		}
		const dolbySource = dolbyByKey.get(rendition.ingestKey);
		if (dolbySource) {
			const ok =
				(dolbySource.kind === "ATMOS" && rendition.codec === "DOLBY_ATMOS") ||
				(dolbySource.kind === "VISION" &&
					(rendition.codec === "H265" ||
						rendition.codec === "H264" ||
						rendition.codec === "AV1"));
			if (!ok) {
				issues.push({
					code: "PLAN_STREAM_SOURCE_MISMATCH",
					level: "error",
					message: `rendition "${rendition.key}" (${rendition.codec}) cannot consume the ${dolbySource.kind} dolbyStream "${dolbySource.key}"`,
					path: `renditions[${index}].ingestKey`,
				});
			}
		}
		if (
			rendition.codec === "DOLBY_ATMOS" &&
			!dolbySource &&
			(ingestKeys.has(rendition.ingestKey) || fileKeys.has(rendition.ingestKey))
		) {
			issues.push({
				code: "PLAN_STREAM_SOURCE_MISMATCH",
				level: "error",
				message: `DOLBY_ATMOS rendition "${rendition.key}" must consume an ATMOS dolbyStream`,
				path: `renditions[${index}].ingestKey`,
			});
		}
		if (
			"dolbyVisionMetadata" in rendition &&
			rendition.dolbyVisionMetadata?.metadataStreamKey !== undefined
		) {
			const metaSource = dolbyByKey.get(
				rendition.dolbyVisionMetadata.metadataStreamKey,
			);
			if (metaSource?.kind !== "VISION_METADATA") {
				issues.push({
					code: "PLAN_UNRESOLVED_REF",
					level: "error",
					message: `rendition "${rendition.key}" dolbyVisionMetadata must reference a VISION_METADATA dolbyStream`,
					path: `renditions[${index}].dolbyVisionMetadata.metadataStreamKey`,
				});
			} else if (
				metaSource.encodingKey &&
				rendition.encodingKey &&
				metaSource.encodingKey !== rendition.encodingKey
			) {
				issues.push({
					code: "PLAN_ENCODING_SOURCE_MISMATCH",
					level: "error",
					message: `rendition "${rendition.key}" (encoding "${rendition.encodingKey}") attaches metadata sidecar "${metaSource.key}" owned by encoding "${metaSource.encodingKey}" — input streams are encoding-scoped`,
					path: `renditions[${index}].dolbyVisionMetadata.metadataStreamKey`,
				});
			}
		}
		// Partition locality: input streams are encoding-scoped API resources —
		// a rendition cannot consume a source created under another encoding.
		// Absent/unknown encodingKey in multi mode is already an error above,
		// so only firm key pairs are compared here.
		const localitySource =
			ingestByKey.get(rendition.ingestKey) ??
			fileByKey.get(rendition.ingestKey) ??
			dolbyByKey.get(rendition.ingestKey) ??
			allInputStreams.find((s) => s.key === rendition.ingestKey);
		if (
			localitySource?.encodingKey &&
			rendition.encodingKey &&
			localitySource.encodingKey !== rendition.encodingKey
		) {
			issues.push({
				code: "PLAN_ENCODING_SOURCE_MISMATCH",
				level: "error",
				message: `rendition "${rendition.key}" (encoding "${rendition.encodingKey}") consumes source "${localitySource.key}" owned by encoding "${localitySource.encodingKey}" — input streams are encoding-scoped`,
				path: `renditions[${index}].ingestKey`,
			});
		}
		const seenFilterKeys = new Set<string>();
		const seenPositions = new Set<number>();
		for (const [fIndex, attachment] of (rendition.filters ?? []).entries()) {
			if (!filterKeys.has(attachment.filterKey)) {
				issues.push({
					code: "PLAN_UNRESOLVED_REF",
					level: "error",
					message: `rendition "${rendition.key}" references unknown filter "${attachment.filterKey}"`,
					path: `renditions[${index}].filters[${fIndex}].filterKey`,
				});
			}
			const filter = plan.filters.find((f) => f.key === attachment.filterKey);
			if (
				filter &&
				(rendition.codec === "WEBVTT" ||
					rendition.codec === "IMSC" ||
					filterFamily(filter.kind) !==
						(AUDIO_CODECS.has(rendition.codec) ? "audio" : "video"))
			)
				issues.push({
					code: "PLAN_FILTER_MEDIA_TYPE",
					level: "error",
					message: `Filter "${filter.key}" is not compatible with ${rendition.codec}`,
					path: `renditions[${index}].filters[${fIndex}]`,
				});
			// Step ids are `filter:<rendition>:<filterKey>` — a repeated
			// attachment would collide; repeated positions are API-invalid.
			if (seenFilterKeys.has(attachment.filterKey)) {
				issues.push({
					code: "PLAN_DUPLICATE_FILTER_ATTACHMENT",
					level: "error",
					message: `rendition "${rendition.key}" attaches filter "${attachment.filterKey}" more than once`,
					path: `renditions[${index}].filters[${fIndex}].filterKey`,
				});
			}
			if (seenPositions.has(attachment.position)) {
				issues.push({
					code: "PLAN_DUPLICATE_FILTER_POSITION",
					level: "error",
					message: `rendition "${rendition.key}" uses filter position ${attachment.position} more than once`,
					path: `renditions[${index}].filters[${fIndex}].position`,
				});
			}
			seenFilterKeys.add(attachment.filterKey);
			seenPositions.add(attachment.position);
		}
	}

	// Same-time keyframes are redundant cue duplicates — warn, not error
	// (the API tolerates them; the plan author almost certainly erred).
	const seenKeyframeTimes = new Set<number>();
	for (const [index, keyframe] of plan.keyframes.entries()) {
		if (seenKeyframeTimes.has(keyframe.time)) {
			issues.push({
				code: "PLAN_DUPLICATE_KEYFRAME_TIME",
				level: "warning",
				message: `keyframe "${keyframe.key}" repeats cue time ${keyframe.time}s`,
				path: `keyframes[${index}].time`,
			});
		}
		seenKeyframeTimes.add(keyframe.time);
	}

	const muxedRenditions = new Set<string>();
	for (const [index, muxing] of plan.muxings.entries()) {
		// EVERY stream the container packages, not just the primary. The
		// unmuxed-rendition rail below reads `muxedRenditions`, and counting
		// only `streamKey` would report a muxed-in audio rendition as "never
		// packaged" — about a rendition that is packaged, inside the video
		// container the operator deliberately put it in.
		const containerKeys = muxingStreamKeys(muxing);
		for (const [at, streamKey] of containerKeys.entries()) {
			const path =
				at === 0
					? `muxings[${index}].streamKey`
					: `muxings[${index}].additionalStreamKeys[${at - 1}]`;
			if (!renditionKeys.has(streamKey)) {
				issues.push({
					code: "PLAN_UNRESOLVED_REF",
					level: "error",
					message: `muxing "${muxing.key}" references unknown rendition "${streamKey}"`,
					path,
				});
			}
			muxedRenditions.add(streamKey);
		}
		// A container listing the same rendition twice would send Bitmovin two
		// MuxingStream entries for one stream. Nothing downstream can tell that
		// apart from a genuine second track, so it is refused here.
		const duplicated = containerKeys.filter(
			(key, at) => containerKeys.indexOf(key) !== at,
		);
		if (duplicated.length > 0) {
			issues.push({
				code: "PLAN_MUXING_DUPLICATE_STREAM",
				level: "error",
				message: `muxing "${muxing.key}" packages rendition "${duplicated[0]}" more than once`,
				path: `muxings[${index}].additionalStreamKeys`,
			});
		}
		// One picture per container. Two video streams in one TS is legal
		// MPEG-TS and unplayable as an HLS variant — the player has no way to
		// choose, and the ladder rung it is supposed to BE becomes ambiguous.
		// Everything muxed alongside a picture has to be audio.
		const videoInContainer = containerKeys.filter((key) => {
			const packaged = renditionByKey.get(key);
			return (
				packaged !== undefined &&
				packaged.codec !== "WEBVTT" &&
				packaged.codec !== "IMSC" &&
				!AUDIO_CODECS.has(packaged.codec)
			);
		});
		// The picture is stream 0. Not a style rule — `streamKey` is what the
		// VMAF target resolver, the verification compiler and the detail view
		// all use to answer "which rendition is this container FOR", and each
		// of them would quietly miss a container whose video sat in the
		// additional list behind an audio primary. Cheaper to make the plan
		// hold the invariant than to teach four readers to look for it.
		if (
			videoInContainer.length === 1 &&
			videoInContainer[0] !== muxing.streamKey
		) {
			issues.push({
				code: "PLAN_MUXING_VIDEO_NOT_PRIMARY",
				level: "error",
				message: `muxing "${muxing.key}" muxes video rendition "${videoInContainer[0]}" behind a non-video primary — the video belongs in streamKey, with the audio in additionalStreamKeys`,
				path: `muxings[${index}].streamKey`,
			});
		}
		/**
		 * C2 (review) — A CONTAINER BELONGS TO ONE ENCODING.
		 *
		 * Bitmovin creates a muxing under a specific encoding, so every stream
		 * in it must live there too. Before multi-stream containers existed
		 * this was true by construction: one stream, its own encoding.
		 *
		 * The compiler emits a muxing on the LAST of its constituent
		 * renditions, and that loop is nested inside the per-encoding one — so
		 * a container whose primary is in encoding A and whose muxed-in track
		 * is in encoding B compiles with `encodingId` naming B while `streamId`
		 * still names A's stream. `refIdList` resolves both (the steps exist),
		 * so the malformed request reaches Bitmovin only AFTER both encodings
		 * are created and billed — exactly the mid-run class the emit-position
		 * fix was written to remove, on the axis it did not cover.
		 *
		 * Pointing the op at the primary's encoding instead is NOT the fix: the
		 * additional stream would still be foreign to it. The plan has to be
		 * refused. Precedent in this file: the encoding-scoped input-stream
		 * rail above.
		 */
		const containerEncodings = new Set(
			containerKeys.flatMap((key) => {
				const packaged = renditionByKey.get(key);
				return packaged === undefined ? [] : [packaged.encodingKey ?? ""];
			}),
		);
		if (containerEncodings.size > 1) {
			issues.push({
				code: "PLAN_MUXING_CROSS_ENCODING",
				level: "error",
				message: `muxing "${muxing.key}" packages renditions from more than one encoding (${[...containerEncodings].map((e) => (e === "" ? "(implicit)" : e)).join(", ")}) — a container belongs to exactly one`,
				path: `muxings[${index}].additionalStreamKeys`,
			});
		}
		/**
		 * I4 — a CONDITIONAL stream in a multiplexed container, where nothing
		 * says what happens when the condition fires.
		 *
		 * `Muxing.streamConditionsMode` (`DROP_MUXING` | `DROP_STREAM`) is
		 * documented as mattering only "for Muxings with more than one Stream"
		 * — so it becomes load-bearing precisely because of this feature, and
		 * this app exposes it nowhere. A conditional AAC muxed into a video TS
		 * therefore validates clean today while an UNMEASURED vendor default
		 * decides between "the audio track is dropped" and "the whole variant
		 * is dropped": between a silent rung and a missing one.
		 *
		 * A warning, not a block. The plan may well be exactly what the
		 * operator wants and the default may well be the one they expect —
		 * nobody here has measured it. What is not acceptable is accepting it
		 * SILENTLY, which is what review pointed at: the missing field can
		 * wait, the missing sentence cannot.
		 */
		const conditional = containerKeys.filter(
			(key) => renditionByKey.get(key)?.conditions !== undefined,
		);
		if (containerKeys.length > 1 && conditional.length > 0) {
			issues.push({
				code: "PLAN_MUXING_CONDITIONAL_STREAM",
				level: "warning",
				message: `muxing "${muxing.key}" multiplexes a CONDITIONAL rendition ("${conditional[0]}") — Bitmovin's streamConditionsMode decides whether a failed condition drops that stream or the whole container, this app does not set it, and the default is unmeasured (ledger #192 I4)`,
				path: `muxings[${index}].additionalStreamKeys`,
			});
		}
		if (videoInContainer.length > 1) {
			issues.push({
				code: "PLAN_MUXING_MULTIPLE_VIDEO",
				level: "error",
				message: `muxing "${muxing.key}" packages ${videoInContainer.length} video renditions (${videoInContainer.join(", ")}) — a container carries at most one picture, with audio muxed alongside it`,
				path: `muxings[${index}].additionalStreamKeys`,
			});
		}
		/**
		 * ONE ADDRESSABLE AUDIO TRACK PER CONTAINER .
		 *
		 * MPEG-TS happily carries several audio PIDs, and a `.mp4` several
		 * audio tracks — the container is not the constraint. The MANIFEST is:
		 * an HLS variant references a MUXING, and there is no syntax for
		 * choosing between the tracks inside it. A second track is encoded,
		 * stored and delivered, and no player can ever reach it. The
		 * `MULTIPLE_VIDEO` rail above says the same thing about pictures; this
		 * is its missing twin, flagged in review as a suggestion and shipped
		 * without it until the owner hit it in the wizard.
		 *
		 * TS is an ERROR: every TS delivery this app builds is HLS, so the
		 * second track is unreachable by construction. MP4 is a WARNING: a
		 * progressive file legitimately carries several tracks and a player
		 * opening the FILE can pick between them — it is only the manifest
		 * families we generate (byte-range HLS, Smooth, DASH on-demand) that
		 * cannot address it, so the plan may be exactly what was meant.
		 */
		const audioInContainer = containerKeys.filter((key) => {
			const packaged = renditionByKey.get(key);
			return packaged !== undefined && AUDIO_CODECS.has(packaged.codec);
		});
		if (audioInContainer.length > 1) {
			issues.push({
				code: "PLAN_MUXING_MULTIPLE_AUDIO",
				level: muxing.kind === "TS" ? "error" : "warning",
				message: `muxing "${muxing.key}" (${muxing.kind}) packages ${audioInContainer.length} audio renditions (${audioInContainer.join(", ")}) — a manifest references the CONTAINER, so only the first is reachable and the rest are encoded and delivered to nobody`,
				path: `muxings[${index}].additionalStreamKeys`,
			});
		}
		if (muxing.destination && !outputKeys.has(muxing.destination.outputKey)) {
			issues.push({
				code: "PLAN_UNRESOLVED_REF",
				level: "error",
				message: `muxing "${muxing.key}" references unknown output "${muxing.destination.outputKey}"`,
				path: `muxings[${index}].destination.outputKey`,
			});
		}
		// A muxing without a destination writes nowhere unless a DRM
		// resource carries the (encrypted) output for it.
		if (
			!muxing.destination &&
			!plan.drm.some((d) => d.muxingKey === muxing.key)
		) {
			issues.push({
				code: "PLAN_MUXING_NO_OUTPUT",
				level: "error",
				message: `muxing "${muxing.key}" has no destination and no DRM resource carrying one — its output would be discarded`,
				path: `muxings[${index}]`,
			});
		}
		// Container/codec matrix (sample-derived): each muxing kind has a
		// closed set of codecs it can package.
		const target = renditionByKey.get(muxing.streamKey);
		if (target) {
			const allowed: Record<string, string[]> = {
				// AV1 packages into fMP4 and WebM; dedicated CMAF is H264/AAC only.
				FMP4: [
					"H264",
					"H265",
					"AV1",
					"AAC",
					"DOLBY_ATMOS",
					"DDPLUS",
					"DD",
					"AC3",
					"EAC3",
				],
				CMAF: ["H264", "AAC"],
				MP4: ["H264", "H265", "AAC", "DOLBY_ATMOS", "AC3", "EAC3"],
				TS: ["H264", "AAC", "AC3"],
				WEBM: ["VP9", "AV1", "OPUS"],
				TEXT: ["IMSC"],
				CHUNKED_TEXT: ["WEBVTT"],
			};
			// The matrix judges EVERY stream in the container. It used to see
			// only the primary, which was complete while a container held one
			// stream and silently stopped being complete when it could hold
			// two: a WEBVTT or DDPLUS rendition muxed into a TS would have
			// reached the encoder unchecked, because the H264 primary passed.
			for (const [at, streamKey] of containerKeys.entries()) {
				const packaged = renditionByKey.get(streamKey);
				if (!packaged) {
					continue; // already reported as an unresolved ref above
				}
				// The AV1 Dolby Vision path exposed here is fMP4 only.
				const av1DolbyVision =
					packaged.codec === "AV1" &&
					packaged.dynamicRangeFormat?.startsWith("DOLBY_VISION_PROFILE_10_");
				if (av1DolbyVision && muxing.kind !== "FMP4") {
					issues.push({
						code: "PLAN_MUXING_CODEC_MISMATCH",
						level: "error",
						message: `muxing "${muxing.key}" (${muxing.kind}) cannot package AV1 Dolby Vision rendition "${packaged.key}" — this path supports fMP4 only`,
						path:
							at === 0
								? `muxings[${index}].streamKey`
								: `muxings[${index}].additionalStreamKeys[${at - 1}]`,
					});
					continue;
				}
				if (!(allowed[muxing.kind] ?? []).includes(packaged.codec)) {
					issues.push({
						code: "PLAN_MUXING_CODEC_MISMATCH",
						level: "error",
						message: `muxing "${muxing.key}" (${muxing.kind}) cannot package the ${packaged.codec} rendition "${packaged.key}" — allowed: ${(allowed[muxing.kind] ?? []).join("/")}`,
						path:
							at === 0
								? `muxings[${index}].streamKey`
								: `muxings[${index}].additionalStreamKeys[${at - 1}]`,
					});
				}
			}
			// DolbyVision MP4 track signaling only makes sense on a DV H265
			// muxing (the OnDemand sample sets DVH1 on the DV ladder only).
			if (
				muxing.kind === "MP4" &&
				muxing.dolbyVisionConfiguration &&
				!(
					target.codec === "H265" &&
					target.dynamicRangeFormat?.startsWith("DOLBY_VISION")
				)
			) {
				issues.push({
					code: "PLAN_MUXING_DV_CONFIG_MISMATCH",
					level: "error",
					message: `muxing "${muxing.key}" sets dolbyVisionConfiguration but its rendition "${target.key}" is not a DolbyVision H265 stream`,
					path: `muxings[${index}].dolbyVisionConfiguration`,
				});
			}
			// SegmentBase playback needs the sidx index — the sample marks
			// fragment_duration as mandatory for DASH_ON_DEMAND.
			if (
				muxing.kind === "MP4" &&
				muxing.manifestType === "DASH_ON_DEMAND" &&
				muxing.fragmentDuration === undefined
			) {
				issues.push({
					code: "PLAN_MP4_FRAGMENT_DURATION_MISSING",
					level: "error",
					message: `muxing "${muxing.key}" sets manifestType DASH_ON_DEMAND without fragmentDuration — sidx fragmentation requires it`,
					path: `muxings[${index}].fragmentDuration`,
				});
			}
		}
	}

	// AISA asset-description output is a destination like any other.
	if (
		plan.aiSceneAnalysis &&
		!outputKeys.has(plan.aiSceneAnalysis.assetDescription.destination.outputKey)
	) {
		issues.push({
			code: "PLAN_UNRESOLVED_REF",
			level: "error",
			message: `aiSceneAnalysis references unknown output "${plan.aiSceneAnalysis.assetDescription.destination.outputKey}"`,
			path: "aiSceneAnalysis.assetDescription.destination.outputKey",
		});
	}

	// DRM: resolve refs, enforce the drm-kind × container matrix and C9
	// (CENC ivSize: CTR→8 bytes, CBC→16 bytes).
	const muxingByKey = new Map(plan.muxings.map((m) => [m.key, m]));
	const DRM_ALLOWED: Record<string, string[]> = {
		SPEKE: ["FMP4"],
		CENC: ["FMP4", "MP4", "WEBM"],
		FAIRPLAY: ["FMP4", "TS"],
	};
	for (const [index, drm] of plan.drm.entries()) {
		const muxing = muxingByKey.get(drm.muxingKey);
		if (
			muxing?.kind === "TS" &&
			muxingStreamKeys(muxing).some((key) => {
				const codec = renditionByKey.get(key)?.codec;
				return codec === "AC3" || codec === "EAC3";
			})
		) {
			issues.push({
				code: "PLAN_DRM_AUDIO_TS_UNSUPPORTED",
				level: "error",
				path: `drm[${index}].muxingKey`,
				message:
					"AC3/EAC3 audio cannot be encrypted in TS containers; choose fMP4 encryption or an unencrypted supported container",
			});
		}
		if (!muxing) {
			issues.push({
				code: "PLAN_UNRESOLVED_REF",
				level: "error",
				message: `drm "${drm.key}" references unknown muxing "${drm.muxingKey}"`,
				path: `drm[${index}].muxingKey`,
			});
		} else if (!(DRM_ALLOWED[drm.kind] ?? []).includes(muxing.kind)) {
			issues.push({
				code: "PLAN_DRM_MUXING_MISMATCH",
				level: "error",
				message: `drm "${drm.key}" (${drm.kind}) cannot encrypt the ${muxing.kind} muxing "${muxing.key}" — allowed: ${(DRM_ALLOWED[drm.kind] ?? []).join("/")}`,
				path: `drm[${index}].muxingKey`,
			});
		}
		if (!outputKeys.has(drm.destination.outputKey)) {
			issues.push({
				code: "PLAN_UNRESOLVED_REF",
				level: "error",
				message: `drm "${drm.key}" references unknown output "${drm.destination.outputKey}"`,
				path: `drm[${index}].destination.outputKey`,
			});
		}
		if (drm.kind === "SPEKE") {
			const provider = options.credentialProviders?.get(drm.credentialId);
			if (provider && provider !== "DRM_SPEKE")
				issues.push({
					code: "DRM_CREDENTIAL",
					level: "error",
					message: `drm "${drm.key}" needs a SPEKE key provider credential`,
					path: `drm[${index}].credentialId`,
				});
			if (
				drm.systemIds.some((id) =>
					[
						"94ce86fb-07ff-4f43-adb8-93d2fa968ca2",
						"3ea8778f-7742-4bf9-b18b-e834b2acbd47",
					].includes(id.toLowerCase()),
				) &&
				!drm.iv
			)
				issues.push({
					code: "DRM_IV",
					level: "error",
					message: `drm "${drm.key}": FairPlay/AES-128 requires a 16-byte IV`,
					path: `drm[${index}].iv`,
				});
		}
		if (drm.kind === "CENC") {
			const mode = drm.encryptionMode ?? "CTR";
			const expected = mode === "CBC" ? "IV_16_BYTES" : "IV_8_BYTES";
			if (drm.ivSize && drm.ivSize !== expected) {
				issues.push({
					code: "C9",
					level: "error",
					message: `drm "${drm.key}": CENC ${mode} requires ivSize ${expected} (got ${drm.ivSize})`,
					path: `drm[${index}].ivSize`,
				});
			}
		}
	}

	// hlsMedia is audio-group placement — on a video rendition it would leak
	// a phantom groupId into the variant-multiplication group set.
	for (const [index, rendition] of plan.renditions.entries()) {
		if (rendition.hlsMedia && !AUDIO_CODECS.has(rendition.codec)) {
			issues.push({
				code: "PLAN_HLS_MEDIA_ON_NON_AUDIO",
				level: "error",
				message: `rendition "${rendition.key}" (${rendition.codec}) sets hlsMedia — audio-group placement is audio-only`,
				path: `renditions[${index}].hlsMedia`,
			});
		}
	}

	/*
	 * HLS audio media NAME / URI uniqueness within a group —
	 * HIGH-8. RFC 8216 §4.3.4.1.1: NAME is unique per GROUP-ID.
	 * Two media entries on one URI is worse than a spec violation: the encoder
	 * writes one playlist twice and the player gets whichever won.
	 *
	 * Checked against the SAME derivation the compiler emits from, so a plan
	 * that validates clean is a plan whose manifest will be clean. Defaults are
	 * unique by construction now; this guards what an AUTHOR spelled — two
	 * `hlsMedia` blocks that collide — and the `audioMediaUri` literal, which
	 * can only ever name one playlist.
	 */
	for (const [index, manifest] of plan.manifests.entries()) {
		if (manifest.kind !== "HLS" || manifest.generationMode === "DEFAULT") {
			continue;
		}
		const derived = hlsAudioMediaDefaults(plan, manifest);
		// THIS manifest's defaulted entries (review-323 I1) — the plan-wide
		// count flagged a shared URI against renditions the manifest never lists.
		const defaultedCount = [...derived.values()].filter(
			(d) => !d.explicit,
		).length;
		if (manifest.audioMediaUri !== undefined && defaultedCount > 1) {
			issues.push({
				code: "PLAN_HLS_AUDIO_MEDIA_URI_SHARED",
				level: "error",
				message: `HLS manifest "${manifest.key}" sets audioMediaUri "${manifest.audioMediaUri}" but ${defaultedCount} audio renditions would share it — one playlist cannot carry two renditions; give each rendition its own hlsMedia.uri or drop the override`,
				path: `manifests[${index}].audioMediaUri`,
			});
		}
		const seenName = new Map<string, string>();
		const seenUri = new Map<string, string>();
		for (const rendition of plan.renditions) {
			if (!isHlsAudioRendition(rendition)) {
				continue;
			}
			const d = derived.get(rendition.key);
			if (!d) {
				continue;
			}
			const group = rendition.hlsMedia?.groupId ?? manifest.audioGroupId;
			const nameKey = `${group}\u0000${d.name}`;
			const uriKey = `${group}\u0000${d.uri}`;
			const nameClash = seenName.get(nameKey);
			if (nameClash !== undefined) {
				issues.push({
					code: "PLAN_HLS_MEDIA_NAME_COLLISION",
					level: "error",
					message: `HLS manifest "${manifest.key}": audio renditions "${nameClash}" and "${rendition.key}" both use NAME "${d.name}" in group "${group}" — RFC 8216 requires NAME to be unique within a group`,
					path: `manifests[${index}]`,
				});
			} else {
				seenName.set(nameKey, rendition.key);
			}
			const uriClash = seenUri.get(uriKey);
			if (uriClash !== undefined) {
				issues.push({
					code: "PLAN_HLS_MEDIA_URI_COLLISION",
					level: "error",
					message: `HLS manifest "${manifest.key}": audio renditions "${uriClash}" and "${rendition.key}" both write media playlist "${d.uri}" in group "${group}" — two renditions on one playlist means the encoder writes it twice`,
					path: `manifests[${index}]`,
				});
			} else {
				seenUri.set(uriKey, rendition.key);
			}
		}
	}

	/*
	 * ONE muxing leg per rendition per manifest — 2026-08-29 paid re-audit
	 * HIGH-5, the other axis of .
	 *
	 * #201 made the derived NAME and URI unique ACROSS renditions. Both are
	 * keyed BY rendition, so two legs of ONE rendition necessarily produce two
	 * identical entries: the same NAME in the group (RFC 8216 §4.3.4.1.1) and,
	 * worse, the same playlist written twice by two different segment sets.
	 * The trigger is ordinary — an fMP4 leg for DASH beside a TS leg for HLS —
	 * and it is only the MISSING PIN that makes it a defect: an unpinned HLS
	 * manifest lists every leg of the family. The live compiler has refused
	 * exactly this since #201 (`LIVE_HLS_URI_COLLISION`, naming this trigger in
	 * its own comment); VOD had no rail, and the compiler dutifully emitted the
	 * duplicate.
	 *
	 * Error, not warning: there is no author intent this shape expresses. Which
	 * leg the manifest should list is a real choice, and `videoMuxingKind` /
	 * `audioMuxingKind` are where it is spelled — the compiler takes the first
	 * selected leg rather than guessing, and this says so out loud instead of
	 * letting the guess ship. Read off `hlsChildEntries`, the enumeration the
	 * verifier already trusts, so audio media, video variants and subtitle
	 * playlists are all covered by the rule rather than by three copies of it.
	 */
	// Different masters still write children into the same output directory.
	// Keep this map plan-wide (#233), not scoped to a master or audio group.
	// Even the same leg can have different manifest settings: do not infer
	// byte-identical output or safe concurrent writers from its muxing key.
	const hlsChildrenByDestination = new Map<string, string>();
	for (const [index, manifest] of plan.manifests.entries()) {
		if (manifest.kind !== "HLS") {
			continue;
		}
		if (
			manifest.generationMode !== "DEFAULT" &&
			hlsSubtitleGroups(plan).length > 1
		) {
			issues.push({
				code: "PLAN_HLS_SUBTITLE_GROUP_AMBIGUOUS",
				level: "error",
				path: `manifests[${index}]`,
				message:
					"HLS variants support one subtitle group; use the same groupId for all subtitle languages.",
			});
		}
		for (const uri of hlsStaticChildUris(plan, manifest)) {
			const destinationKey = JSON.stringify([
				manifest.destination.outputKey,
				manifest.destination.path,
				uri,
			]);
			const previousManifest = hlsChildrenByDestination.get(destinationKey);
			if (previousManifest !== undefined && previousManifest !== manifest.key) {
				issues.push({
					code: "PLAN_HLS_MEDIA_URI_COLLISION",
					level: "error",
					message: `HLS manifests "${previousManifest}" and "${manifest.key}" both write child playlist "${uri}" to output "${manifest.destination.outputKey}" at path "${manifest.destination.path}" — use distinct child URIs or manifest destinations; distinct master names do not prevent child overwrites`,
					path: `manifests[${index}]`,
				});
			} else {
				hlsChildrenByDestination.set(destinationKey, manifest.key);
			}
		}
		const legsByRendition = new Map<string, string[]>();
		for (const entry of hlsChildEntries(plan, manifest)) {
			const legs = legsByRendition.get(entry.renditionKey) ?? [];
			// One muxing may write several children (the Dolby per-group
			// fan-out is one muxing × N audio groups) — count LEGS, not URIs.
			if (!legs.includes(entry.muxingKey)) {
				legs.push(entry.muxingKey);
			}
			legsByRendition.set(entry.renditionKey, legs);
		}
		for (const [renditionKey, muxingKeys] of legsByRendition) {
			if (muxingKeys.length < 2) {
				continue;
			}
			issues.push({
				code: "PLAN_HLS_RENDITION_MULTI_LEG",
				level: "error",
				message: `HLS manifest "${manifest.key}" lists ${muxingKeys.length} muxing legs (${muxingKeys.join(", ")}) for rendition "${renditionKey}" — they derive ONE playlist uri, so the master would carry two entries naming a playlist the encoder writes twice; pin videoMuxingKind/audioMuxingKind to the leg this manifest should list`,
				path: `manifests[${index}]`,
			});
		}
	}

	// H264/H265 presets populate encodingMode (provider preset tests).
	// VP9 quality presets are handled by the same explicit-mode conflict rule.
	// AV1 has a separate preset family; do not infer its mode from this evidence.
	// Even the same value cannot also be sent at START (R43 / provider 2025).
	// Do not silently drop either setting: that changes the author's quality intent.
	if (plan.generation.encodingMode !== undefined) {
		const presetRenditions = plan.renditions.filter(
			(r) =>
				("encodingMode" in r && Boolean(r.encodingMode)) ||
				("presetConfiguration" in r && Boolean(r.presetConfiguration)) ||
				(Boolean(plan.internal?.hevcV2) && r.codec === "H265"),
		);
		if (presetRenditions.length > 0) {
			issues.push({
				code: "PLAN_ENCODING_MODE_PRESET_CONFLICT",
				level: "error",
				message: `Codec modes or quality presets on ${presetRenditions.map((r) => r.key).join(", ")} set the codec encoding mode. Set Encoding start options > Encoding mode to (default), or explicitly configure codecs without presets; do not set both.`,
				path: "generation.encodingMode",
			});
		}
	}

	/*
	 * Mixed video codecs in ONE encoding need a compatible mode.
	 * The start request's
	 * `encodingMode` is one value for the whole encoding; when it is absent,
	 * each codec config's preset implies its own, and the provider refuses the
	 * START with "All encodingModes … must be the same" — after every resource
	 * was created. Historical case 15's START pin alone is not a safe general
	 * remedy: presets plus a START mode conflict (R43). Keep the missing-mode
	 * rail conservative; advanced users must use no presets with an explicit
	 * common mode, or separate jobs. Never remove presets automatically.
	 * Scoped per ENCODING: the Dolby ladders put each codec in its own
	 * encoding and are not mixed in this sense.
	 */
	if (plan.generation.encodingMode === undefined) {
		const codecsByEncoding = new Map<string, Set<string>>();
		for (const r of plan.renditions) {
			if (!VIDEO_CODECS_FOR_MODE.has(r.codec)) {
				continue;
			}
			const enc = r.encodingKey ?? "";
			const set = codecsByEncoding.get(enc) ?? new Set<string>();
			set.add(r.codec);
			codecsByEncoding.set(enc, set);
		}
		for (const [enc, codecs] of codecsByEncoding) {
			const videos = plan.renditions.filter(
				(r) =>
					VIDEO_CODECS_FOR_MODE.has(r.codec) && (r.encodingKey ?? "") === enc,
			);
			const explicitModes = videos.map((r) =>
				"encodingMode" in r ? r.encodingMode : undefined,
			);
			const commonCodecMode =
				explicitModes.every((mode) => mode !== undefined) &&
				new Set(explicitModes).size === 1;
			if (codecs.size > 1 && !commonCodecMode) {
				issues.push({
					code: "PLAN_ENCODING_MODE_UNPINNED_FOR_MIXED_CODECS",
					level: "error",
					message: `encoding ${enc ? `"${enc}"` : "(default)"} mixes ${[...codecs].sort().join(" + ")} with no common mode. Prefer one video codec per job; advanced mixed-codec plans require a common explicit mode on every video codec, or no presets and one common generation.encodingMode. Do not add a START mode alongside quality presets.`,
					path: "generation.encodingMode",
				});
			}
		}
	}

	/*
	 * fMP4 media playlists carry EXT-X-MAP, which RFC 8216 §7 places at
	 * protocol version 6. A WARNING, not an error: the vendor's own fixed-bitrate
	 * samples do exactly this and players tolerate it, so 17 transcribed
	 * goldens carry it deliberately. The wizard's DEFAULT is V6 for fMP4;
	 * an explicit lower version is the author's call, and this
	 * is where they are told what it costs.
	 */
	for (const [index, manifest] of plan.manifests.entries()) {
		if (manifest.kind !== "HLS" || manifest.mediaVersion === undefined) {
			continue;
		}
		const versionNumber = Number(manifest.mediaVersion.replace(/^HLS_V/, ""));
		if (versionNumber >= 6) {
			continue;
		}
		// The legs this manifest LISTS, both families. Scanning video only —
		// which this rule and the wizard default both did — is silent for an
		// audio-only plan whose audio muxing is fMP4, and its media playlists
		// carry EXT-X-MAP just the same (2026-08-29 paid re-audit HIGH-4).
		// `mediaVersion` is one value over every child playlist, so the
		// question is per-LEG, not per-family; `hlsVersionForLegs` is the same
		// rule the wizard's `hlsDefaultVersion` emits from.
		const listedLegKinds = plan.muxings.flatMap((m) => {
			const r = plan.renditions.find((x) => x.key === m.streamKey);
			if (r === undefined) {
				return [];
			}
			if (AUDIO_CODECS.has(r.codec)) {
				return hlsLegSelected(m.kind, manifest.audioMuxingKind) ? [m.kind] : [];
			}
			if (!VIDEO_CODECS_FOR_MODE.has(r.codec)) {
				return [];
			}
			return hlsLegSelected(m.kind, manifest.videoMuxingKind) ? [m.kind] : [];
		});
		if (hlsVersionForLegs(listedLegKinds) === "HLS_V6") {
			issues.push({
				code: "PLAN_HLS_FMP4_MEDIA_VERSION_BELOW_6",
				level: "warning",
				message: `HLS manifest "${manifest.key}" writes fMP4 media playlists (EXT-X-MAP) at ${manifest.mediaVersion} — RFC 8216 §7 places EXT-X-MAP at version 6; players tolerate it, strict validators do not`,
				path: `manifests[${index}].mediaVersion`,
			});
		}
	}

	// Dolby ladder HLS/DASH surfaces.
	const hlsMediaGroupCount = plan.renditions.filter(
		(r) => AUDIO_CODECS.has(r.codec) && r.hlsMedia,
	).length;
	for (const [mIndex, manifest] of plan.manifests.entries()) {
		if (manifest.kind === "HLS") {
			const hlsRenditions =
				manifest.generationMode === "DEFAULT"
					? defaultManifestSelection(plan).renditions
					: plan.renditions;
			const hlsKeys = new Set(hlsRenditions.map((row) => row.key));
			const hlsMuxings =
				manifest.generationMode === "DEFAULT"
					? plan.muxings.filter((row) => hlsKeys.has(row.streamKey))
					: plan.muxings;
			const hasVideo = hlsRenditions.some((r) =>
				VIDEO_CODECS_FOR_MODE.has(r.codec),
			);
			const hasSelectedVideo = hlsMuxings.some((muxing) => {
				const rendition = renditionByKey.get(muxing.streamKey);
				return (
					rendition !== undefined &&
					VIDEO_CODECS_FOR_MODE.has(rendition.codec) &&
					["FMP4", "MP4", "TS"].includes(muxing.kind) &&
					hlsLegSelected(muxing.kind, manifest.videoMuxingKind)
				);
			});
			if (hasVideo && !hasSelectedVideo)
				issues.push({
					code: "PLAN_HLS_VIDEO_UNSELECTED",
					level: "error",
					message: `HLS manifest "${manifest.key}" selects no supported video muxing despite video renditions — add an fMP4, TS or MP4 video leg matching videoMuxingKind`,
					path: `manifests[${mIndex}].videoMuxingKind`,
				});
			const unsupportedCmaf = hlsMuxings.some((muxing) => {
				if (muxing.kind !== "CMAF") return false;
				const rendition = renditionByKey.get(muxing.streamKey);
				if (!rendition) return false;
				const pin = AUDIO_CODECS.has(rendition.codec)
					? manifest.audioMuxingKind
					: manifest.videoMuxingKind;
				// An explicit compatible pin excludes CMAF; an unpinned rung needs its own HLS leg.
				return (
					pin === undefined &&
					!hlsMuxings.some(
						(leg) =>
							leg.streamKey === muxing.streamKey &&
							["FMP4", "MP4", "TS"].includes(leg.kind),
					)
				);
			});
			if (unsupportedCmaf)
				issues.push({
					code: "PLAN_HLS_CMAF_UNSUPPORTED",
					level: "error",
					message:
						"CMAF muxings support DASH Template or Timeline; use fMP4 for HLS",
					path: `manifests[${mIndex}]`,
				});
			if (manifest.iframePlaylists && !manifest.variantsPerAudioGroup) {
				issues.push({
					code: "PLAN_HLS_IFRAME_WITHOUT_GROUPS",
					level: "error",
					message: `manifest "${manifest.key}" sets iframePlaylists without variantsPerAudioGroup`,
					path: `manifests[${mIndex}].iframePlaylists`,
				});
			}
			// variantsPerAudioGroup fans ONE video muxing out into one variant
			// per audio group — a Dolby ladder shape that only means anything
			// when the audio lives outside the video container. A variant that
			// already carries its audio cannot be offered "with the other audio
			// group"; the fan-out would emit N identical variants differing
			// only by an audio attribute this compiler deliberately omits.
			if (manifest.variantsPerAudioGroup) {
				// SCOPED to the muxings this manifest actually selects. Plan-wide
				// was wrong (review I3): a manifest pinned to fMP4 was refused
				// because of an unrelated TS leg it never uses — and multi-leg
				// is a DESIGNED shape, which is what `videoMuxingKind` is for.
				// An error-level rail refusing a legal plan is worse than the
				// hole it closes.
				const muxedVariant = hlsMuxings.find(
					(m) =>
						(manifest.videoMuxingKind === undefined ||
							m.kind === manifest.videoMuxingKind) &&
						hasMuxedInAudio(m, renditionByKey),
				);
				if (muxedVariant) {
					issues.push({
						code: "PLAN_HLS_MUXED_VARIANT_GROUPS",
						level: "error",
						message: `manifest "${manifest.key}" sets variantsPerAudioGroup, but muxing "${muxedVariant.key}" already carries its audio — a self-contained variant belongs to no audio group`,
						path: `manifests[${mIndex}].variantsPerAudioGroup`,
					});
				}
			}
			/**
			 * C33's OTHER half — the one the builder cannot reach .
			 *
			 * Within ONE manifest, every video variant must either carry its own
			 * audio or have a group to point at. A PARTLY muxed ladder satisfies
			 * neither: the muxed variants correctly omit `audio` while the rest
			 * name a GROUP-ID that no `CREATE_HLS_AUDIO_MEDIA` op creates, so
			 * those rungs play silent — and nothing else sees it, because the
			 * audio IS packaged and `PLAN_UNMUXED_RENDITION` is looking for a
			 * rendition nothing packages.
			 *
			 * The builder now produces the correct shape (the audio keeps its
			 * own container unless every variant carries it), but a plan can
			 * arrive from an import, an API token or by hand. This is the rule
			 * itself rather than an approximation of it, which is why it is
			 * expressed per MANIFEST over the muxings that manifest selects —
			 * the population that decides the outcome. Scoping a predicate
			 * narrower than that produced this defect, I3 and the per-title one:
			 * three sites, one mistake.
			 */
			// Does THIS manifest emit any EXT-X-MEDIA audio entry? Mirrors the
			// compiler's own selection: an audio rendition's muxing, filtered by
			// `audioMuxingKind` when the manifest pins one.
			for (const [mxIndex, muxing] of hlsMuxings.entries()) {
				const r = renditionByKey.get(muxing.streamKey);
				if (
					r?.codec === "OPUS" &&
					hlsLegSelected(muxing.kind, manifest.audioMuxingKind)
				)
					issues.push({
						code: "PLAN_HLS_OPUS_WEBM_UNSUPPORTED",
						level: "error",
						message:
							"Opus/WebM is available through DASH; exclude its audio leg from HLS and provide a supported HLS audio track",
						path: `muxings[${mxIndex}]`,
					});
			}
			const hlsAudioMediaCount = hlsMuxings.filter((m) => {
				if (
					manifest.audioMuxingKind !== undefined &&
					m.kind !== manifest.audioMuxingKind
				) {
					return false;
				}
				const primary = renditionByKey.get(m.streamKey);
				return primary !== undefined && AUDIO_CODECS.has(primary.codec);
			}).length;
			const selectedVideo = hlsMuxings.filter((m) => {
				if (
					manifest.videoMuxingKind !== undefined &&
					m.kind !== manifest.videoMuxingKind
				) {
					return false;
				}
				const primary = renditionByKey.get(m.streamKey);
				return (
					primary !== undefined &&
					primary.codec !== "WEBVTT" &&
					primary.codec !== "IMSC" &&
					!AUDIO_CODECS.has(primary.codec)
				);
			});
			const carrying = selectedVideo.filter((m) =>
				hasMuxedInAudio(m, renditionByKey),
			);
			if (
				carrying.length > 0 &&
				carrying.length < selectedVideo.length &&
				hlsAudioMediaCount === 0
			) {
				const stranded = selectedVideo.find(
					(m) => !hasMuxedInAudio(m, renditionByKey),
				);
				issues.push({
					code: "PLAN_HLS_PARTIAL_MUXED_LADDER",
					level: "error",
					message: `manifest "${manifest.key}" mixes variants that carry their own audio with ones that do not (e.g. "${stranded?.key}"), and no audio media entry exists for the latter to reference — those renditions would play silent`,
					path: `manifests[${mIndex}]`,
				});
			}
			if (manifest.variantsPerAudioGroup && hlsMediaGroupCount === 0) {
				issues.push({
					code: "PLAN_HLS_VARIANT_GROUP_INCOMPLETE",
					level: "error",
					message: `manifest "${manifest.key}" sets variantsPerAudioGroup but no audio rendition declares hlsMedia — the master playlist would have zero variants`,
					path: `manifests[${mIndex}].variantsPerAudioGroup`,
				});
			}
			if (manifest.variantsPerAudioGroup) {
				for (const [rIndex, r] of hlsRenditions.entries()) {
					const videoCodec =
						r.codec === "H264" ||
						r.codec === "H265" ||
						r.codec === "VP9" ||
						r.codec === "AV1";
					if (videoCodec) {
						if (
							(!r.hlsVariantLabel && !r.hlsVariantUri) ||
							r.height === null ||
							r.bitrate === null
						) {
							issues.push({
								code: "PLAN_HLS_VARIANT_GROUP_INCOMPLETE",
								level: "error",
								message: `rendition "${r.key}" needs hlsVariantLabel or hlsVariantUri, plus fixed height/bitrate for variantsPerAudioGroup uris`,
								path: `renditions[${rIndex}]`,
							});
						}
					} else if (
						r.codec !== "WEBVTT" &&
						r.codec !== "IMSC" &&
						!r.hlsMedia
					) {
						issues.push({
							code: "PLAN_HLS_VARIANT_GROUP_INCOMPLETE",
							level: "error",
							message: `audio rendition "${r.key}" needs hlsMedia (group placement) for variantsPerAudioGroup`,
							path: `renditions[${rIndex}]`,
						});
					}
				}
			}
		}
		if (manifest.kind === "DASH") {
			for (const muxing of plan.muxings)
				if (
					muxing.kind === "TEXT" &&
					renditionByKey.get(muxing.streamKey)?.codec === "IMSC" &&
					muxing.destination.outputKey !== manifest.destination.outputKey
				)
					issues.push({
						code: "PLAN_IMSC_OUTPUT_MISMATCH",
						level: "error",
						message:
							"IMSC Text output and DASH manifest must use the same output storage for a relative subtitle URL",
						path: `manifests[${mIndex}]`,
					});
		}
		if (manifest.kind === "DASH" && manifest.adaptationSets?.length) {
			const setByKey = new Map(manifest.adaptationSets.map((s) => [s.key, s]));
			checkUniqueKeys(manifest.adaptationSets, "adaptationSets", issues);
			// ON_DEMAND manifests select DASH_ON_DEMAND-typed MP4 muxings,
			// segmented ones fMP4 — mirror the compiler exactly.
			const setOnDemand = manifest.profile === "ON_DEMAND";
			for (const [rIndex, r] of plan.renditions.entries()) {
				if (r.codec === "WEBVTT" || r.codec === "IMSC") {
					continue;
				}
				const hasSelectedMuxing = plan.muxings.some(
					(m) =>
						m.streamKey === r.key &&
						(AUDIO_CODECS.has(r.codec)
							? dashAudioLegSelected(m, manifest, setOnDemand)
							: dashVideoLegSelected(m, manifest, setOnDemand)),
				);
				if (!hasSelectedMuxing) {
					continue;
				}
				const set = r.dashSetKey ? setByKey.get(r.dashSetKey) : undefined;
				if (!set) {
					issues.push({
						code: "PLAN_DASH_SET_UNRESOLVED",
						level: "error",
						message: `rendition "${r.key}" needs a dashSetKey resolving to manifest "${manifest.key}" adaptationSets`,
						path: `renditions[${rIndex}].dashSetKey`,
					});
				} else {
					const videoCodec =
						r.codec === "H264" ||
						r.codec === "H265" ||
						r.codec === "VP9" ||
						r.codec === "AV1";
					if ((set.type === "VIDEO") !== videoCodec) {
						issues.push({
							code: "PLAN_DASH_SET_TYPE_MISMATCH",
							level: "error",
							message: `rendition "${r.key}" (${r.codec}) cannot join ${set.type} adaptation set "${set.key}"`,
							path: `renditions[${rIndex}].dashSetKey`,
						});
					}
				}
			}
		}
	}

	// A manifest that pins a drmKind must find that DRM on EVERY muxing its
	// static entries select — otherwise the compiler would silently emit an
	// entry without drmId pointing at an empty path.
	const videoCodecsForDrm = new Set(["H264", "H265", "VP9", "AV1"]);
	for (const [mIndex, manifest] of plan.manifests.entries()) {
		if (
			manifest.kind === "DASH" &&
			manifest.profile === "ON_DEMAND" &&
			!manifest.drmKind
		) {
			for (const muxing of plan.muxings) {
				const target = renditionByKey.get(muxing.streamKey);
				if (
					muxing.kind !== "MP4" ||
					muxing.manifestType !== "DASH_ON_DEMAND" ||
					!target ||
					isPerTitleRendition(target) ||
					!(
						videoCodecsForDrm.has(target.codec) ||
						AUDIO_CODECS.has(target.codec)
					) ||
					(manifest.adaptationSets?.length &&
						!manifest.adaptationSets.some(
							(set) => set.key === target.dashSetKey,
						)) ||
					!plan.drm.some((drm) => drm.muxingKey === muxing.key)
				) {
					continue;
				}
				// Shared MP4/DRM outputs can give clear OnDemand manifests the
				// encrypted file's index ranges and protection metadata.
				issues.push({
					code: "PLAN_DASH_ONDEMAND_CLEAR_DRM",
					level: "error",
					message: `Clear OnDemand DASH manifest "${manifest.key}" selects MP4 muxing "${muxing.key}" with DRM. Put clear OnDemand MP4 and DRM outputs in separate encoding plans.`,
					path: `manifests[${mIndex}]`,
				});
			}
		}
		if (!("drmKind" in manifest) || !manifest.drmKind) {
			continue;
		}
		for (const muxing of plan.muxings) {
			const target = renditionByKey.get(muxing.streamKey);
			if (!target || muxing.kind === "CHUNKED_TEXT" || muxing.kind === "TEXT") {
				continue;
			}
			const perTitle =
				videoCodecsForDrm.has(target.codec) &&
				"mode" in target &&
				typeof target.mode === "string" &&
				target.mode.startsWith("PER_TITLE");
			let selected = false;
			if (manifest.kind === "DASH" && manifest.profile === "ON_DEMAND") {
				// ON_DEMAND selects DASH_ON_DEMAND-typed MP4 muxings for every
				// AV family (mirrors compileDashManifest).
				selected =
					muxing.kind === "MP4" && muxing.manifestType === "DASH_ON_DEMAND";
			} else if (manifest.kind === "SMOOTH") {
				selected = muxing.kind === "MP4";
			} else if (AUDIO_CODECS.has(target.codec)) {
				selected =
					muxing.kind ===
					(("audioMuxingKind" in manifest
						? manifest.audioMuxingKind
						: undefined) ?? (manifest.kind === "DASH" ? "FMP4" : muxing.kind));
			} else if (videoCodecsForDrm.has(target.codec)) {
				selected =
					manifest.kind === "DASH"
						? dashVideoLegSelected(muxing, manifest, false)
						: !manifest.videoMuxingKind ||
							muxing.kind === manifest.videoMuxingKind;
			}
			if (!selected) {
				continue;
			}
			if (muxing.kind === "CMAF") {
				issues.push({
					code: "PLAN_DRM_MUXING_MISMATCH",
					level: "error",
					message: `manifest "${manifest.key}" pins drmKind ${manifest.drmKind} on CMAF muxing "${muxing.key}" — CMAF DRM is not supported`,
					path: `manifests[${mIndex}].drmKind`,
				});
				continue;
			}
			if (perTitle) {
				continue; // run-time expansion resolves DRM per supported result muxing
			}
			const hasDrm = plan.drm.some(
				(d) => d.muxingKey === muxing.key && d.kind === manifest.drmKind,
			);
			if (!hasDrm) {
				issues.push({
					code: "PLAN_DRM_KIND_UNMATCHED",
					level: "error",
					message: `manifest "${manifest.key}" pins drmKind ${manifest.drmKind} but muxing "${muxing.key}" has no ${manifest.drmKind} DRM — the entry would silently lose protection`,
					path: `manifests[${mIndex}].drmKind`,
				});
			}
		}
	}

	for (const [index, thumbnail] of plan.thumbnails.entries()) {
		const target = renditionByKey.get(thumbnail.streamKey);
		if (!target) {
			issues.push({
				code: "PLAN_UNRESOLVED_REF",
				level: "error",
				message: `thumbnail "${thumbnail.key}" references unknown rendition "${thumbnail.streamKey}"`,
				path: `thumbnails[${index}].streamKey`,
			});
		} else if (!VIDEO_CODECS_FOR_MODE.has(target.codec)) {
			issues.push({
				code: "PLAN_THUMBNAIL_SOURCE_NOT_VIDEO",
				level: "error",
				message: `thumbnail "${thumbnail.key}" must reference a video rendition (got ${target.codec})`,
				path: `thumbnails[${index}].streamKey`,
			});
		}
		if (!outputKeys.has(thumbnail.destination.outputKey)) {
			issues.push({
				code: "PLAN_UNRESOLVED_REF",
				level: "error",
				message: `thumbnail "${thumbnail.key}" references unknown output "${thumbnail.destination.outputKey}"`,
				path: `thumbnails[${index}].destination.outputKey`,
			});
		}
	}

	for (const [index, sprite] of plan.sprites.entries()) {
		const target = renditionByKey.get(sprite.streamKey);
		if (!target) {
			issues.push({
				code: "PLAN_UNRESOLVED_REF",
				level: "error",
				message: `sprite "${sprite.key}" references unknown rendition "${sprite.streamKey}"`,
				path: `sprites[${index}].streamKey`,
			});
		} else if (
			target.codec !== "H264" &&
			target.codec !== "H265" &&
			target.codec !== "VP9" &&
			target.codec !== "AV1"
		) {
			issues.push({
				code: "PLAN_SPRITE_SOURCE_NOT_VIDEO",
				level: "error",
				message: `sprite "${sprite.key}" must reference a video rendition (got ${target.codec})`,
				path: `sprites[${index}].streamKey`,
			});
		}
		if (!outputKeys.has(sprite.destination.outputKey)) {
			issues.push({
				code: "PLAN_UNRESOLVED_REF",
				level: "error",
				message: `sprite "${sprite.key}" references unknown output "${sprite.destination.outputKey}"`,
				path: `sprites[${index}].destination.outputKey`,
			});
		}
		// The encoder derives the missing dimension from the aspect ratio, but
		// at least one of width/height is required.
		if (sprite.width === undefined && sprite.height === undefined) {
			issues.push({
				code: "PLAN_SPRITE_NO_DIMENSION",
				level: "error",
				message: `sprite "${sprite.key}" requires at least one of width/height`,
				path: `sprites[${index}]`,
			});
		}
		// The SDK rejects setting imagesPerFile together with hTiles/vTiles, and
		// hTiles/vTiles must be set as a pair.
		const hasGrid = sprite.hTiles !== undefined || sprite.vTiles !== undefined;
		if (sprite.imagesPerFile !== undefined && hasGrid) {
			issues.push({
				code: "PLAN_SPRITE_TILE_CONFLICT",
				level: "error",
				message: `sprite "${sprite.key}" sets imagesPerFile together with hTiles/vTiles — use one or the other`,
				path: `sprites[${index}].imagesPerFile`,
			});
		}
		if ((sprite.hTiles === undefined) !== (sprite.vTiles === undefined)) {
			issues.push({
				code: "PLAN_SPRITE_TILE_CONFLICT",
				level: "error",
				message: `sprite "${sprite.key}" must set hTiles and vTiles together`,
				path: `sprites[${index}].${sprite.hTiles === undefined ? "hTiles" : "vTiles"}`,
			});
		}
	}

	for (const rendition of plan.renditions) {
		if (!muxedRenditions.has(rendition.key)) {
			/**
			 * AUDIO is an error, everything else stays a warning — and the
			 * asymmetry is principled rather than convenient.
			 *
			 * An unpackaged video rendition produces a delivery that is
			 * obviously broken: the rung is missing and the first person to
			 * open the player sees it. An unpackaged AUDIO rendition produces
			 * one that looks completely healthy — the ladder is there, the
			 * manifest parses, the picture plays — and is silent. Nobody finds
			 * that until someone listens, by which time the encode is billed.
			 *
			 * Added after review found a two-click wizard state that dropped
			 * the track exactly this way . The builder no
			 * longer produces it, but this rail does not depend on the builder
			 * being right: any path that loses an audio track — an import, an
			 * API token, a hand-edited plan — is stopped at the submit
			 * boundary instead of delivering silence.
			 *
			 * Scoped to plans that package something. A `qc.only` plan carries
			 * muxings for their destinations alone, and its own rails already
			 * govern what may appear.
			 */
			const packagesSomething = plan.muxings.length > 0 && !plan.qc?.only;
			const silentDrop =
				packagesSomething &&
				AUDIO_CODECS.has(rendition.codec) &&
				!options.demoteUnmuxedAudio;
			issues.push({
				code: "PLAN_UNMUXED_RENDITION",
				level: silentDrop ? "error" : "warning",
				message: silentDrop
					? `audio rendition "${rendition.key}" is not referenced by any muxing — it would be encoded and billed, and the delivery would play silent`
					: `rendition "${rendition.key}" is not referenced by any muxing — it will be encoded but never packaged`,
				path: "renditions",
			});
		}
	}

	const attachedFilterKeys = new Set(
		plan.renditions.flatMap((r) => (r.filters ?? []).map((a) => a.filterKey)),
	);
	for (const filter of plan.filters) {
		if (filter.kind === "WATERMARK") {
			const input = plan.inputs.find((i) => i.key === filter.inputKey);
			if (!input || !["S3", "GENERIC_S3", "GCS"].includes(input.kind))
				issues.push({
					code: "PLAN_WATERMARK_INPUT",
					level: "error",
					message: `Watermark "${filter.key}" requires an S3, S3-compatible or GCS HMAC input`,
					path: `filters.${filter.key}.inputKey`,
				});
		}

		if (!attachedFilterKeys.has(filter.key)) {
			issues.push({
				code: "PLAN_UNATTACHED_FILTER",
				level: "warning",
				message: `filter "${filter.key}" is not attached to any rendition — it will never be created`,
				path: "filters",
			});
		}
	}

	for (const [index, manifest] of plan.manifests.entries()) {
		if (!outputKeys.has(manifest.destination.outputKey)) {
			issues.push({
				code: "PLAN_UNRESOLVED_REF",
				level: "error",
				message: `manifest "${manifest.key}" references unknown output "${manifest.destination.outputKey}"`,
				path: `manifests[${index}].destination.outputKey`,
			});
		}
		if (manifest.kind === "HLS" && manifest.generationMode === "DEFAULT") {
			const conflicts = defaultHlsPathConflicts(plan, manifest.destination);
			for (const level of ["error", "warning"] as const) {
				const conflict = conflicts.find((row) => row.level === level);
				if (!conflict) continue;
				issues.push({
					code:
						level === "error"
							? "PLAN_DEFAULT_HLS_OUTPUT_PATH"
							: "PLAN_DEFAULT_HLS_OUTPUT_PATH_UNVERIFIED",
					level,
					message:
						level === "error"
							? `Default HLS manifest "${manifest.key}" must use the same directory as, or a parent of, every selected media output on its output resource. ${conflict.owner} writes to "${conflict.destination.path}" outside "${manifest.destination.path || "/"}". Choose a common parent directory or manual manifest generation for parent-relative media paths`
							: `Default HLS manifest "${manifest.key}" has an unverified output hierarchy for ${conflict.owner}: a physical storage alias or dynamic path does not prove the provider's output selection. Use a common parent directory or verify this output mapping before encoding`,
					path: `manifests[${index}].destination.path`,
				});
			}
		}
		// Default generation selects its own tracks on the provider. Manual
		// representation leg checks apply only to the explicit resource tree.
		if (manifest.kind === "DASH" && manifest.generationMode !== "DEFAULT") {
			const videoCodecs = new Set(["H264", "H265", "VP9", "AV1"]);
			const onDemand = manifest.profile === "ON_DEMAND";
			const hasPerTitleVideo = plan.renditions.some(
				(r) =>
					videoCodecs.has(r.codec) &&
					"mode" in r &&
					typeof r.mode === "string" &&
					r.mode.startsWith("PER_TITLE"),
			);
			const hasAdditional =
				(manifest.detailed?.additionalRepresentations?.length ?? 0) > 0;
			const additionalMuxings = new Set(
				manifest.detailed?.additionalRepresentations?.flatMap((rep) =>
					rep.type === "PROGRESSIVE_WEBM" ? [rep.muxingKey] : [],
				) ?? [],
			);
			const hasStatic =
				hasAdditional ||
				plan.muxings.some((muxing) => {
					const target = renditionByKey.get(muxing.streamKey);
					if (!target) {
						return false;
					}
					const perTitle =
						videoCodecs.has(target.codec) &&
						"mode" in target &&
						typeof target.mode === "string" &&
						target.mode.startsWith("PER_TITLE");
					if (perTitle) {
						return false;
					}
					if (
						(target.codec === "IMSC" && muxing.kind === "TEXT") ||
						(target.codec === "WEBVTT" && muxing.kind === "CHUNKED_TEXT")
					)
						return true;
					// The compiler's own leg predicates (dash-legs.ts): ON_DEMAND
					// selects DASH_ON_DEMAND-typed MP4 muxings for both families;
					// segmented profiles select the pinned legs.
					if (AUDIO_CODECS.has(target.codec)) {
						return dashAudioLegSelected(muxing, manifest, onDemand);
					}
					if (videoCodecs.has(target.codec)) {
						return dashVideoLegSelected(muxing, manifest, onDemand);
					}
					return false;
				});
			/*
			 * VIDEO routed in but NONE selected — the audio-only MPD.
			 * The zero-TOTAL rule below could not
			 * see it: an AAC fMP4 leg satisfied "some representation exists"
			 * while every video leg dropped out of the selection. Distinct code,
			 * distinct message, because the fix is one field: name the leg.
			 *
			 * "Routed" mirrors the compiler: with explicit adaptation sets a
			 * rendition joins via `dashSetKey`; without them every fixed video
			 * rendition is in. Per-title video expands at run time and is
			 * excluded here exactly as the selection excludes it.
			 */
			const isFixedVideo = (r: (typeof plan.renditions)[number]) =>
				videoCodecs.has(r.codec) &&
				!(
					"mode" in r &&
					typeof r.mode === "string" &&
					r.mode.startsWith("PER_TITLE")
				);
			const routedVideo = plan.renditions.filter(
				(r) =>
					isFixedVideo(r) &&
					(manifest.adaptationSets?.length ? r.dashSetKey !== undefined : true),
			);
			const videoLegSelected = (muxing: (typeof plan.muxings)[number]) =>
				dashVideoLegSelected(muxing, manifest, onDemand);
			const videoSelected =
				hasPerTitleVideo ||
				routedVideo.some((r) =>
					plan.muxings.some(
						(m) =>
							m.streamKey === r.key &&
							(videoLegSelected(m) || additionalMuxings.has(m.key)),
					),
				);
			if (routedVideo.length > 0 && !videoSelected) {
				const kinds = [
					...new Set(
						plan.muxings
							.filter((m) => routedVideo.some((r) => r.key === m.streamKey))
							.map((m) => m.kind),
					),
				];
				issues.push({
					code: "PLAN_DASH_VIDEO_UNSELECTED",
					level: "error",
					message: `DASH manifest "${manifest.key}" routes ${routedVideo.length} video rendition(s) whose muxings are ${kinds.join("/") || "absent"}, but its video leg is ${manifest.videoMuxingKind ?? "FMP4 (default)"} — every video representation would drop out and the MPD would be audio-only; set videoMuxingKind to the leg the video actually uses`,
					path: `manifests[${index}]`,
				});
			}
			// A video representation (including per-title expansion) must not
			// hide the loss of every audio leg. Use the compiler's leg predicate
			// and, in explicit-set mode, require actual audio-set membership.
			const audio = plan.renditions.filter((r) => AUDIO_CODECS.has(r.codec));
			const audioSelected = audio.some(
				(r) =>
					(!manifest.adaptationSets?.length ||
						manifest.adaptationSets.some(
							(s) => s.key === r.dashSetKey && s.type === "AUDIO",
						)) &&
					plan.muxings.some(
						(m) =>
							m.streamKey === r.key &&
							(dashAudioLegSelected(m, manifest, onDemand) ||
								additionalMuxings.has(m.key)),
					),
			);
			if (audio.length > 0 && !audioSelected) {
				issues.push({
					code: "PLAN_DASH_AUDIO_UNSELECTED",
					level: "error",
					message: `DASH manifest "${manifest.key}" selects no audio representation although the plan has audio renditions — select their audioMuxingKind (FMP4 by default; ON_DEMAND requires DASH_ON_DEMAND MP4) and audio adaptation-set membership`,
					path: `manifests[${index}].audioMuxingKind`,
				});
			}
			if (!hasPerTitleVideo && !hasStatic) {
				issues.push({
					code: "PLAN_DASH_NO_REPRESENTATIONS",
					level: "error",
					message: `DASH manifest "${manifest.key}" would contain no representations — its pinned muxing legs select nothing and no per-title rendition expands at run time`,
					path: `manifests[${index}]`,
				});
			}
			/*
			 * PER-TITLE video across more than one codec has NO compiled shape
			 *
			 *
			 * A set may hold one codec, and
			 * the static representations now each join their own. The per-title
			 * path cannot follow, because `CREATE_DASH_PER_TITLE_REPRESENTATIONS`
			 * is ONE op naming ONE adaptation set and ONE encoding, and its only
			 * server-side filters are muxing kind and `PER_TITLE_RESULT` stream
			 * mode — there is no codec filter to split the results by. So two
			 * per-title codecs in one encoding put both codecs' result
			 * representations in one set (the 400 case 15 measured), and two
			 * per-title codecs in DIFFERENT encodings are worse still: the op
			 * binds to whichever encoding `perTitleEncStep` resolves first and
			 * the other codec's ladder silently never appears in the MPD.
			 *
			 * Refused rather than compiled, because the compiler would otherwise
			 * emit a well-formed op sequence for a plan that cannot deliver.
			 * Scoped to the IMPLICIT branch: with explicit `adaptationSets` the
			 * compiler returns before the expansion and emits no per-title op at
			 * all, so this diagnosis would not describe what it built.
			 */
			if (!manifest.adaptationSets?.length) {
				const perTitleCodecs = [
					...new Set(
						plan.renditions
							.filter(
								(r) =>
									videoCodecs.has(r.codec) &&
									"mode" in r &&
									typeof r.mode === "string" &&
									r.mode.startsWith("PER_TITLE"),
							)
							.map((r) => r.codec),
					),
				].sort();
				if (perTitleCodecs.length > 1) {
					issues.push({
						code: "PLAN_DASH_PER_TITLE_MIXED_CODECS",
						level: "error",
						message: `DASH manifest "${manifest.key}" expands per-title video for ${perTitleCodecs.join(" + ")}, but the run-time expansion creates every PER_TITLE_RESULT representation inside ONE adaptation set and a set may hold only one codec — the second codec's representations are refused (400). Pin the plan's per-title video to a single codec; a second per-title codec needs its own plan.`,
						path: `manifests[${index}]`,
					});
				}
			}
			// A rendition the author ROUTED into this manifest (dashSetKey in
			// explicit mode, any AV rendition implicitly) that has MP4
			// muxings but none typed DASH_ON_DEMAND silently drops out of
			// the selection — that is a forgot-the-manifestType error, not a
			// legitimate mixed-plan leg.
			if (onDemand) {
				const manifestSetKeys = new Set(
					(manifest.adaptationSets ?? []).map((s) => s.key),
				);
				for (const [rIndex, r] of plan.renditions.entries()) {
					if (r.codec === "WEBVTT" || r.codec === "IMSC") {
						continue;
					}
					const routed = manifest.adaptationSets?.length
						? r.dashSetKey !== undefined && manifestSetKeys.has(r.dashSetKey)
						: true;
					if (!routed) {
						continue;
					}
					const mp4Muxings = plan.muxings.filter(
						(m): m is Extract<(typeof plan.muxings)[number], { kind: "MP4" }> =>
							m.streamKey === r.key && m.kind === "MP4",
					);
					const hasTyped = mp4Muxings.some(
						(m) => m.manifestType === "DASH_ON_DEMAND",
					);
					// Fire on mistyped MP4 legs anywhere; with explicit
					// dashSetKey routing the intent is unambiguous, so a
					// rendition with NO MP4 muxing at all is an error too
					// (it would silently vanish from the manifest).
					if (
						!hasTyped &&
						(mp4Muxings.length > 0 || Boolean(manifest.adaptationSets?.length))
					) {
						issues.push({
							code: "PLAN_DASH_ONDEMAND_MUXING_TYPE",
							level: "error",
							message:
								mp4Muxings.length > 0
									? `rendition "${r.key}" routes into ON_DEMAND manifest "${manifest.key}" but none of its MP4 muxings (${mp4Muxings.map((m) => m.key).join(", ")}) is typed DASH_ON_DEMAND — it would silently drop out of the manifest`
									: `rendition "${r.key}" routes into ON_DEMAND manifest "${manifest.key}" via dashSetKey but has no DASH_ON_DEMAND MP4 muxing — it would silently drop out of the manifest`,
							path: `renditions[${rIndex}]`,
						});
					}
				}
			}
		}
	}

	// Flag layouts whose segment references leave the manifest directory.
	// The compiler resolves these through parent or absolute paths. One issue
	// per manifest (stable issue identity for UIs). Empty base = bucket
	// root: everything is under it (mirrors relativeSegmentPath).
	for (const [mIndex, manifest] of plan.manifests.entries()) {
		const raw = manifest.destination.path;
		const base = raw === "" || raw.endsWith("/") ? raw : `${raw}/`;
		// Effective write path per muxing: its own destination plus any DRM
		// destinations (encrypted outputs feed the manifest too).
		const outside = [
			...plan.muxings
				.filter(
					(muxing) =>
						muxing.destination && !muxing.destination.path.startsWith(base),
				)
				.map((muxing) => muxing.key),
			...plan.drm
				.filter((drm) => !drm.destination.path.startsWith(base))
				.map((drm) => `drm:${drm.key}`),
		];
		if (outside.length > 0) {
			issues.push({
				code: "PLAN_SEGMENT_PATH_NOT_UNDER_MANIFEST",
				level: "warning",
				message: `muxing(s) ${outside.join(", ")} write outside manifest "${manifest.key}" base path — their segment references use parent or absolute paths`,
				path: `manifests[${mIndex}].destination.path`,
			});
		}
	}

	// C1 — codec-agnostic: any per-title stream mode combined with
	// explicit-entry manifests (our STANDARD shape enumerates muxings, i.e.
	// custom manifests in API terms) must use post-encoding generation.
	// The THIRD copy of this predicate, now the shared one (the compiler had its
	// own and so did the capture module). They agreed, but the per-title RESULT
	// capture compiles exactly one op bound to exactly one encoding, and its
	// correctness rests on this validator's rules — so the two must be reasoning
	// about the same set of renditions by construction, not by coincidence.
	const perTitleRenditions = plan.renditions.filter(isPerTitleRendition);
	for (const [index, rendition] of plan.renditions.entries()) {
		if (
			rendition.codec === "H265" &&
			plan.internal?.hevcV2 &&
			(rendition.perTitleSettings?.codecMaxBitrateFactor !== undefined ||
				rendition.perTitleSettings?.codecBufsizeFactor !== undefined)
		) {
			issues.push({
				code: "PLAN_PER_TITLE_STREAM_CODEC_FACTOR",
				level: "error",
				message:
					"Per-Title stream codec factors are supported for H264 and H265, not H265V2",
				path: `renditions.${index}.perTitleSettings`,
			});
		}
		if (
			isPerTitleRendition(rendition) &&
			"bitrate" in rendition &&
			rendition.bitrate !== null
		) {
			issues.push({
				code: "PLAN_PER_TITLE_BITRATE",
				level: "error",
				message:
					"Per-Title template codec bitrate must be null; use perTitleSettings for fixed bitrate bounds",
				path: `renditions.${index}.bitrate`,
			});
		}
	}
	const hasPerTitle = perTitleRenditions.length > 0;
	if (
		hasPerTitle &&
		plan.manifests.length > 0 &&
		plan.generation.timing === "JUST_IN_TIME"
	) {
		issues.push({
			code: "C1",
			level: "error",
			message:
				"Per-Title with custom manifests requires post-encoding generation (PER_TITLE_RESULT streams only exist after the run)",
			path: "generation.timing",
		});
	}

	// C4 — per-title muxing paths need expansion placeholders, and
	// per-title outputs cannot target SFTP.
	const perTitleKeys = new Set(perTitleRenditions.map((r) => r.key));
	const outputByKey = new Map(plan.outputs.map((o) => [o.key, o]));
	// C4 is an ALLOWLIST (S3/GenericS3/GCS/Akamai NetStorage/Azure) —
	// new output kinds must opt in, not slip through a denylist. DRM
	// destinations are write paths too and get the same checks.
	// review-250 115-A1: the Set said (S3, AZURE) while this very comment,
	// the shared contract's C4 and BOTH error messages list S3/GenericS3/GCS/Akamai/
	// Azure — so per-title + a GCS output (the #115 flagship pairing) was
	// falsely rejected by an error that names GCS as supported. SFTP stays
	// out: C4's denylist half is real.
	const C4_ALLOWED_OUTPUT_KINDS = new Set([
		"S3",
		"AZURE",
		"GENERIC_S3",
		"GCS",
		"GCS_SERVICE_ACCOUNT",
		// . The set's own comment, both error strings, the shared contract's
		// C4 and the Akamai design doc all listed NetStorage as supported while
		// this Set did not contain it — so a per-title plan was refused by a
		// message naming the kind it refused. That is review-250 115-A1
		// recurring verbatim (GCS, same shape), which is why the test below now
		// pins the set PER KIND against the schema rather than by count.
		"AKAMAI_NETSTORAGE",
	]);
	// C31  — SHARED with the live validator, which is the path
	// this constraint exists for. The first cut lived only here, and a live
	// plan reuses the same output union while going through a different issue
	// set entirely, so the check never ran where it was needed (review-4).

	issues.push(
		...checkAkamaiMslConstraints({
			//  PR 1: rail 6 keys on this, and MSL5 is live-only —
			// so the VOD door is the one where it fires.
			encodingKind: "VOD",
			credentialHasPublishingAuth: options.credentialHasPublishingAuth,
			outputs: plan.outputs,
			muxings: plan.muxings,
			manifests: plan.manifests,
			deliveryMirrors: plan.deliveryMirrors,
			drm: plan.drm,
			qcOnly: plan.qc?.only,
			// The compiler's synthesized QC mirrors (review-6 I3), each with the
			// container the compiler chooses for its codec (review-324 I1: the
			// checker had "MP4" hard-coded, a third reader of `qcMirrorMuxingKind`'s
			// fact). VIDEO renditions only — the compiler emits no mirror for
			// audio, and the first cut listed every rendition's output. Resolved
			// here rather than inside the checker because it needs the whole
			// plan; the checker stays structural so live can share it.
			qcMirrors:
				plan.qc?.vmaf || plan.qc?.psnr
					? plan.renditions.flatMap((r) => {
							if (!["H264", "H265", "VP9", "AV1"].includes(r.codec)) {
								return [];
							}
							const outputKey = renditionOutputBase(plan, r.key)?.outputKey;
							return outputKey === undefined
								? []
								: [{ outputKey, muxingKind: qcMirrorMuxingKind(r.codec) }];
						})
					: undefined,
		}),
	);
	// : mirrors carry the SAME per-title paths (placeholders come
	// along for free), but each mirror OUTPUT must be per-title-capable too.
	if (perTitleKeys.size > 0 && plan.deliveryMirrors) {
		for (const [index, mirror] of plan.deliveryMirrors.entries()) {
			const output = outputByKey.get(mirror.outputKey);
			if (output && !C4_ALLOWED_OUTPUT_KINDS.has(output.kind)) {
				issues.push({
					code: "C4",
					level: "error",
					message: `delivery mirror "${mirror.outputKey}" is a ${output.kind} output — per-title supports S3/GenericS3/GCS/Akamai NetStorage/Azure only`,
					path: `deliveryMirrors.${index}.outputKey`,
				});
			}
		}
	}
	const c4Check = (
		label: string,
		destination: { outputKey: string; path: string } | undefined,
		issuePath: string,
	) => {
		if (!destination) {
			return;
		}
		if (
			!destination.path.includes("{uuid}") &&
			!destination.path.includes("{bitrate}")
		) {
			issues.push({
				code: "C4",
				level: "error",
				message: `per-title ${label} output path needs a {uuid} or {bitrate} placeholder — expanded renditions would overwrite each other`,
				path: `${issuePath}.path`,
			});
		}
		const output = outputByKey.get(destination.outputKey);
		if (output && !C4_ALLOWED_OUTPUT_KINDS.has(output.kind)) {
			issues.push({
				code: "C4",
				level: "error",
				message: `per-title ${label} targets a ${output.kind} output — per-title supports S3/GenericS3/GCS/Akamai NetStorage/Azure only`,
				path: `${issuePath}.outputKey`,
			});
		}
	};
	for (const [index, muxing] of plan.muxings.entries()) {
		if (!perTitleKeys.has(muxing.streamKey)) {
			continue;
		}
		// A per-title TEMPLATE muxing expands server-side into one result
		// muxing per chosen rendition (C1). Whether Bitmovin copies the
		// muxed-in audio stream into each expansion is not documented and is
		// not something this repo has measured against the live API — so this
		// warns rather than blocks: the combination may well work, and an
		// error would forbid a plan on a guess. Named here so an operator who
		// hits it knows it is UNVERIFIED rather than unsupported.
		if (hasMuxedInAudio(muxing, renditionByKey)) {
			issues.push({
				code: "PLAN_PER_TITLE_MUXED_AUDIO",
				level: "warning",
				message: `muxing "${muxing.key}" muxes audio into a per-title template — whether the audio stream is carried into each expanded rendition is unverified against the live API; a separate audio muxing is the proven shape`,
				path: `muxings[${index}].additionalStreamKeys`,
			});
		}
		c4Check(
			`muxing "${muxing.key}"`,
			muxing.destination,
			`muxings[${index}].destination`,
		);
	}
	for (const [index, drm] of plan.drm.entries()) {
		const muxing = muxingByKey.get(drm.muxingKey);
		if (!muxing || !perTitleKeys.has(muxing.streamKey)) {
			continue;
		}
		c4Check(`drm "${drm.key}"`, drm.destination, `drm[${index}].destination`);
	}

	// Per-title renditions need the matching start-request configuration.
	const missingPerTitleConfig = (field: string) => {
		issues.push({
			code: "PLAN_PER_TITLE_CONFIG_MISSING",
			level: "error",
			message: `per-title renditions exist but perTitle.${field} is missing from the start request`,
			path: "perTitle",
		});
	};
	if (
		perTitleRenditions.some((r) => r.codec === "H264") &&
		!plan.perTitle?.h264Configuration
	) {
		missingPerTitleConfig("h264Configuration");
	}
	if (
		perTitleRenditions.some((r) => r.codec === "H265") &&
		!(plan.internal?.hevcV2
			? plan.perTitle?.h265V2Configuration
			: plan.perTitle?.h265Configuration)
	) {
		missingPerTitleConfig(
			plan.internal?.hevcV2 ? "h265V2Configuration" : "h265Configuration",
		);
	}
	if (
		perTitleRenditions.some((r) => r.codec === "VP9") &&
		!plan.perTitle?.vp9Configuration
	) {
		missingPerTitleConfig("vp9Configuration");
	}
	if (
		perTitleRenditions.some((r) => r.codec === "AV1") &&
		!plan.perTitle?.av1Configuration
	) {
		missingPerTitleConfig("av1Configuration");
	}
	if (plan.perTitle && !hasPerTitle) {
		issues.push({
			code: "PLAN_PER_TITLE_CONFIG_UNUSED",
			level: "warning",
			message:
				"perTitle start configuration is set but no rendition uses a per-title mode",
			path: "perTitle",
		});
	}

	/**
	 * QC needs bytes it can READ BACK, and that is knowable now — not after the
	 * encode is billed .
	 *
	 * `qc.vmaf`/`qc.psnr` make the compiler synthesize QC mirror MP4s, Bitmovin
	 * runs and BILLS the encode, and only then does the measurement worker try
	 * to download the reference and the mirror. Its resolver refuses any IO the
	 * storage browser cannot GET — so an Akamai Object Storage (`GENERIC_S3`)
	 * plan, or a `GCS`/`GCS_SERVICE_ACCOUNT` one, produced a paid encode and a
	 * VMAF job in ERROR. With a blocking QC gate the delivery then reads
	 * QC_FAILED, blaming quality for what was a plumbing fact all along.
	 *
	 * Scoped to the IO the QC targets ACTUALLY touch (`enumerateQcTargets`
	 * resolves reference and mirror per rendition), not to every IO the plan
	 * declares: a plan may legitimately deliver to SFTP or MSL while its QC
	 * mirror lands in a bucket we can read. Rejecting on declaration would
	 * refuse plans that work.
	 *
	 * The rule is `vmafSourceFor` in core, shared verbatim with the worker's
	 * resolver — two copies of it is how a schema kind grew past one of them
	 * without anything going red.
	 */
	/**
	 * The trigger duplicates `enumerateQcTargets`'s own `vmaf || psnr` gate, so
	 * replacing this whole condition with `plan.qc !== undefined` cannot be
	 * distinguished by any test — the loop below simply iterates nothing
	 * (review demonstrated it). It is kept as defence in depth, NOT because it
	 * is pinned: the vmaf/psnr SPLIT is pinned (dropping `psnr` changes which
	 * path the issue points at), the condition's existence is not and cannot
	 * be. Said plainly here because "pinned in both directions" was written
	 * about this and was not true of the second direction.
	 */
	if (
		plan.qc?.measurementMethod &&
		(plan.qc.execution?.backend !== "CLOUD" ||
			enumerateFrameIndexQcTargets(plan).length === 0)
	) {
		issues.push({
			code: "QC_FRAME_INDEX_SOURCE",
			level: "error",
			path: "qc.measurementMethod",
			message:
				"Frame-index measurement requires Cloud execution and complete QC mirrors with a direct full-length first-video source, without trimming, concatenation or filters",
		});
	}

	if (plan.qc?.vmaf || plan.qc?.psnr) {
		/**
		 * SEVERITY tracks the actual harm (review finding 3).
		 *
		 * `error` is a hard block at every submission door, so it must be
		 * reserved for the case where the outcome genuinely depends on QC: a
		 * gate makes the DELIVERY conditional on a number that cannot be
		 * produced. With no gate the encode is exactly what was asked for and
		 * fully useful — the operator loses a measurement, not a delivery, and
		 * refusing the whole submission over that is out of proportion.
		 *
		 * The first cut errored unconditionally, which also meant a FINISHED
		 * job could stop being re-runnable the moment this rail landed.
		 */
		const level: PlanIssueLevel =
			plan.qc.gate && !options.demoteQcIoReadable ? "error" : "warning";
		const cost = plan.qc.gate
			? "The encode would run and bill, then the gate would have no number to judge and the delivery would be marked failed"
			: "The encode would run and bill, and only the measurement would fail";
		const seen = new Set<string>();
		for (const target of enumerateQcTargets(plan)) {
			for (const [role, key, path] of [
				["reference", target.reference.inputKey, "qc.reference"],
				[
					"QC mirror",
					target.distorted.outputKey,
					plan.qc.vmaf ? "qc.vmaf" : "qc.psnr",
				],
			] as const) {
				const io =
					role === "reference"
						? plan.inputs.find((i) => i.key === key)
						: plan.outputs.find((o) => o.key === key);
				if (!io || seen.has(`${role}:${key}`)) {
					continue;
				}
				const source = vmafSourceFor(io);
				if (source.streamable) {
					continue;
				}
				seen.add(`${role}:${key}`);
				issues.push({
					code: "PLAN_QC_IO_NOT_READABLE",
					level,
					message: `quality control is enabled, but its ${role} "${key}" cannot be read back for scoring: ${source.reason}. ${cost} — disable qc.vmaf/qc.psnr or point this side at a browsable object store.`,
					path,
				});
			}
		}
	}

	// VMAF-only encode (qc.only): the encode produces ONLY the per-video QC
	// mirror MP4s — no delivery muxings, manifests, audio, thumbnails, sprites,
	// DRM, or keyframes. Reject a plan that asks for those alongside qc.only
	// (the compiler drops them, so they would be a silent surprise) and a plan
	// that would produce nothing at all. Muxings stay ALLOWED — they carry the
	// qc mirror's destination (compiler §4). Only runs when qc.only is set, so
	// the 56 goldens (no qc) are unaffected.
	if (plan.qc?.only) {
		const qcVideoCodecs = new Set(["H264", "H265", "VP9", "AV1"]);
		if (!plan.qc.vmaf && !plan.qc.psnr) {
			issues.push({
				code: "PLAN_QC_ONLY_NO_METRIC",
				level: "error",
				message:
					"VMAF-only encode (qc.only) produces nothing unless qc.vmaf or qc.psnr is true",
				path: "qc",
			});
		}
		if (!plan.renditions.some((r) => qcVideoCodecs.has(r.codec))) {
			issues.push({
				code: "PLAN_QC_ONLY_NO_VIDEO",
				level: "error",
				message:
					"VMAF-only encode (qc.only) needs at least one video rendition to mirror",
				path: "renditions",
			});
		}
		// A qc mirror only emits for a VIDEO rendition whose muxing carries a
		// destination (compiler §4 base resolution). Without one the encode would
		// have ZERO muxings — Bitmovin rejects a start on a muxing-less encoding.
		if (
			!plan.renditions.some(
				(r) =>
					qcVideoCodecs.has(r.codec) &&
					plan.muxings.some((m) => m.streamKey === r.key && m.destination),
			)
		) {
			issues.push({
				code: "PLAN_QC_ONLY_NO_MIRROR",
				level: "error",
				message:
					"VMAF-only encode (qc.only) produces no QC mirror: a video rendition needs a muxing with a destination",
				path: "muxings",
			});
		}
		// Non-video renditions (audio/subtitle) score nothing in VMAF and are
		// dropped by the compiler — forbid them so the drop is never silent.
		if (plan.renditions.some((r) => !qcVideoCodecs.has(r.codec))) {
			issues.push({
				code: "PLAN_QC_ONLY_FORBIDDEN_RESOURCE",
				level: "error",
				message:
					"VMAF-only encodes score video only; remove non-video (audio/subtitle) renditions or disable qc.only",
				path: "renditions",
			});
		}
		// AI Scene Analysis still emits its asset-description output (not a QC
		// mirror) — forbid it under qc.only.
		if (plan.aiSceneAnalysis) {
			issues.push({
				code: "PLAN_QC_ONLY_FORBIDDEN_RESOURCE",
				level: "error",
				message:
					"VMAF-only encodes produce no AI scene analysis output; remove it or disable qc.only",
				path: "aiSceneAnalysis",
			});
		}
		// Resources the qc.only compiler never emits — carrying them is an error
		// (they would be silently dropped). Muxings are intentionally NOT here.
		const emptyForbidden: [keyof EncodingPlan, string][] = [
			["manifests", "manifests"],
			["thumbnails", "thumbnails"],
			["sprites", "sprites"],
			["drm", "drm"],
			["keyframes", "keyframes"],
		];
		for (const [field, label] of emptyForbidden) {
			if ((plan[field] as unknown[]).length > 0) {
				issues.push({
					code: "PLAN_QC_ONLY_FORBIDDEN_RESOURCE",
					level: "error",
					message: `VMAF-only encodes produce no ${label}; remove them or disable qc.only`,
					path: label,
				});
			}
		}
	}

	// QC gate rails . Errors are the
	// unsatisfiable configs; the qc.only/no-manifest cases are WARNINGS that
	// state the MARK_ONLY normalization instead of silently switching.
	if (plan.qc?.gate) {
		const gate = plan.qc.gate;
		if (!plan.qc.vmaf) {
			issues.push({
				code: "PLAN_QC_GATE_WITHOUT_VMAF",
				level: "error",
				message: "qc.gate is a gate over nothing unless qc.vmaf is true (C29)",
				path: "qc.gate",
			});
		}
		// review-204 I2: gte 0 cannot fail on QUALITY (VMAF and PSNR are both
		// ≥ 0) — the rule degenerates to "was it measured at all". A config
		// lie of the C29 nothing-to-block class, so it WARNS with the honest
		// residual meaning rather than erroring (measurement-presence gating
		// is a legitimate, if unusual, intent).
		if (gate.rules.some((rule) => rule.gte === 0)) {
			issues.push({
				code: "PLAN_QC_GATE_GTE_ZERO",
				level: "warning",
				message:
					"a gte of 0 passes every measured rendition; only unmeasured targets can fail this rule (C29)",
				path: "qc.gate.rules",
			});
		}
		// review-204 N3: a gate over a ladder with ZERO video renditions can
		// never pass under BLOCK_MANIFESTS (every default-population rule
		// fails on an empty expected set) — fails safe, but say it at save
		// time (the qc.only precedent one screen up).
		if (
			!plan.renditions.some(
				(rendition) =>
					rendition.codec === "H264" ||
					rendition.codec === "H265" ||
					rendition.codec === "VP9" ||
					rendition.codec === "AV1",
			)
		) {
			issues.push({
				code: "PLAN_QC_GATE_NO_VIDEO",
				level: "warning",
				message:
					"qc.gate has no video renditions to judge — default-population rules can only fail (C29)",
				path: "qc.gate.rules",
			});
		}
		if (
			gate.rules.some((rule) => rule.metric === "PSNR_MEAN") &&
			!plan.qc.psnr
		) {
			issues.push({
				code: "PLAN_QC_GATE_PSNR_OFF",
				level: "error",
				message:
					"a PSNR_MEAN gate rule needs qc.psnr: true — the run would never measure it (C29)",
				path: "qc.gate.rules",
			});
		}
		// Rules naming renditions must name renditions the PLAN has — a rule
		// over a typo would fail as UNMEASURED at runtime; say it at save.
		const renditionKeys = new Set(plan.renditions.map((r) => r.key));
		for (const rule of gate.rules) {
			for (const key of rule.renditions ?? []) {
				if (!renditionKeys.has(key)) {
					issues.push({
						code: "PLAN_QC_GATE_UNKNOWN_RENDITION",
						level: "error",
						message: `qc.gate rule names rendition "${key}", which this plan does not define (C29)`,
						path: "qc.gate.rules",
					});
				}
			}
		}
		if (gate.onFail === "BLOCK_MANIFESTS") {
			if (plan.generation.timing !== "POST_ENCODING") {
				issues.push({
					code: "PLAN_QC_GATE_BLOCK_JIT",
					level: "error",
					message:
						"onFail: BLOCK_MANIFESTS needs generation.timing POST_ENCODING — JIT manifests exist before VMAF can run, so blocking them is unsatisfiable (C29; composes with C1)",
					path: "qc.gate.onFail",
				});
			}
			if (plan.qc.only || plan.manifests.length === 0) {
				issues.push({
					code: "PLAN_QC_GATE_NOTHING_TO_BLOCK",
					level: "warning",
					message:
						"onFail: BLOCK_MANIFESTS has nothing to block on this plan (qc.only or no manifests) — the gate runs with MARK_ONLY semantics (C29)",
					path: "qc.gate.onFail",
				});
			}
		}
	}

	checkSecretEgressHosts(
		secretEgressSites(plan),
		options.secretEgressAllowedHosts,
		issues,
	);

	return issues;
}

export function planHasErrors(issues: PlanIssue[]): boolean {
	return issues.some((issue) => issue.level === "error");
}
