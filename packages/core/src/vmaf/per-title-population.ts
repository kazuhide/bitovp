import type { PerTitleResultsSnapshot } from "../plan/per-title-results";
import { QC_MIRROR_MUXING_TYPES, qcMirrorFilename } from "../plan/qc-mirror";

/**
 * The per-title VMAF POPULATION, taken from the ladder the provider actually
 * built .
 *
 * A per-title rendition is ONE plan entry that the encoder expands into N
 * rungs at run time; the QC mirror follows each rung into its resolved
 * `{height}p_{bitrate}_{uuid}/qc/` directory. The runner used to discover the
 * rungs by LISTING the bucket under the template's prefix inside a time window
 * — which is a guess at the population: a rung whose mirror was never written
 * simply did not appear (so the ladder looked complete and the gate passed it),
 * and a listing that found nothing ERRORed the whole job, every other rung
 * with it.
 *
 * `CAPTURE_PER_TITLE_RESULTS` already records the ladder the provider built
 * (`PerTitleResultsSnapshot`: one stream per rung, attributed to its template
 * rendition, with every muxing's resolved output path). That is the population.
 * A rung whose snapshot carries no QC-mirror muxing is reported as UNMEASURED —
 * by name, with the reason — so the gate can hold it against the bar instead
 * of never hearing about it.
 */

/** Exact provider identity of the QC output selected for one RESULT stream. */
export type PerTitleProviderResult = {
	streamId: string;
	muxingId: string;
	outputId: string;
	/** Provider-resolved output directory, slash-terminated. */
	resolvedPath: string;
};

export type PerTitleRung =
	| {
			variant: string;
			streamId: string;
			/** The mirror's exact object key — no listing, no time window. */
			key: string;
			/**
			 * Exact RESULT → muxing → output identity retained by current captures.
			 * Absent only on legacy snapshots whose output row predates outputId
			 * capture; those snapshots cannot support exact release verification.
			 */
			providerResult?: PerTitleProviderResult;
	  }
	| {
			variant: string;
			streamId: string;
			missing: true;
			reason: string;
	  };

function normalizeDir(path: string): string {
	return path.endsWith("/") ? path : `${path}/`;
}

/**
 * The rung's label: the resolved value of the template's placeholder segment
 * (`{height}p_{bitrate}_{uuid}` → `360p_500000_e5f6`), read off any of the
 * rung's output paths at the same depth — so a rung that has no `qc/` muxing
 * is still named by its ladder position, not by whichever directory happened
 * to come last. Falls back to the segment before `qc/`, then the last one.
 */
export function perTitleVariantFromPath(
	path: string,
	templatePath?: string,
): string | undefined {
	const parts = normalizeDir(path)
		.split("/")
		.filter((p) => p.length > 0);
	if (templatePath !== undefined) {
		const templateParts = templatePath.split("/").filter((p) => p.length > 0);
		const at = templateParts.findIndex((p) => p.includes("{"));
		if (at >= 0 && at < parts.length) {
			return parts[at];
		}
	}
	const qcAt = parts.lastIndexOf("qc");
	const idx = qcAt > 0 ? qcAt - 1 : parts.length - 1;
	return parts[idx];
}

