import { muxingStreamKeys } from "./muxing-streams";
import { outputFileKeys, outputFilePath } from "./output-files";
import type { EncodingPlan, PlanMuxing } from "./schema";
import type { PlanIssue } from "./validate";

type Plan = Pick<EncodingPlan, "muxings" | "outputs" | "renditions"> &
	Partial<Pick<EncodingPlan, "drm" | "deliveryMirrors">> & {
		qc?: { only?: boolean };
	};

/**
 * The name of the one file a muxing writes, for the kinds that write one.
 * Segmented kinds write many files, which the provider names.
 */
function fileNameOf(muxing: PlanMuxing): string | undefined {
	if (muxing.kind === "WEBM")
		return muxing.progressive ? (muxing.filename ?? "output.webm") : undefined;
	return "filename" in muxing ? muxing.filename : undefined;
}

/** `{uuid}`, `{bitrate}` and `%number%` become a value per output at the provider. */
const resolvedLater = (text: string) => /[%{}]/.test(text);

/**
 * Two muxings that each write one file must not write the same file.
 *
 * Nothing else catches it: keys are unique, every reference resolves, the plan
 * compiles, and storage then keeps one output under the name both were given.
 * A plan that puts several files in one folder is a single typed name away from
 * it, and the file-export flow writes exactly such plans.
 *
 * "The same file" is decided where the bytes land: an output listed under two keys
 * is one bucket, and a delivery mirror receives every destination's files.
 *
 * Only what is certain here is reported. A path or a name with a placeholder gets
 * its value at the provider (per-title paths, which need one, have their own rule,
 * C4). A muxing with a conditional stream may not be written at all — for one that
 * holds other streams too, Bitmovin's `streamConditionsMode` decides, and its
 * default is unmeasured (`PLAN_MUXING_CONDITIONAL_STREAM`) — so two of those can
 * share a name on purpose: one for sources that meet a condition, one for the rest.
 */
export function outputFileCollisions(plan: Plan): PlanIssue[] {
	// A measurement-only job writes none of its muxings.
	if (plan.qc?.only) return [];
	const conditional = new Set(
		plan.renditions
			.filter((rendition) => rendition.conditions !== undefined)
			.map((rendition) => rendition.key),
	);
	const writers = new Map<string, string[]>();
	const issues: PlanIssue[] = [];
	for (const [index, muxing] of plan.muxings.entries()) {
		const filename = fileNameOf(muxing);
		if (filename === undefined || resolvedLater(filename)) continue;
		if (muxingStreamKeys(muxing).some((key) => conditional.has(key))) continue;
		// An encrypted muxing writes through its DRM configurations instead.
		const destinations = [
			...(muxing.destination ? [muxing.destination] : []),
			...(plan.drm ?? [])
				.filter((drm) => drm.muxingKey === muxing.key)
				.map((drm) => drm.destination),
		].filter((destination) => !resolvedLater(destination.path));
		const files = new Set<string>();
		const others = new Set<string>();
		let shared: string | undefined;
		for (const destination of destinations) {
			for (const file of outputFileKeys(plan, { destination, filename })) {
				files.add(file);
				for (const other of writers.get(file) ?? []) {
					others.add(other);
					shared ??= outputFilePath(destination.path, filename);
				}
			}
		}
		if (shared !== undefined)
			issues.push({
				code: "PLAN_OUTPUT_FILE_COLLISION",
				level: "error",
				path: `muxings[${index}].filename`,
				message: `muxing "${muxing.key}" writes "${shared}", the file that ${[
					...others,
				]
					.map((key) => `muxing "${key}"`)
					.join(
						" and ",
					)} writes — one would replace the other. Give each file its own name or folder.`,
			});
		for (const file of files)
			writers.set(file, [...(writers.get(file) ?? []), muxing.key]);
	}
	return issues;
}
