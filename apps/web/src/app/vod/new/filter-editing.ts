import {
	type WizardFilter,
	type WizardRenditionExtras,
	type WizardState,
	wizardInputStorage,
	wizardWatermarkFile,
} from "./build-plan";

/** Change a definition and its references in a single state update. */
export function editFilter(
	state: WizardState,
	index: number,
	next: WizardFilter,
	manualKey = false,
	storageSelected = false,
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
	let inputFiles = state.inputFiles;
	function uniqueFileKey(base: string) {
		let suffix = 2;
		while (inputFiles.some((file) => file.key === `${base}-${suffix}`))
			suffix++;
		return `${base}-${suffix}`;
	}
	if (
		storageSelected &&
		previous.kind === "WATERMARK" &&
		next.kind === "WATERMARK"
	) {
		const targetKey = next.inputKey;
		const site = inputFiles.find((file) => file.key === targetKey);
		if (site) {
			const prior = wizardWatermarkFile(inputFiles, previous);
			const path =
				prior?.purpose === "FILTER_IMAGE" ? prior.path : previous.imagePath;
			const location = wizardInputStorage(site);
			let image = inputFiles.find(
				(file) =>
					file.purpose === "FILTER_IMAGE" &&
					file.path === path &&
					file.inputKey === site.inputKey &&
					wizardInputStorage(file) === location,
			);
			if (!image) {
				image = {
					...site,
					key: uniqueFileKey(site.key),
					purpose: "FILTER_IMAGE",
					path,
				};
				inputFiles = [...inputFiles, image];
			}
			next = { ...next, inputKey: image.key, imagePath: path };
		}
	}
	if (
		previous.kind === "WATERMARK" &&
		next.kind === "WATERMARK" &&
		previous.inputKey === next.inputKey &&
		previous.imagePath !== next.imagePath
	) {
		const image = wizardWatermarkFile(inputFiles, previous);
		if (image?.purpose === "FILTER_IMAGE") {
			const edited = { ...image, path: next.imagePath };
			const shared = filters.some(
				(row, i) =>
					i !== index &&
					row.kind === "WATERMARK" &&
					wizardWatermarkFile(inputFiles, row)?.key === image.key,
			);
			if (shared) {
				edited.key = uniqueFileKey(image.key);
				inputFiles = [...inputFiles, edited];
			} else {
				inputFiles = inputFiles.map((file) =>
					file.key === image.key ? edited : file,
				);
			}
			next = { ...next, inputKey: edited.key };
		}
	}
	return {
		...(inputFiles !== state.inputFiles ? { inputFiles } : {}),
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
