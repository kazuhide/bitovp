import { z } from "zod";

const collections = [
	"ingest",
	"fileStreams",
	"dolbyStreams",
	"hdr10PlusStreams",
] as const;
const fields = ["inputPath", "videoInputPath", "metadataInputPath"] as const;
const siteSchema = z.strictObject({
	collection: z.enum(collections),
	index: z.number().int().nonnegative(),
	field: z.enum(fields),
});
type Site = z.infer<typeof siteSchema>;
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stream(plan: Record<string, unknown>, site: Site) {
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
	for (const collection of collections) {
		const rows = original[collection];
		if (!Array.isArray(rows)) continue;
		for (const [index, row] of rows.entries()) {
			if (!record(row) || typeof row.inputKey !== "string") continue;
			for (const field of fields) {
				const path = row[field],
					site = { collection, index, field };
				if (
					typeof path !== "string" ||
					!path ||
					stream(projected, site)?.[field] !== ""
				)
					continue;
				const identity = JSON.stringify([row.inputKey, path]);
				const sites = groups.get(identity) ?? [];
				sites.push(site);
				groups.set(identity, sites);
			}
		}
	}
	return groups.size
		? { ...projected, withheldSourcePaths: [...groups.values()] }
		: projected;
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
				typeof row.key !== "string" ||
				seen.has(id)
			)
				return null;
			seen.add(id);
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
	return { labels, fill };
}
