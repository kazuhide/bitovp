"use client";

import { Field } from "@/components/ui/field";
import { SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type { WizardH265Options } from "./build-plan";
import { type OptionFieldSpec, OptionsGrid } from "./wizard-fields";

const QUALITY_FIELDS: OptionFieldSpec[] = [
	{
		key: "motionCompensatedTemporalFiltering",
		labelKey: "hevcV2.mctf",
		hintKey: "hevcV2.mctfHelp",
		control: { options: ["AUTO", "OFF", "ON"] },
	},
];
const PERCEPTUAL_FIELDS: OptionFieldSpec[] = [
	{
		key: "perceptualEncodingMode",
		labelKey: "hevcV2.perceptualEncodingMode",
		control: { options: ["OFF", "CU_DELTA_QP"] },
	},
	{
		key: "perceptualStrength",
		labelKey: "hevcV2.perceptualStrength",
		control: "num",
		hintKey: "hevcV2.unitRange",
	},
	{
		key: "perceptualPenaltyStrength",
		labelKey: "hevcV2.perceptualPenaltyStrength",
		control: "num",
		hintKey: "hevcV2.unitRange",
	},
	{
		key: "perceptualPenaltyKnee",
		labelKey: "hevcV2.perceptualPenaltyKnee",
		control: "num",
		hintKey: "hevcV2.unitRange",
	},
	{
		key: "perceptualTemporalStrength",
		labelKey: "hevcV2.perceptualTemporalStrength",
		control: "num",
		hintKey: "hevcV2.unitRange",
	},
	{
		key: "pixelPerDegree",
		labelKey: "hevcV2.pixelPerDegree",
		control: "num",
		hintKey: "hevcV2.positiveRange",
	},
];

/** Optional native codec controls, separate from Per-Title analysis TargetQualityQP. */
export function HevcV2QualityEditor({
	idBase,
	value,
	onChange,
}: {
	idBase: string;
	value: WizardH265Options;
	onChange: (value: WizardH265Options) => void;
}) {
	const { t } = useT();
	const config = value.rateControlModeConfig;
	return (
		<div className="space-y-3">
			<OptionsGrid
				idBase={idBase}
				value={value}
				fields={QUALITY_FIELDS}
				onChange={onChange}
			/>
			<Field
				label={t("hevcV2.perceptualConfig")}
				htmlFor={`${idBase}-perceptual`}
				help={t("hevcV2.perceptualHelp")}
			>
				<SelectNative
					id={`${idBase}-perceptual`}
					value={config ? "PERCEPTUAL_QUALITY_MODE" : ""}
					onChange={(event) =>
						onChange({
							...value,
							rateControlModeConfig: event.target.value
								? { type: "PERCEPTUAL_QUALITY_MODE" }
								: undefined,
						})
					}
				>
					<option value="">{t("wizard.default")}</option>
					<option value="PERCEPTUAL_QUALITY_MODE">
						PERCEPTUAL_QUALITY_MODE
					</option>
				</SelectNative>
			</Field>
			{config ? (
				<OptionsGrid
					idBase={`${idBase}-perceptual`}
					value={config}
					fields={PERCEPTUAL_FIELDS}
					onChange={(rateControlModeConfig) =>
						onChange({ ...value, rateControlModeConfig })
					}
				/>
			) : null}
		</div>
	);
}
