import { BITMOVIN_CLOUD_REGIONS } from "../bitmovin/schemas";
import { outputStorageKeys } from "../plan/output-files";
import { AUDIO_CODECS, type PlanDrm } from "../plan/schema";
import type { PlanIssue, PlanValidationOptions } from "../plan/validate";
import {
	type FilenameLanguage,
	filenameLanguagesOverlap,
	outputFilenameLanguage,
} from "./filename-language";
import type { LiveChannelPlan, LiveManifestPlan, LiveMuxing } from "./schema";

/** A manifest selects the encrypted leg by kind; clear manifests use the muxing. */
export function liveManifestDrm(
	plan: LiveChannelPlan,
	muxing: LiveMuxing,
	manifest: LiveManifestPlan,
): PlanDrm | undefined {
	return manifest.drmKind
		? plan.drm?.find(
				(d) => d.muxingKey === muxing.key && d.kind === manifest.drmKind,
			)
		: undefined;
}

export function liveMediaDestination(
	plan: LiveChannelPlan,
	muxing: LiveMuxing,
	manifest?: LiveManifestPlan,
) {
	return manifest
		? manifest.drmKind
			? liveManifestDrm(plan, muxing, manifest)?.destination
			: muxing.destination
		: (muxing.destination ??
				plan.drm?.find((d) => d.muxingKey === muxing.key)?.destination);
}

/** SDK restriction: a concrete region (or AUTO), on one provider, at most three. */
export function liveFallbackRegionIssues(plan: LiveChannelPlan): PlanIssue[] {
	const issues: PlanIssue[] = [];
	const regions = plan.bitmovin.fallbackCloudRegions ?? [];
	const provider = plan.bitmovin.cloudRegion.split("_")[0];
	const families = new Set(
		regions.filter((r) => r !== "AUTO").map((r) => r.split("_")[0]),
	);
	const valid = new Set<string>(BITMOVIN_CLOUD_REGIONS);
	const concrete = (r: string) =>
		r === "AUTO" || (valid.has(r) && /^(AWS|GOOGLE|AZURE|AKAMAI|OCI)_/.test(r));
	if (
		regions.length > 3 ||
		new Set(regions).size !== regions.length ||
		regions.some((r) => !concrete(r)) ||
		families.size > 1 ||
		(provider !== "AUTO" && [...families].some((f) => f !== provider)) ||
		(regions.length &&
			(plan.bitmovin.infrastructure ||
				plan.bitmovin.cloudRegion === "EXTERNAL"))
	)
		issues.push({
			code: "LIVE_FALLBACK_REGIONS",
			level: "error",
			path: "bitmovin.fallbackCloudRegions",
			message:
				"Choose up to three distinct concrete regions or AUTO on the primary cloud provider. Cloud Connect does not support managed fallback regions.",
		});
	return issues;
}

function liveOutputFilenames(muxing: LiveMuxing) {
	if (muxing.kind === "MP4")
		return [{ pattern: muxing.filename, template: false }];
	return [
		{
			pattern: muxing.segmentNamingTemplate || muxing.segmentNaming,
			template: Boolean(muxing.segmentNamingTemplate),
		},
		...(muxing.kind === "TS"
			? []
			: [
					{
						pattern:
							muxing.kind === "CMAF" && muxing.initSegmentNameTemplate
								? muxing.initSegmentNameTemplate
								: muxing.initSegmentName,
						template:
							muxing.kind === "CMAF" && Boolean(muxing.initSegmentNameTemplate),
					},
				]),
	];
}

