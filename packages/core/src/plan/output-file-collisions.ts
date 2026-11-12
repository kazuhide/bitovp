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

/** A destination's file as the plan spells it; only a folder's closing slash is not part of it. */
const spelled = (path: string, filename: string) =>
	`${path.replace(/\/+$/, "")}/${filename}`;

/**
 * Two outputs that each write one file must not write the same file.
 *
 * Nothing else catches it: keys are unique, every reference resolves, the plan
 * compiles, and storage then keeps one output under the name both were given.
 * A plan that puts several files in one folder is a single typed name away from
 * it, and the file-export flow writes exactly such plans.
 *
 * "The same file" is decided where the bytes land: an output listed under two keys
 * is one bucket, and a delivery mirror receives every destination's files. The
 * outputs compared are the ones a muxing writes under its file name: its own
 * destination and those of its DRM configurations, against each other and against
 * every other muxing's. Manifests, sprites and thumbnails are not compared here.
 *
 * Only what is certain is refused. Two paths spelled the same are one file. Two that
 * differ only in how they spell their way there ("./out" and "out", "a//b" and
 * "a/b") are one file if the storage normalises paths and two if it does not, and
 * which it does is not measured: that is a warning. A path or a name with a
 * placeholder gets its value at the provider (per-title paths, which need one, have
 * their own rule, C4). A muxing with a conditional stream may not be written at all
 * — for one that holds other streams too, Bitmovin's `streamConditionsMode` decides,
 * and its default is unmeasured (`PLAN_MUXING_CONDITIONAL_STREAM`) — so two of those
 * can share a name on purpose: one for sources that meet a condition, one for the
 * rest.
 *
 * `level` is the level of a certain collision: an error, except on a re-run of a job
 * that was accepted before this rule existed (`demoteFileOutputRails`).
 */
export function outputFileCollisions(
	plan: Plan,
	level: "error" | "warning" = "error",
): PlanIssue[] {
	// A measurement-only job writes none of its muxings.
	if (plan.qc?.only) return [];
	const conditional = new Set(
		plan.renditions
			.filter((rendition) => rendition.conditions !== undefined)
			.map((rendition) => rendition.key),
	);
	const writers = new Map<string, { key: string; spelling: string }[]>();
	const issues: PlanIssue[] = [];
	for (const [index, muxing] of plan.muxings.entries()) {
		const filename = fileNameOf(muxing);
		if (filename === undefined || resolvedLater(filename)) continue;
		if (muxingStreamKeys(muxing).some((key) => conditional.has(key))) continue;
		// An encrypted muxing writes through its DRM configurations as well, or instead.
		const destinations = [
			...(muxing.destination ? [muxing.destination] : []),
			...(plan.drm ?? [])
				.filter((drm) => drm.muxingKey === muxing.key)
				.map((drm) => drm.destination),
		].filter((destination) => !resolvedLater(destination.path));
		const own = new Map<string, string>();
		const others = new Set<string>();
		let shared: string | undefined;
		let twice: string | undefined;
		let certain = false;
		for (const destination of destinations) {
			const spelling = spelled(destination.path, filename);
			const files = outputFileKeys(plan, { destination, filename });
			for (const file of files) {
				for (const other of writers.get(file) ?? []) {
					others.add(other.key);
					shared ??= outputFilePath(destination.path, filename);
					certain ||= other.spelling === spelling;
				}
				const earlier = own.get(file);
				if (earlier !== undefined) {
					twice ??= outputFilePath(destination.path, filename);
					certain ||= earlier === spelling;
				}
			}
			for (const file of files) own.set(file, own.get(file) ?? spelling);
		}
		if (shared !== undefined || twice !== undefined) {
			const names = [...others].map((key) => `muxing "${key}"`).join(" and ");
			const what =
				shared !== undefined
					? `writes "${shared}", the file that ${names} writes`
					: `writes "${twice}" from two of its outputs`;
			issues.push({
				code: "PLAN_OUTPUT_FILE_COLLISION",
				level: certain ? level : "warning",
				path: `muxings[${index}].filename`,
				message: certain
					? `muxing "${muxing.key}" ${what} — one would replace the other. Give each file its own name or folder.`
					: `muxing "${muxing.key}" ${what}, if the storage reads the two spellings of that path as one — one would then replace the other. Spell the path one way, or give each file its own name or folder.`,
			});
		}
		for (const [file, spelling] of own)
			writers.set(file, [
				...(writers.get(file) ?? []),
				{ key: muxing.key, spelling },
			]);
	}
	return issues;
}
