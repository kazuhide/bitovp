/**
 * The per-title RESULT population's video codec families, as the verifier's
 * third witness.
 *
 * A per-title manifest's video ladder is the ENCODER's, so the expectation
 * compiler cannot bind its rungs to plan geometry (C1). What the plan does know
 * is the codec FAMILY of every template — and what the provider's captured
 * RESULT streams know is the family of every rung it actually produced. The
 * engine compares three sets: declared (the plan), actual (this capture), and
 * the families the manifest itself enumerates. The manifest is always the
 * OBSERVED side; nothing here, and nothing in the engine, reads a family off
 * the MPD/master and hands it back as an expectation.
 *
 * Three states, because "no capture" and "a truncated capture" must not read
 * as "the encoder produced nothing": `complete` carries the families, and the
 * other two carry the reason the comparison is UNVERIFIED — the engine turns
 * them into an explicit SKIP, never an empty-set FAIL and never a PASS.
 */

import {
	PER_TITLE_ATTRIBUTION_VERSION,
	PER_TITLE_SCHEMA_VERSION,
	type PerTitleResultStream,
	type PerTitleResultsView,
} from "../plan/per-title-results";
import {
	isQcMirrorOutputPath,
	QC_MIRROR_MUXING_TYPES,
} from "../plan/qc-mirror";
import {
	type PerTitleProviderResult,
	perTitleVariantFromPath,
} from "../vmaf/per-title-population";

export type PerTitleActualVideoFamilies =
	| {
			status: "complete";
			/** Codec families of every captured RESULT stream, sorted, de-duplicated. */
			families: string[];
			/** How many RESULT streams the families were read from. */
			results: number;
	  }
	| { status: "incomplete"; reason: string }
	| { status: "absent"; reason: string };

/** Positive, finite facts captured from a provider RESULT, never template hints. */
export type PerTitleActualVideo = {
	width?: number;
	height?: number;
	bitrate?: number;
	fps?: number;
};

export type PerTitleActualOutputLeg = PerTitleProviderResult & {
	templateRendition?: string;
	muxingType: string;
	filename?: string;
	drmId?: string;
	drmType?: string;
};

export type PerTitleActualQcUnit = {
	streamId: string;
	templateRendition?: string;
	/** The provider-resolved rung identity used by VmafResult.perTitleVariant. */
	variant: string;
	/** Delivery mirrors are candidates for one score unit, never extra score units. */
	mirrors: PerTitleActualOutputLeg[];
};

export type PerTitleActualDeliveryMuxing = {
	streamId: string;
	templateRendition?: string;
	muxingId: string;
	muxingType: string;
	filename?: string;
	/** Every clear and DRM output remains a separate material delivery leg. */
	legs: PerTitleActualOutputLeg[];
};

export type PerTitleActualPopulations =
	| {
			status: "complete";
			results: Array<{
				streamId: string;
				templateRendition?: string;
				/** The captured provider codec, never inferred from the attributed template. */
				codecType?: string;
				/** Actual codec parameters, with applied dimensions taking precedence. */
				video?: PerTitleActualVideo;
			}>;
			/** Exactly one score unit per RESULT, with zero or more mirror candidates. */
			qc: PerTitleActualQcUnit[];
			/** Provider muxings, each retaining all of its clear and DRM output legs. */
			deliveryMuxings: PerTitleActualDeliveryMuxing[];
	  }
	| { status: "incomplete"; reason: string }
	| { status: "absent"; reason: string };

function normalizeDir(path: string): string {
	return path.endsWith("/") ? path : `${path}/`;
}

function positiveFinite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

function actualVideo(
	stream: PerTitleResultStream,
): PerTitleActualVideo | undefined {
	const video: PerTitleActualVideo = {};
	const values = {
		width:
			positiveFinite(stream.appliedSettings?.width) ??
			positiveFinite(stream.params.width),
		height:
			positiveFinite(stream.appliedSettings?.height) ??
			positiveFinite(stream.params.height),
		bitrate: positiveFinite(stream.params.bitrate),
		fps: positiveFinite(stream.params.rate),
	};
	for (const field of ["width", "height", "bitrate", "fps"] as const) {
		if (values[field] !== undefined) video[field] = values[field];
	}
	return Object.keys(video).length > 0 ? video : undefined;
}

/**
 * Derive the two per-title populations used by release verification.
 *
 * The provider snapshot is the authority for cardinality. Plan templates are
 * only constraints on that population; they must never cause the same shared
 * prefix to be scanned once per template. A versionless/truncated snapshot, or
 * an output whose provider identity cannot be read, is incomplete evidence and
 * therefore cannot support a release PASS.
 */