export function liveDrmIssues(
	plan: LiveChannelPlan,
	options: PlanValidationOptions,
): PlanIssue[] {
	const issues: PlanIssue[] = [];
	const add = (code: string, path: string, message: string) =>
		issues.push({ code, path, message, level: "error" });
	const keys = new Set<string>();
	const legs = new Set<string>();
	for (const [i, drm] of (plan.drm ?? []).entries()) {
		const path = `drm[${i}]`;
		if (keys.has(drm.key))
			add(
				"LIVE_DUPLICATE_KEY",
				`${path}.key`,
				"DRM resource keys must be unique",
			);
		keys.add(drm.key);
		const identity = `${drm.muxingKey}:${drm.kind}`;
		if (legs.has(identity))
			add(
				"LIVE_DRM_AMBIGUOUS",
				path,
				"Only one encrypted leg of each kind is supported per muxing",
			);
		legs.add(identity);
		const muxing = plan.muxings.find((m) => m.key === drm.muxingKey);
		if (!muxing)
			add(
				"LIVE_UNRESOLVED_REF",
				`${path}.muxingKey`,
				"DRM references an unknown muxing",
			);
		else if (
			!(drm.kind === "FAIRPLAY" ? ["FMP4", "TS"] : ["FMP4"]).includes(
				muxing.kind,
			)
		)
			add(
				"LIVE_DRM_MUXING_MISMATCH",
				`${path}.muxingKey`,
				`${drm.kind} cannot encrypt a ${muxing.kind} Live muxing`,
			);
		if (!plan.outputs.some((o) => o.key === drm.destination.outputKey))
			add(
				"LIVE_UNRESOLVED_REF",
				`${path}.destination.outputKey`,
				"DRM references an unknown output",
			);
		const expectedProvider = drm.kind === "SPEKE" ? "DRM_SPEKE" : "DRM_CENC";
		if (
			options.credentialProviders &&
			options.credentialProviders.get(drm.credentialId) !== expectedProvider
		)
			add(
				"DRM_CREDENTIAL",
				`${path}.credentialId`,
				`Select an existing ${expectedProvider} credential`,
			);
		if (drm.kind === "CENC") {
			const mode = drm.encryptionMode ?? "CTR";
			if (
				drm.ivSize &&
				drm.ivSize !== (mode === "CBC" ? "IV_16_BYTES" : "IV_8_BYTES")
			)
				add(
					"C9",
					`${path}.ivSize`,
					"CENC CTR requires an 8-byte IV; CBC requires a 16-byte IV",
				);
			if (drm.fairPlay && mode !== "CBC")
				add(
					"LIVE_DRM_FAIRPLAY_CBC",
					`${path}.encryptionMode`,
					"FairPlay metadata requires CBC encryption",
				);
		}
		if (
			drm.kind === "SPEKE" &&
			drm.systemIds.some((id) =>
				[
					"94ce86fb-07ff-4f43-adb8-93d2fa968ca2",
					"3ea8778f-7742-4bf9-b18b-e834b2acbd47",
				].includes(id.toLowerCase()),
			) &&
			!drm.iv
		)
			add("DRM_IV", `${path}.iv`, "FairPlay/AES-128 requires a 16-byte IV");
	}
	const reservations = new Map<
		string,
		{ owner: string; language: FilenameLanguage | undefined }[]
	>();
	const conflicts = new Set<string>();
	for (const [index, muxing] of plan.muxings.entries()) {
		const destinations = [
			...(muxing.destination
				? [{ destination: muxing.destination, owner: `muxing:${muxing.key}` }]
				: []),
			...(plan.drm ?? [])
				.filter((d) => d.muxingKey === muxing.key)
				.map((d) => ({ destination: d.destination, owner: `drm:${d.key}` })),
		];
		for (const { destination, owner } of destinations) {
			for (const filename of liveOutputFilenames(muxing)) {
				const language = outputFilenameLanguage(
					destination.path,
					filename.pattern,
					filename.template,
				);
				if (!language) {
					add(
						"LIVE_OUTPUT_PATTERN_UNVERIFIED",
						`muxings[${index}]`,
						"The output filename pattern exceeds bounded validation or contains an unsupported random-token length. Choose a shorter, valid filename pattern.",
					);
					continue;
				}
				for (const storage of outputStorageKeys(plan, destination.outputKey)) {
					const previous = reservations.get(storage) ?? [];
					for (const writer of previous) {
						const pair = [writer.owner, owner].sort().join("\0");
						if (
							writer.owner !== owner &&
							!conflicts.has(pair) &&
							filenameLanguagesOverlap(writer.language, language)
						) {
							add(
								"LIVE_DRM_OUTPUT_COLLISION",
								"drm",
								`Output writers ${writer.owner} and ${owner} may write the same physical filename after token expansion. Choose separate folders or segment names.`,
							);
							conflicts.add(pair);
						}
					}
					previous.push({ owner, language });
					reservations.set(storage, previous);
				}
			}
		}
	}
	for (const [i, manifest] of plan.liveManifests.entries()) {
		for (const muxing of plan.muxings.filter(
			(m) =>
				m.kind !== "MP4" &&
				(manifest.kind === "HLS" ? m.kind !== "CMAF" : m.kind !== "TS"),
		)) {
			if (
				manifest.videoMuxingKind &&
				plan.renditions.some(
					(r) => r.key === muxing.streamKey && !AUDIO_CODECS.has(r.codec),
				) &&
				muxing.kind !== manifest.videoMuxingKind
			)
				continue;
			if (
				manifest.audioMuxingKind &&
				plan.renditions.some(
					(r) => r.key === muxing.streamKey && AUDIO_CODECS.has(r.codec),
				) &&
				muxing.kind !== manifest.audioMuxingKind
			)
				continue;
			const drm = liveManifestDrm(plan, muxing, manifest);
			if (manifest.drmKind && !drm)
				add(
					"LIVE_MANIFEST_DRM_MISSING",
					`liveManifests[${i}].drmKind`,
					`${manifest.kind} selects ${manifest.drmKind}, but muxing ${muxing.key} has no matching encrypted output`,
				);
			if (!manifest.drmKind && !muxing.destination)
				add(
					"LIVE_MANIFEST_CLEAR_OUTPUT_MISSING",
					`liveManifests[${i}].drmKind`,
					`Muxing ${muxing.key} has encrypted output only; choose its encryption kind`,
				);
		}
	}
	return issues;
}