export function perTitleRungsFromSnapshot(
	snapshot: PerTitleResultsSnapshot,
	target: {
		renditionKey: string;
		codec: string;
		/** Provider output resource created for the target's exact outputKey. */
		providerOutputId: string;
		/** The compiler's templated mirror path — names the placeholder depth. */
		distorted?: { path: string };
	},
): PerTitleRung[] {
	const templatePath = target.distorted?.path;
	const filename = qcMirrorFilename(target.renditionKey, target.codec);
	const rungs: PerTitleRung[] = [];
	for (const stream of snapshot.streams) {
		if (stream.templateRendition !== target.renditionKey) {
			continue;
		}
		// The decodable QC mirror: an unencrypted MP4/WebM leg whose OWN output is a
		// qc/ directory on the exact provider output created for the target's plan
		// output key. A delivery mirror can put the same object key on several output
		// resources, so array order is not identity. Its captured `filename` is the
		// exact object the provider wrote (audit 602ec286 §5.4 item 5); attribution
		// has already guaranteed it
		// equals `qcMirrorFilename(target)`, so the derived name is only a fallback
		// for older snapshots that predate filename capture. One score unit per
		// RESULT — the leg bound to `providerOutputId` (a DRM'd delivery leg is not
		// decodable and never has an own `m.outputs` entry, so reading `m.outputs`
		// skips it: 0 DRM duplicates).
		const mirror = (():
			| {
					dir: string;
					filename: string;
					muxingId: string;
					outputId?: string;
			  }
			| undefined => {
			for (const m of stream.muxings) {
				if (!QC_MIRROR_MUXING_TYPES.has(m.muxingType.toUpperCase())) {
					continue;
				}
				const qcOutput = m.outputs.find(
					(output) =>
						output.outputId === target.providerOutputId &&
						typeof output.outputPath === "string" &&
						/(^|\/)qc\/?$/.test(output.outputPath),
				);
				if (qcOutput?.outputPath !== undefined) {
					return {
						dir: qcOutput.outputPath,
						filename:
							typeof m.filename === "string" && m.filename.length > 0
								? m.filename
								: filename,
						muxingId: m.muxingId,
						...(typeof qcOutput.outputId === "string" &&
						qcOutput.outputId.length > 0
							? { outputId: qcOutput.outputId }
							: {}),
					};
				}
			}
			return undefined;
		})();
		if (mirror !== undefined) {
			const variant =
				perTitleVariantFromPath(mirror.dir, templatePath) ?? stream.streamId;
			rungs.push({
				variant,
				streamId: stream.streamId,
				key: `${normalizeDir(mirror.dir)}${mirror.filename}`,
				...(mirror.outputId !== undefined
					? {
							providerResult: {
								streamId: stream.streamId,
								muxingId: mirror.muxingId,
								outputId: mirror.outputId,
								resolvedPath: normalizeDir(mirror.dir),
							},
						}
					: {}),
			});
			continue;
		}
		const allOutputs = stream.muxings.flatMap((m) => [
			...m.outputs,
			...m.drm.flatMap((d) => d.outputs),
		]);
		const anyDir =
			allOutputs.find((o) => o.outputId === target.providerOutputId)
				?.outputPath ??
			allOutputs
				.map((o) => o.outputPath)
				.find((p): p is string => p !== undefined);
		rungs.push({
			variant:
				(anyDir && perTitleVariantFromPath(anyDir, templatePath)) ??
				stream.streamId,
			streamId: stream.streamId,
			missing: true,
			reason:
				stream.muxings.length === 0
					? "the captured rung has no muxings at all"
					: `the captured rung has ${stream.muxings.length} muxing(s) and none is a QC mirror for provider output ${target.providerOutputId} under a qc/ directory`,
		});
	}
	return rungs;
}

/**
 * Every DIRECTORY the captured per-title ladder actually wrote into — the run's
 * own rung set, taken WITHOUT attribution.
 *
 * `perTitleRungsFromSnapshot` above needs `templateRendition`, so it inherits
 * `attributeResult`'s abstention: on a ladder carrying more than one template of
 * the result's codec it returns nothing at all ( — 10 of the 14
 * per-title fixtures are that shape). That abstention is right for the question
 * it answers, "which template produced this rung?", and it is the wrong gate for
 * the question a verifier asks, which is only ever "did THIS run write this
 * object?". A rung's resolved output paths sit in the snapshot whether or not
 * anything can say which template made it, so this reads them directly and never
 * consults `templateRendition`.
 *
 * Every muxing's `outputs`, plus the outputs each DRM row routes through: a
 * DRM'd per-title muxing has no destination of its own and reaches storage only
 * through its DRM rows, so reading `muxings[].outputs` alone would miss a DRM'd
 * plan's whole ladder.
 *
 * Directories, slash-terminated, de-duplicated and sorted. The snapshot does not
 * record which output KEY a path belongs to, so a caller can only use this as a
 * superset-safe ADDITION to what the plan declares — never as a replacement.
 */
export function perTitleRungDirsFromSnapshot(
	snapshot: PerTitleResultsSnapshot,
): string[] {
	const dirs = new Set<string>();
	for (const stream of snapshot.streams) {
		for (const muxing of stream.muxings) {
			for (const output of [
				...muxing.outputs,
				...muxing.drm.flatMap((d) => d.outputs),
			]) {
				const path = output.outputPath;
				if (path !== undefined && path !== "") {
					dirs.add(normalizeDir(path));
				}
			}
		}
	}
	return [...dirs].sort();
}