export function perTitleActualPopulations(
	view: PerTitleResultsView,
): PerTitleActualPopulations {
	if (view.origin === "absent") {
		return {
			status: "absent",
			reason: "no per-title RESULT capture has been recorded for this job",
		};
	}
	if (view.origin === "failed") {
		return {
			status: "absent",
			reason: `the per-title RESULT capture failed: ${view.error}`,
		};
	}
	const { snapshot } = view;
	if (!snapshot.scan.complete) {
		return {
			status: "incomplete",
			reason: `the per-title RESULT capture stopped before the end of the provider's lists (scan.complete=false; ${snapshot.streams.length} RESULT stream(s) captured of ${snapshot.scan.streamsListed} listed)`,
		};
	}
	if (
		(snapshot.schemaVersion ?? 0) < PER_TITLE_SCHEMA_VERSION ||
		(snapshot.attributionVersion ?? 0) < PER_TITLE_ATTRIBUTION_VERSION
	) {
		return {
			status: "incomplete",
			reason: `legacy per-title RESULT snapshot version (schema ${snapshot.schemaVersion ?? 0}/${PER_TITLE_SCHEMA_VERSION}, attribution ${snapshot.attributionVersion ?? 0}/${PER_TITLE_ATTRIBUTION_VERSION}) cannot prove output-leg identity`,
		};
	}
	if (snapshot.scan.resultsCaptured !== snapshot.streams.length) {
		return {
			status: "incomplete",
			reason: `the per-title RESULT snapshot says ${snapshot.scan.resultsCaptured} result(s) were captured but persists ${snapshot.streams.length}`,
		};
	}
	for (const stream of snapshot.streams) {
		for (const muxing of stream.muxings) {
			for (const output of [
				...muxing.outputs,
				...muxing.drm.flatMap((drm) => drm.outputs),
			]) {
				if (
					typeof output.outputId !== "string" ||
					output.outputId.length === 0
				) {
					return {
						status: "incomplete",
						reason: `RESULT ${stream.streamId} muxing ${muxing.muxingId} has an output leg without outputId`,
					};
				}
				if (
					typeof output.outputPath !== "string" ||
					output.outputPath.length === 0
				) {
					return {
						status: "incomplete",
						reason: `RESULT ${stream.streamId} muxing ${muxing.muxingId} has output ${output.outputId} without a resolved outputPath`,
					};
				}
			}
		}
	}

	const results: Extract<
		PerTitleActualPopulations,
		{ status: "complete" }
	>["results"] = [];
	const qc: PerTitleActualQcUnit[] = [];
	const deliveryMuxings: PerTitleActualDeliveryMuxing[] = [];
	for (const stream of snapshot.streams) {
		const resultIdentity = {
			streamId: stream.streamId,
			...(stream.templateRendition !== undefined
				? { templateRendition: stream.templateRendition }
				: {}),
		};
		const video = actualVideo(stream);
		results.push({
			...resultIdentity,
			...(stream.codecType !== undefined
				? { codecType: stream.codecType }
				: {}),
			...(video ? { video } : {}),
		});

		const qcMuxings = stream.muxings.filter(
			(muxing) =>
				QC_MIRROR_MUXING_TYPES.has(muxing.muxingType.toUpperCase()) &&
				muxing.outputs.some(
					(output) =>
						typeof output.outputPath === "string" &&
						isQcMirrorOutputPath(output.outputPath),
				),
		);
		const mirrors = qcMuxings.flatMap((muxing) =>
			muxing.outputs
				.filter(
					(output) =>
						typeof output.outputPath === "string" &&
						isQcMirrorOutputPath(output.outputPath),
				)
				.map(
					(output): PerTitleActualOutputLeg => ({
						...resultIdentity,
						muxingId: muxing.muxingId,
						muxingType: muxing.muxingType,
						...(muxing.filename !== undefined
							? { filename: muxing.filename }
							: {}),
						outputId: output.outputId as string,
						resolvedPath: normalizeDir(output.outputPath as string),
					}),
				),
		);
		qc.push({
			...resultIdentity,
			variant:
				perTitleVariantFromPath(mirrors[0]?.resolvedPath ?? "") ??
				stream.streamId,
			mirrors,
		});

		const qcMuxingIds = new Set(qcMuxings.map((muxing) => muxing.muxingId));
		for (const muxing of stream.muxings) {
			if (qcMuxingIds.has(muxing.muxingId)) {
				continue;
			}
			const clear = muxing.outputs.map(
				(output): PerTitleActualOutputLeg => ({
					...resultIdentity,
					muxingId: muxing.muxingId,
					muxingType: muxing.muxingType,
					...(muxing.filename !== undefined
						? { filename: muxing.filename }
						: {}),
					outputId: output.outputId as string,
					resolvedPath: normalizeDir(output.outputPath as string),
				}),
			);
			const encrypted = muxing.drm.flatMap((drm) =>
				drm.outputs.map(
					(output): PerTitleActualOutputLeg => ({
						...resultIdentity,
						muxingId: muxing.muxingId,
						muxingType: muxing.muxingType,
						...(muxing.filename !== undefined
							? { filename: muxing.filename }
							: {}),
						drmId: drm.drmId,
						drmType: drm.drmType,
						outputId: output.outputId as string,
						resolvedPath: normalizeDir(output.outputPath as string),
					}),
				),
			);
			deliveryMuxings.push({
				...resultIdentity,
				muxingId: muxing.muxingId,
				muxingType: muxing.muxingType,
				...(muxing.filename !== undefined ? { filename: muxing.filename } : {}),
				legs: [...clear, ...encrypted],
			});
		}
	}

	const byIdentity = <T extends { streamId: string; muxingId?: string }>(
		a: T,
		b: T,
	) =>
		a.streamId.localeCompare(b.streamId) ||
		(a.muxingId ?? "").localeCompare(b.muxingId ?? "");
	results.sort((a, b) => a.streamId.localeCompare(b.streamId));
	qc.sort((a, b) => a.streamId.localeCompare(b.streamId));
	deliveryMuxings.sort(byIdentity);
	for (const unit of qc) {
		unit.mirrors.sort(
			(a, b) =>
				a.outputId.localeCompare(b.outputId) ||
				a.resolvedPath.localeCompare(b.resolvedPath),
		);
	}
	for (const muxing of deliveryMuxings) {
		muxing.legs.sort(
			(a, b) =>
				(a.drmId ?? "").localeCompare(b.drmId ?? "") ||
				a.outputId.localeCompare(b.outputId) ||
				a.resolvedPath.localeCompare(b.resolvedPath),
		);
	}
	return { status: "complete", results, qc, deliveryMuxings };
}

