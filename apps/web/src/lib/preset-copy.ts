import type { SamplePresetFamily } from "@bitovp/core/presets";
import type { MessageKey } from "@/lib/i18n";

/**
 * Catalogue keys for the sample-preset gallery, keyed on the STABLE preset
 * name ('s decided design: core is UI-free and keeps ids only; the
 * 56 title/description pairs live in the catalogue, both locales).
 *
 * The casts are the ONE place the dynamic key meets the typed catalogue, and
 * they are justified by `preset-copy.test.tsx`, which walks every
 * SAMPLE_PRESETS entry and every family id and fails on a missing or empty
 * key in EITHER locale — adding a preset without its copy cannot pass the
 * suite. (`ja satisfies Messages` already forces the two locales to carry the
 * same key set, so the test's per-locale walk is belt over braces.)
 */
export const presetTitleKey = (name: string): MessageKey =>
	`presetGallery.${name}.title` as MessageKey;

export const presetDescriptionKey = (name: string): MessageKey =>
	`presetGallery.${name}.description` as MessageKey;

export const presetFamilyKey = (id: SamplePresetFamily): MessageKey =>
	`presetGallery.family.${id}` as MessageKey;
