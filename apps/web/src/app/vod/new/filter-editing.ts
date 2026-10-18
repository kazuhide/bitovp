import type {
	WizardFilter,
	WizardRenditionExtras,
	WizardState,
} from "./build-plan";

/** Change a definition and its references in a single state update. */
export function editFilter(
	state: WizardState,
	index: number,
	next: WizardFilter,
	manualKey = false,
): Partial<WizardState> {
	const filters = state.filters ?? [];
	const previous = filters[index];
	if (!previous) return {};
	const previousKind = previous.kind ?? "DEINTERLACE";
	const nextKind = next.kind ?? "DEINTERLACE";
	const oldKey = previous.key;
	const manual = new Set(state.manualFilterKeys ?? []);
	const base = previousKind.toLowerCase();
	const defaultName =
		new RegExp(`^${base}(?:-?[1-9]\\d*)?$`).test(oldKey) ||
		(previousKind === "DEINTERLACE" && /^(?:deint|din-)[1-9]\d*$/.test(oldKey));
	const uniqueOldKey = filters.filter((row) => row.key === oldKey).length === 1;
	if (
		!manualKey &&
		previousKind !== nextKind &&
		defaultName &&
		!manual.has(oldKey) &&
		uniqueOldKey
	) {
		const prefix = nextKind.toLowerCase();
		const used = new Set(
			filters.filter((_, i) => i !== index).map((row) => row.key),
		);
		let key = prefix;
		let suffix = 2;
		while (used.has(key)) key = `${prefix}${suffix++}`;
		next = { ...next, key };
	}
	const key = next.key;
	const canRename =
		oldKey !== "" &&
		key !== "" &&
		oldKey !== key &&
		uniqueOldKey &&
		!filters.some((row) => row.key === key);
	if (manualKey) {
		if (uniqueOldKey) manual.delete(oldKey);
		manual.add(key);
	}
	const map = <T extends { extras?: WizardRenditionExtras }>(row: T): T =>
		row.extras
			? {
					...row,
					extras: {
						...row.extras,
						filters: row.extras.filters?.map((ref) =>
							ref.filterKey === oldKey ? { ...ref, filterKey: key } : ref,
						),
					},
				}
			: row;
	return {
		filters: filters.map((row, i) => (i === index ? next : row)),
		...(manualKey ? { manualFilterKeys: [...manual] } : {}),
		...(canRename
			? {
					videos: state.videos.map(map),
					audios: state.audios.map(map),
					subtitles: state.subtitles?.map(map),
				}
			: {}),
	};
}
