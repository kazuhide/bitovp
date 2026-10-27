/**
 * Assemble the Live/MSL evidence TUPLE from what one live run observed
 *
 *
 * One leg per (manifest, delivery target):
 *
 * ORIGIN legs every manifest on its primary output, witnessed through the
 * storage driver — the master the runner read (bytes, hash),
 * the muxing prefixes it LISTED at each sample (nonzero object
 * sizes are the media witness; the bytes are not downloaded, so
 * there is no hash), and the media playlist's sequence number.
 * EDGE legs every (manifest, AKAMAI_MSL mirror), witnessed on the delivery
 * edge by the resolver's in-run closures: master, children,
 * fetched init + media with SHA-256s, one probe per sample.
 *
 * The verdict per leg is core's `liveEvidenceCompleteness` — this module only
 * gathers; it never decides. Everything it emits is credential-free: edge
 * URLs arrive already redacted from the resolver, storage keys carry no
 * credential, and the source is a location + version identity, never a URL.
 */

import {
	type ExpectedLiveArtefacts,
	LIVE_EVIDENCE_VERSION,
	type LiveChannelPlan,
	type LiveEvidenceChild,
	type LiveEvidenceLeg,
	type LiveEvidenceLegInput,
	type LiveEvidenceProbe,
	liveEvidenceProgression,
	redactUrl,
	sealLiveEvidenceLeg,
	selectExpectedLiveManifestMuxings,
	selectLiveManifestMuxings,
} from "@bitovp/core";
import { closureProbe, type LiveEdgeClosure, sha256Hex } from "./edge-resolver";
import type { LiveSample } from "./engine-live";
import type { LiveCleanupSeal } from "./live-cleanup-seal";
import { liveStorageObjects } from "./live-storage-objects";
import type { BoundLiveMslOutput } from "./runner-live";

/** At most this many object keys per child per probe are persisted. */
const MAX_PROBE_KEYS = 50;
/** At most this many listed media objects per origin child are persisted. */
const MAX_ORIGIN_MEDIA = 12;

export type LiveEvidenceInputs = {
	scenario: string;
	expected: ExpectedLiveArtefacts;
	plan: LiveChannelPlan;
	build: { commit: string; image?: string; planSha256: string };
	/** The fed object; absent when the ingest could not be fed. */
	source?: LiveEvidenceLegInput["source"];
	channel: Omit<
		LiveEvidenceLegInput["channel"],
		"requiredProviderStreamKeys" | "requiredProviderOutputKeys"
	>;
	outputPrefix: string;
	samples: readonly LiveSample[];
	manifestFiles: readonly {
		manifestKey: string;
		kind: "HLS" | "DASH" | "SMOOTH";
		key: string;
		bytes?: number;
		sha256?: string;
		entries?: number;
		referenceChecks?: readonly {
			id: string;
			verdict: string;
			detail: string;
		}[];
		error?: string;
	}[];
	/** Credential-safe bindings derived from the exact rewritten MSL outputs. */
	mslOutputs?: readonly BoundLiveMslOutput[];
	cleanup?: LiveCleanupSeal;
	/**
	 * EV-01's post-teardown provider-set dossier. The tuple never promotes the
	 * product's local STOPPED projection to provider proof; this exact-set
	 * readback is the only source for `providerTerminal.confirmed`.
	 */
	intentTerminal?: LiveIntentTerminalDossier;
};

export type LiveIntentTerminalDossier = {
	cleanupState: "CLEANED" | "UNRESOLVED";
	readback: unknown;
	providerId?: string | null;
	providerIds?: readonly string[];
};

const PROVIDER_TERMINAL_STATUSES = new Set([
	"FINISHED",
	"ERROR",
	"CANCELED",
	"TRANSFER_ERROR",
	"NOT_FOUND",
]);

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function sameStringMap(
	value: unknown,
	expected: Readonly<Record<string, string>>,
): boolean {
	const candidate = record(value);
	if (!candidate) {
		return false;
	}
	const keys = Object.keys(candidate);
	return (
		keys.length === Object.keys(expected).length &&
		keys.every(
			(key) =>
				typeof candidate[key] === "string" && candidate[key] === expected[key],
		)
	);
}

/**
 * Bind one tuple to EV-01's complete, exact provider set. Live currently owns
 * one provider encoding per channel, so any extra/missing id is unresolved,
 * even when every candidate happened to reach a terminal status.
 */
