import { z } from "zod";

const collections = [
	"ingest",
	"fileStreams",
	"captionStreams",
	"dolbyStreams",
	"hdr10PlusStreams",
] as const;
const fields = ["inputPath", "videoInputPath", "metadataInputPath"] as const;
const siteSchema = z.union([
	z.strictObject({
		collection: z.enum(collections),
		index: z.number().int().nonnegative(),
		field: z.enum(fields),
	}),
	z.strictObject({
		collection: z.literal("renditionBurnInSrt"),
		renditionKey: z.string().min(1),
		field: z.literal("inputPath"),
	}),
]);
type Site = z.infer<typeof siteSchema>;
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stream(plan: Record<string, unknown>, site: Site) {
	if (site.collection === "renditionBurnInSrt") {
		if (!Array.isArray(plan.renditions)) return undefined;
		const matches = plan.renditions.filter(
			(row: unknown) => record(row) && row.key === site.renditionKey,
		);
		const subtitle: unknown =
			matches.length === 1 ? matches[0]?.burnInSrt : undefined;
		return record(subtitle) ? subtitle : undefined;
	}
	const rows = plan[site.collection];
	const row: unknown = Array.isArray(rows) ? rows[site.index] : undefined;
	return record(row) ? row : undefined;
}

/** Mark only paths actually withheld during this server read. The wire carries
 * positions and equality groups, never the original value or a token derived from it. */
export function markWithheldPlanSources(
	original: unknown,
	projected: unknown,
): unknown {
	if (!record(original) || !record(projected)) return projected;
	const groups = new Map<string, Site[]>();
	let result = projected;
	function add(
		site: Site,
		row: Record<string, unknown>,
		pairedReplacement = false,
	) {
		const path = row[site.field];
		if (
			typeof row.inputKey !== "string" ||
			typeof path !== "string" ||
			!path ||
			(!pairedReplacement && stream(projectedPlan, site)?.[site.field] !== "")
		)
			return;
		if (pairedReplacement) {
			// The retained sidecar describes the withheld picture. Replacing
			// the picture requires an explicit choice of matching metadata.
			if (result === projectedPlan) result = structuredClone(projectedPlan);
			const copied = stream(result, site);
			if (copied) copied[site.field] = "";
		}
		const id = JSON.stringify(pairedReplacement ? site : [row.inputKey, path]);
		const sites = groups.get(id) ?? [];
		sites.push(site);
		groups.set(id, sites);
	}
	const projectedPlan = projected;
	for (const collection of collections) {
		const rows = original[collection];
		if (!Array.isArray(rows)) continue;
		for (const [index, row] of rows.entries()) {
			if (!record(row) || typeof row.inputKey !== "string") continue;
			const pictureWithheld =
				collection === "hdr10PlusStreams" &&
				typeof row.videoInputPath === "string" &&
				!!row.videoInputPath &&
				stream(projected, { collection, index, field: "videoInputPath" })
					?.videoInputPath === "";
			for (const field of fields)
				add(
					{ collection, index, field },
					row,
					pictureWithheld && field === "metadataInputPath",
				);
		}
	}
	if (Array.isArray(original.renditions))
		for (const rendition of original.renditions) {
			if (
				!record(rendition) ||
				typeof rendition.key !== "string" ||
				!record(rendition.burnInSrt)
			)
				continue;
			add(
				{
					collection: "renditionBurnInSrt",
					renditionKey: rendition.key,
					field: "inputPath",
				},
				rendition.burnInSrt,
			);
		}
	return groups.size
		? { ...result, withheldSourcePaths: [...groups.values()] }
		: result;
}

/** A public read model is not an executable plan. Resolve all withheld source
 * groups before instantiation or copying, and keep the submission schema strict. */
export function withheldPlanSources(value: unknown) {
	if (!record(value) || !("withheldSourcePaths" in value)) return null;
	const parsed = z
		.array(z.array(siteSchema).min(1))
		.min(1)
		.safeParse(value.withheldSourcePaths);
	if (!parsed.success) return null;
	const { withheldSourcePaths: _metadata, ...plan } = value;
	const groups = parsed.data;
	const labels: string[] = [];
	const seen = new Set<string>();
	for (const group of groups) {
		const names = [];
		for (const site of group) {
			const row = stream(plan, site),
				id = JSON.stringify(site);
			if (
				row?.[site.field] !== "" ||
				typeof row.inputKey !== "string" ||
				seen.has(id)
			)
				return null;
			seen.add(id);
			if (site.collection === "renditionBurnInSrt") {
				names.push(`${site.renditionKey}:burnInSrt`);
				continue;
			}
			if (typeof row.key !== "string") return null;
			names.push(
				site.field === "metadataInputPath" ? `${row.key}:metadata` : row.key,
			);
		}
		labels.push(names.join(" / "));
	}
	function fill(paths: readonly string[]) {
		if (paths.length !== labels.length || paths.some((path) => !path.trim()))
			return null;
		const copy = structuredClone(plan);
		for (const [index, group] of groups.entries()) {
			for (const site of group) {
				const row = stream(copy, site);
				if (row) row[site.field] = paths[index];
			}
		}
		return copy;
	}
	function resolvedInputPaths(value: Record<string, unknown>) {
		return groups.flatMap((group) =>
			group.flatMap((site) => {
				const row = stream(value, site);
				const path = row?.[site.field];
				return typeof row?.inputKey === "string" && typeof path === "string"
					? [{ inputKey: row.inputKey, path }]
					: [];
			}),
		);
	}
	return { labels, fill, resolvedInputPaths };
}
