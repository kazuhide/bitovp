import type { OptionFieldSpec } from "./wizard-fields";

export const CMAF_CHUNK_FIELDS: OptionFieldSpec[] = [
	{
		key: "initSegmentNameTemplate",
		labelKey: "wizard.initSegmentNameTemplate",
		control: "text",
	},
	{
		key: "framesPerCmafChunk",
		labelKey: "wizard.framesPerCmafChunk",
		control: "num",
	},
];