export function providerTerminalFromIntentDossier(
	dossier: LiveIntentTerminalDossier | undefined,
	channel: Pick<
		LiveEvidenceLegInput["channel"],
		| "channelId"
		| "liveChannelRunId"
		| "providerEncodingId"
		| "providerStreamIds"
		| "providerOutputIds"
	>,
): LiveEvidenceLegInput["providerTerminal"] {
	const unconfirmed = (detail: string) => ({ confirmed: false, detail });
	if (!dossier) {
		return unconfirmed("no EV-01 provider terminal dossier was supplied");
	}
	if (dossier.cleanupState !== "CLEANED") {
		return unconfirmed("EV-01 provider-set cleanup is UNRESOLVED");
	}
	const readback = record(dossier.readback);
	if (!readback || readback.channelId !== channel.channelId) {
		return unconfirmed("EV-01 readback does not bind the exact channel id");
	}
	if (
		readback.providerIdentityComplete !== true ||
		readback.providerIdentityConflict !== false ||
		readback.providerProofUncertain !== false
	) {
		return unconfirmed("EV-01 provider identity is incomplete or conflicting");
	}
	const encodingId = channel.providerEncodingId;
	const cleanup = record(readback.cleanup);
	if (
		!cleanup ||
		cleanup.channelId !== channel.channelId ||
		cleanup.liveChannelRunId !== channel.liveChannelRunId ||
		cleanup.providerEncodingId !== encodingId ||
		!sameStringMap(cleanup.providerStreamIds, channel.providerStreamIds) ||
		!sameStringMap(cleanup.providerOutputIds, channel.providerOutputIds)
	) {
		return unconfirmed(
			"EV-01 cleanup readback does not bind the airing's exact provider resources",
		);
	}
	const providerIds = dossier.providerIds;
	if (
		!encodingId ||
		!providerIds ||
		providerIds.length !== 1 ||
		providerIds[0] !== encodingId ||
		dossier.providerId !== encodingId
	) {
		return unconfirmed(
			"EV-01 provider id set does not exactly equal the channel encoding",
		);
	}
	const rawStatuses = readback.providerStatuses;
	if (!Array.isArray(rawStatuses) || rawStatuses.length !== 1) {
		return unconfirmed("EV-01 provider status set is absent or not singular");
	}
	const status = record(rawStatuses[0]);
	if (
		status?.encodingId !== encodingId ||
		typeof status.status !== "string" ||
		!PROVIDER_TERMINAL_STATUSES.has(status.status)
	) {
		return unconfirmed(
			"EV-01 did not read the exact channel encoding in a terminal provider status",
		);
	}
	const observedAt = readback.providerTerminalObservedAt;
	if (typeof observedAt !== "string" || Number.isNaN(Date.parse(observedAt))) {
		return unconfirmed(
			"EV-01 provider terminal readback has no observation time",
		);
	}
	return {
		confirmed: true,
		encodingId,
		status: status.status,
		observedAt,
		detail: `EV-01 exact provider set read ${encodingId} ${status.status}`,
	};
}

function common(
	inputs: LiveEvidenceInputs,
	options: {
		requiredProviderStreamKeys: string[];
		requiredProviderOutputKeys: string[];
		storageRetained: boolean;
	},
): Pick<
	LiveEvidenceLegInput,
	| "version"
	| "scenario"
	| "build"
	| "source"
	| "channel"
	| "providerTerminal"
	| "cleanup"
> {
	const seal = inputs.cleanup;
	const providerTerminal = providerTerminalFromIntentDossier(
		inputs.intentTerminal,
		inputs.channel,
	);
	return {
		version: LIVE_EVIDENCE_VERSION,
		scenario: inputs.scenario,
		build: inputs.build,
		source: inputs.source ?? { location: "" },
		channel: {
			...inputs.channel,
			requiredProviderStreamKeys: options.requiredProviderStreamKeys,
			requiredProviderOutputKeys: options.requiredProviderOutputKeys,
		},
		providerTerminal,
		cleanup: {
			clean: seal?.clean === true && providerTerminal.confirmed,
			queueDrained: seal?.queueDrained.established === true,
			processGone:
				seal?.feederProcessGone.established === true &&
				seal?.hostProcessGone.established === true,
			storageRetained: options.storageRetained,
			tokenCleanup: {
				required: seal?.tokenRequired === true,
				confirmed: seal?.tokenCleanup.established === true,
				detail: seal?.tokenCleanup.detail ?? "no cleanup seal was computed",
			},
		},
	};
}