/**
 * Derive the actual families from the job's per-title results view (the
 * capture step's response, or the backfilled column — `perTitleResultsView`
 * has already chosen the best evidence).
 *
 * `codecType` on a RESULT stream is the provider's codec-configuration type
 * (`H264` / `H265` / `H265V2` / `VP9` / `AV1`). Family comparisons map
 * H265V2 to H265; attribution keeps the exact provider type. A stream whose
 * config read failed carries no `codecType` (`scan.codecConfigErrors`), and a
 * capture that hit the page cap reports `scan.complete: false`; either makes
 * the set unknowable rather than smaller, hence `incomplete`.
 */
export function perTitleActualVideoFamilies(
	view: PerTitleResultsView,
): PerTitleActualVideoFamilies {
	if (view.origin === "absent") {
		return {
			status: "absent",
			reason: "no per-title RESULT capture has been recorded for this job",
		};
	}
	if (view.origin === "failed") {
		return {
			status: "absent",
			reason: `the per-title RESULT capture failed: ${view.error}`,
		};
	}
	const { snapshot } = view;
	if (!snapshot.scan.complete) {
		return {
			status: "incomplete",
			reason: `the per-title RESULT capture stopped before the end of the provider's lists (scan.complete=false; ${snapshot.streams.length} RESULT stream(s) captured of ${snapshot.scan.streamsListed} listed)`,
		};
	}
	const untyped = snapshot.streams.filter(
		(s) => s.codecType === undefined || s.codecType === "",
	).length;
	if (untyped > 0) {
		return {
			status: "incomplete",
			reason: `${untyped} of ${snapshot.streams.length} captured RESULT stream(s) carry no codec type (scan.codecConfigErrors=${snapshot.scan.codecConfigErrors}), so the actual family set is unknowable`,
		};
	}
	const families = [
		...new Set(
			snapshot.streams.flatMap((s) =>
				s.codecType !== undefined
					? [s.codecType === "H265V2" ? "H265" : s.codecType]
					: [],
			),
		),
	].sort();
	return { status: "complete", families, results: snapshot.streams.length };
}
