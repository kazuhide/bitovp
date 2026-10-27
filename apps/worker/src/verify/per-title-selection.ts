import type {
	PerTitleActualPopulations,
	PerTitleActualVideoFamilies,
} from "@bitovp/core";

/** Plan-selected templates, determined before reading any manifest. */
export type PerTitleSelection = readonly {
	renditionKey: string;
	conditional?: true;
	/** Flexible templates may be pruned; fixed templates remain required. */
	optional?: true;
}[];

type CapturedResult = Extract<
	PerTitleActualPopulations,
	{ status: "complete" }
>["results"][number];
type SelectedResults =
	| { status: "complete"; results: CapturedResult[] }
	| { status: "incomplete" | "absent"; reason: string };

/** Stream identity and template attribution do not depend on captured codec metadata. */
export function scopedPerTitleResults(
	population: PerTitleActualPopulations | undefined,
	selection: PerTitleSelection | undefined,
): SelectedResults {
	const unverified = (reason: string): SelectedResults => ({
		status: "incomplete",
		reason,
	});
	if (!population)
		return unverified(
			"no attributed Per-Title RESULT population was captured for the selected templates",
		);
	if (population.status !== "complete") return population;
	if (!selection?.length)
		return unverified(
			"the selected Per-Title template identities are unavailable",
		);
	if (selection.some((template) => template.conditional))
		return unverified(
			"the selected Per-Title templates depend on unresolved runtime conditions",
		);
	if (
		population.results.some((result) => result.templateRendition === undefined)
	)
		return unverified(
			"one or more captured RESULT streams lack template attribution, so their selected encoding cannot be established",
		);
	const keys = new Set(selection.map((template) => template.renditionKey));
	const results = population.results.filter(
		(result) =>
			result.templateRendition !== undefined &&
			keys.has(result.templateRendition),
	);
	const missing = selection.filter(
		(template) =>
			!template.optional &&
			!results.some(
				(result) => result.templateRendition === template.renditionKey,
			),
	);
	if (missing.length || !results.length)
		return unverified(
			`no attributed RESULT was captured for selected template(s) ${(missing.length ? missing : selection).map((template) => template.renditionKey).join(", ")}; another encoding's results cannot certify this selection`,
		);
	if (new Set(results.map((result) => result.streamId)).size !== results.length)
		return unverified(
			"the selected RESULT population contains duplicate stream identities",
		);
	return { status: "complete", results };
}

/** Scope the third family witness by captured RESULT attribution, never codec intersection. */
export function scopedPerTitleVideoFamilies(
	population: PerTitleActualPopulations | undefined,
	selection: PerTitleSelection | undefined,
): PerTitleActualVideoFamilies {
	const selected = scopedPerTitleResults(population, selection);
	if (selected.status !== "complete") return selected;
	const { results } = selected;
	if (results.some((result) => !result.codecType))
		return {
			status: "incomplete",
			reason:
				"the selected RESULT population lacks captured provider codec types",
		};
	return {
		status: "complete",
		families: [
			...new Set(
				results.flatMap((result) =>
					result.codecType
						? [result.codecType === "H265V2" ? "H265" : result.codecType]
						: [],
				),
			),
		].sort(),
		results: results.length,
	};
}