function manifestMuxings(
	inputs: LiveEvidenceInputs,
	manifestKey: string,
): ReturnType<typeof selectLiveManifestMuxings> {
	const manifest = inputs.plan.liveManifests.find(
		(candidate) => candidate.key === manifestKey,
	);
	return manifest ? selectLiveManifestMuxings(inputs.plan, manifest) : [];
}

/** Objects under a muxing prefix at one sample, nonzero and not the init. */
function mediaUnder(
	sample: LiveSample,
	muxing: ExpectedLiveArtefacts["muxings"][number],
): { key: string; bytes: number }[] {
	return liveStorageObjects(sample.objects ?? [], muxing)
		.media.filter((o) => (o.size ?? 0) > 0)
		.map((o) => ({ key: o.key, bytes: o.size ?? 0 }));
}

function originProbe(
	sample: LiveSample,
	muxings: ExpectedLiveArtefacts["muxings"],
): LiveEvidenceProbe {
	// ORIGIN witnesses the expected muxings through nonzero storage objects.
	// A playlist is metadata, not an extra media child: while a DVR fills,
	// its media sequence stays zero even as every muxing gains segments.
	// The engine checks playlist movement separately; keep this probe's
	// topology identical to the leg's expected muxing children. Do not add
	// sequence-only children with empty served lists (Run32 false refusal).
	const children: LiveEvidenceProbe["children"] = muxings.map((m) => {
		const keys = mediaUnder(sample, m)
			.map((o) => o.key)
			.sort();
		return {
			id: m.muxingKey,
			served: keys.slice(-MAX_PROBE_KEYS),
		};
	});
	const readErrors = sample.readErrors ?? [];
	return {
		at: new Date(sample.at).toISOString(),
		children,
		...(readErrors.length > 0 ? { error: readErrors.join("; ") } : {}),
	};
}

