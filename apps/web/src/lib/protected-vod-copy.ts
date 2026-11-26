import { withheldPlanSources } from "@bitovp/core";
import {
	buildPlan,
	plansDeepEqual,
	tryImportPresetIntoWizard,
	type WizardInputFile,
	type WizardState,
} from "@bitovp/core/wizard";

/** Keep the original file slots even when two entered replacements now point
 * to the same object. The normal importer determines the original keys. */
export function protectedVodCopyLayout(
	projected: unknown,
	filled: Record<string, unknown>,
	filledState: WizardState,
) {
	const sources = withheldPlanSources(projected);
	if (!sources) return null;
	const known = JSON.stringify([projected, filled]);
	let prefix = "bitovp-withheld-layout";
	while (known.includes(prefix)) prefix += "_";
	const synthetic = sources.fill(
		sources.labels.map((_, index) => `${prefix}/${index}.input`),
	);
	if (!synthetic) return null;
	const slots = sources.resolvedInputPaths(synthetic);
	const entered = sources.resolvedInputPaths(filled);
	if (slots.length !== entered.length) return null;
	const byPlaceholder = new Map<string, (typeof entered)[number]>();
	for (const [index, slot] of slots.entries()) {
		const actual = entered[index];
		if (!actual?.path.trim() || actual.inputKey !== slot.inputKey) return null;
		const prior = byPlaceholder.get(slot.path);
		if (
			prior &&
			(prior.inputKey !== actual.inputKey || prior.path !== actual.path)
		)
			return null;
		byPlaceholder.set(slot.path, actual);
	}
	const original = tryImportPresetIntoWizard(synthetic);
	if (!original.ok) return null;
	const replacements = new Map<string, WizardInputFile>();
	const inputFiles: WizardInputFile[] = [];
	for (const file of original.state.inputFiles) {
		const actual = byPlaceholder.get(file.path);
		if (!actual) {
			inputFiles.push(file);
			continue;
		}
		if (actual.inputKey !== file.inputKey || replacements.has(file.key))
			return null;
		const input = { ...file, path: actual.path };
		replacements.set(file.key, input);
		inputFiles.push(input);
	}
	const state = { ...original.state, inputFiles };
	if (state.sources?.hdr10PlusStreams) {
		const filesByKey = new Map(inputFiles.map((file) => [file.key, file]));
		const hdr10PlusStreams = [];
		for (const hdr of state.sources.hdr10PlusStreams) {
			const actual = byPlaceholder.get(hdr.metadataInputPath);
			if (
				actual &&
				filesByKey.get(hdr.videoInputFile)?.inputKey !== actual.inputKey
			)
				return null;
			hdr10PlusStreams.push(
				actual ? { ...hdr, metadataInputPath: actual.path } : hdr,
			);
		}
		state.sources = { ...state.sources, hdr10PlusStreams };
	}
	// Only a real, equivalent form may reach the wizard or its draft store.
	if (JSON.stringify(state).includes(prefix)) return null;
	try {
		if (!plansDeepEqual(buildPlan(state), buildPlan(filledState))) return null;
	} catch {
		return null;
	}
	return { state, replacements };
}
