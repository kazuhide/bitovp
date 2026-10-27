import { defaultHlsSelectedMuxings } from "./default-manifest-selection";
import { outputFilePath, outputStorageKeys } from "./output-files";
import type { EncodingPlan } from "./schema";

type Destination = { outputKey: string; path: string };
type Source = Pick<
	EncodingPlan,
	"encodings" | "renditions" | "muxings" | "drm" | "outputs" | "deliveryMirrors"
>;

/** Compare directory segments, so a sibling such as base2 never belongs to base. */
function hierarchy(
	parent: string,
	path: string,
): "within" | "outside" | "unknown" {
	const root = outputFilePath(parent, "").split("/").filter(Boolean);
	const child = outputFilePath(path, "").split("/").filter(Boolean);
	for (const [index, part] of root.entries()) {
		const next = child[index];
		if (next === undefined) return "outside";
		if (/\{[^}]+\}|%[^%]+%/.test(part) || /\{[^}]+\}|%[^%]+%/.test(next))
			return "unknown";
		if (part !== next) return "outside";
	}
	return "within";
}

/** Default HLS writes relative media references beneath its own output directory. */
function defaultHlsOutputDestinations(plan: Source, manifest: Destination) {
	const targets = outputStorageKeys(plan, manifest.outputKey);
	const logical = new Set([
		manifest.outputKey,
		...(plan.deliveryMirrors ?? []).map((row) => row.outputKey),
	]);
	return defaultHlsSelectedMuxings(plan)
		.flatMap((muxing) => [
			...(muxing.destination
				? [{ owner: `muxing "${muxing.key}"`, destination: muxing.destination }]
				: []),
			...(plan.drm ?? [])
				.filter((drm) => drm.muxingKey === muxing.key)
				.map((drm) => ({
					owner: `DRM "${drm.key}"`,
					destination: drm.destination,
				})),
		])
		.filter(({ destination }) =>
			[...outputStorageKeys(plan, destination.outputKey)].some((target) =>
				targets.has(target),
			),
		)
		.map((row) => ({
			...row,
			sameOutputResource: [
				row.destination.outputKey,
				...(plan.deliveryMirrors ?? []).map((mirror) => mirror.outputKey),
			].some((key) => logical.has(key)),
		}));
}

export function defaultHlsPathConflicts(plan: Source, manifest: Destination) {
	return defaultHlsOutputDestinations(plan, manifest).flatMap((row) => {
		const relation = hierarchy(manifest.path, row.destination.path);
		if (relation === "within") return [];
		return [
			{
				...row,
				level:
					relation === "outside" && row.sameOutputResource
						? ("error" as const)
						: ("warning" as const),
			},
		];
	});
}