function originLeg(
	inputs: LiveEvidenceInputs,
	manifest: ExpectedLiveArtefacts["manifests"][number],
): LiveEvidenceLeg {
	const file = inputs.manifestFiles.find(
		(f) => f.manifestKey === manifest.manifestKey,
	);
	const last = inputs.samples[inputs.samples.length - 1];
	const muxings = selectExpectedLiveManifestMuxings(
		inputs.expected,
		manifest,
	).map((m) => ({ ...m, outputKey: manifest.outputKey }));
	for (const media of manifest.hlsAdditionalMedia ?? []) {
		if (media.type !== "VIDEO" || !media.uri) continue;
		const source = inputs.expected.muxings.find(
			(muxing) =>
				muxing.muxingKey === media.muxingKey &&
				(media.drmKey
					? muxing.drmKey === media.drmKey
					: muxing.drmKind === manifest.drmKind),
		);
		if (source)
			muxings.push({
				...source,
				muxingKey: media.uri,
				outputKey: manifest.outputKey,
			});
	}
	const children: LiveEvidenceChild[] = muxings.map((m) => {
		const media = last ? mediaUnder(last, m) : [];
		const candidates = liveStorageObjects(last?.objects ?? [], m).init;
		const initObject =
			candidates.length === 1 && (candidates[0]?.size ?? 0) > 0
				? candidates[0]
				: undefined;
		const additional =
			manifest.hlsAdditionalMedia?.findIndex(
				(media) => media.type === "VIDEO" && media.uri === m.muxingKey,
			) ?? -1;
		const checks =
			additional >= 0
				? file?.referenceChecks?.filter((check) =>
						check.id.startsWith(
							`live:manifest:${manifest.manifestKey}:additional-media:${additional}:`,
						),
					)
				: undefined;
		const bound =
			additional < 0 ||
			(checks?.some(
				(check) => check.id.endsWith(":binding") && check.verdict === "PASS",
			) === true &&
				checks.some(
					(check) => check.id.endsWith(":objects") && check.verdict === "PASS",
				) &&
				!checks.some((check) => check.verdict === "FAIL"));
		return {
			id: m.muxingKey,
			requiresInit:
				m.initSegment !== undefined || m.initSegmentNameTemplate !== undefined,
			...(initObject
				? { init: { key: initObject.key, bytes: initObject.size ?? 0 } }
				: {}),
			listed: media.length,
			media: media.slice(-MAX_ORIGIN_MEDIA),
			missing: bound
				? []
				: [
						"The additional VIDEO child's actual references were not verified against its configured writer",
					],
		};
	});
	const probes = inputs.samples.map((s) => originProbe(s, muxings));
	const externalIds =
		manifest.kind === "HLS"
			? (manifest.hlsAdditionalMedia ?? [])
					.filter((media) => media.vttUrl !== undefined)
					.map((media) => media.uri ?? "external-subtitle")
			: (manifest.dashExternalSubtitles ?? []).map(
					(_subtitle, index) => `external-subtitle-${index}`,
				);
	for (const [index, id] of externalIds.entries())
		children.push({
			id,
			externalContent: "UNVERIFIED",
			requiresInit: false,
			listed: 1,
			media: [],
			missing: file?.referenceChecks?.some(
				(check) =>
					check.id.endsWith(`:external-subtitle:${index}:reference`) &&
					check.verdict === "PASS",
			)
				? []
				: ["Configured external subtitle reference was not verified"],
		});
	const storageRetained =
		file?.error === undefined &&
		(file?.bytes ?? 0) > 0 &&
		children.length === muxings.length + externalIds.length &&
		!(
			file?.referenceChecks?.some((check) => check.verdict === "FAIL") ?? false
		) &&
		children.every(
			(child) =>
				(child.externalContent === "UNVERIFIED" ||
					child.media.some((media) => media.bytes > 0)) &&
				(!child.requiresInit || (child.init?.bytes ?? 0) > 0),
		);
	return sealLiveEvidenceLeg({
		...common(inputs, {
			requiredProviderStreamKeys: [
				...new Set(muxings.map((muxing) => muxing.streamKey)),
			],
			requiredProviderOutputKeys: [manifest.outputKey],
			storageRetained,
		}),
		outputLeg: `${manifest.manifestKey}@${manifest.outputKey}`,
		manifestKey: manifest.manifestKey,
		outputKey: manifest.outputKey,
		kind: manifest.kind,
		role: "ORIGIN",
		output: { prefix: inputs.outputPrefix },
		topology: {
			expectedChildCount: muxings.length + externalIds.length,
			expectedChildIds: [
				...muxings.map((muxing) => muxing.muxingKey),
				...externalIds,
			],
		},
		...(file && file.error === undefined && file.bytes !== undefined
			? {
					master: {
						key: file.key,
						bytes: file.bytes,
						...(file.sha256 !== undefined ? { sha256: file.sha256 } : {}),
						...(file.entries !== undefined ? { entries: file.entries } : {}),
					},
				}
			: {}),
		children,
		probes,
		progression: liveEvidenceProgression(probes[0], probes[probes.length - 1]),
	});
}

function edgeLeg(
	inputs: LiveEvidenceInputs,
	manifest: ExpectedLiveArtefacts["manifests"][number],
	target: { outputKey: string },
): LiveEvidenceLeg {
	const binding = inputs.mslOutputs?.find(
		(candidate) => candidate.outputKey === target.outputKey,
	);
	const providerOutputId = inputs.channel.providerOutputIds[target.outputKey];
	const matches = (c: LiveEdgeClosure) =>
		c.manifestKey === manifest.manifestKey &&
		c.outputKey === target.outputKey &&
		binding !== undefined &&
		c.msl?.credentialId === binding.credentialId &&
		c.msl?.providerOutputId === providerOutputId &&
		c.msl?.streamId === binding.streamId &&
		c.msl?.eventName === binding.eventName &&
		c.msl?.streamFormat === binding.streamFormat &&
		c.msl?.mslVersion === binding.mslVersion;
	const closures = inputs.samples.flatMap((s) =>
		(s.edge ?? []).filter(matches),
	);
	const last = closures[closures.length - 1];
	const probes = closures.map(closureProbe);
	const children: LiveEvidenceChild[] = (last?.children ?? []).map((c) => ({
		id: c.id,
		...(c.externalContent ? { externalContent: c.externalContent } : {}),
		requiresInit: c.requiresInit,
		url: c.url,
		...(c.bytes !== undefined ? { bytes: c.bytes } : {}),
		...(c.sha256 !== undefined ? { sha256: c.sha256 } : {}),
		...(c.mediaSequence !== undefined
			? { mediaSequence: c.mediaSequence }
			: {}),
		listed: c.listed,
		...(() => {
			const init = c.served.find((served) => served.init);
			return init
				? {
						init: {
							key: init.key,
							url: init.url,
							bytes: init.bytes,
							sha256: init.sha256,
						},
					}
				: {};
		})(),
		media: c.served
			.filter((s) => !s.init)
			.map((s) => ({
				key: s.key,
				url: s.url,
				bytes: s.bytes,
				sha256: s.sha256,
				// WP-C6b: the object's own age and the manifest's raw reference
				// ride into the durable tuple beside the hash.
				...(s.lastModified !== undefined
					? { lastModified: s.lastModified }
					: {}),
				...(s.reference !== undefined ? { reference: s.reference } : {}),
			})),
		missing: c.missing,
	}));
	const selected = manifestMuxings(inputs, manifest.manifestKey);
	const expectedChildIds =
		manifest.kind === "HLS" ? manifest.mediaPlaylists : undefined;
	const expectedChildCount =
		manifest.kind === "HLS"
			? manifest.mediaPlaylists.length
			: selected.length + (manifest.dashExternalSubtitles?.length ?? 0);
	const storageRetained =
		(last?.master?.bytes ?? 0) > 0 &&
		children.length === expectedChildCount &&
		children.every(
			(child) =>
				(child.externalContent === "UNVERIFIED" ||
					child.media.some((media) => media.bytes > 0)) &&
				(!child.requiresInit || (child.init?.bytes ?? 0) > 0),
		);
	return sealLiveEvidenceLeg({
		...common(inputs, {
			requiredProviderStreamKeys: selected.map(
				({ muxing }) => muxing.streamKey,
			),
			requiredProviderOutputKeys: [target.outputKey],
			storageRetained,
		}),
		outputLeg: `${manifest.manifestKey}@${target.outputKey}`,
		manifestKey: manifest.manifestKey,
		outputKey: target.outputKey,
		kind: manifest.kind,
		role: "EDGE",
		...(binding?.eventRoot
			? {
					msl: {
						outputKey: binding.outputKey,
						credentialId: binding.credentialId,
						...(providerOutputId ? { providerOutputId } : {}),
						streamId: binding.streamId,
						eventName: binding.eventName,
						streamFormat: binding.streamFormat,
						mslVersion: binding.mslVersion,
						eventRoot: redactUrl(binding.eventRoot, sha256Hex),
					},
				}
			: {}),
		topology: {
			expectedChildCount,
			...(expectedChildIds ? { expectedChildIds } : {}),
		},
		output: {
			prefix: inputs.outputPrefix,
			...(last?.master ? { edge: last.master.url } : {}),
		},
		...(last?.master
			? {
					master: {
						key: manifest.files[0] ?? "",
						url: last.master.url,
						bytes: last.master.bytes,
						sha256: last.master.sha256,
						...(last.master.entries !== undefined
							? { entries: last.master.entries }
							: {}),
					},
				}
			: {}),
		children,
		probes,
		progression: liveEvidenceProgression(probes[0], probes[probes.length - 1]),
	});
}

/**
 * Every leg of one live scenario, each sealed by the completeness rule. Legs
 * come from the PLAN (manifests × delivery targets), never from what was
 * observed — a target nobody looked at is an INCOMPLETE leg, not a missing row.
 */
export function assembleLiveEvidence(
	inputs: LiveEvidenceInputs,
): LiveEvidenceLeg[] {
	const legs: LiveEvidenceLeg[] = [];
	const primaryEdges = new Set(
		(inputs.expected.mslEdgeOutputs ?? [])
			.filter((target) => target.role === "PRIMARY")
			.map((target) => target.outputKey),
	);
	const mirrorEdges = (inputs.expected.mslEdgeOutputs ?? []).filter(
		(target) => target.role === "MIRROR",
	);
	for (const manifest of inputs.expected.manifests) {
		if (primaryEdges.has(manifest.outputKey)) {
			legs.push(edgeLeg(inputs, manifest, { outputKey: manifest.outputKey }));
		} else {
			legs.push(originLeg(inputs, manifest));
		}
		for (const target of mirrorEdges) {
			legs.push(edgeLeg(inputs, manifest, target));
		}
	}
	return legs;
}
