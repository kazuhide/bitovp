"use client";
import { Field } from "@/components/ui/field";
import { SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import {
	SRT_CHARACTER_ENCODING_VALUES,
	SRT_CHARACTER_ENCODINGS,
	type WizardRenditionExtras,
} from "./build-plan";
import { Collapsible } from "./wizard-fields";

type BurnIn = NonNullable<WizardRenditionExtras["burnInSrt"]>;
export function BurnInSrtEditor({
	idBase,
	value,
	inputFiles,
	onChange,
}: {
	idBase: string;
	value: BurnIn | undefined;
	inputFiles: { key: string; label: string }[];
	onChange: (value: BurnIn | undefined) => void;
}) {
	const { t } = useT();
	const selected = inputFiles.find((f) => f.key === value?.inputFile);
	return (
		<Collapsible
			summary={`${t("wizard.burnInSrt")}${value ? ` · ${selected?.label ?? value.inputFile}` : ""}`}
		>
			<Field
				label={t("wizard.inputFile")}
				htmlFor={`${idBase}-burn-srt`}
				help={t("wizard.burnInSrtHelp")}
			>
				<SelectNative
					id={`${idBase}-burn-srt`}
					value={value?.inputFile ?? ""}
					onChange={(e) =>
						onChange(
							e.target.value
								? {
										inputFile: e.target.value,
										characterEncoding: value?.characterEncoding ?? "UTF_8",
									}
								: undefined,
						)
					}
				>
					<option value="">{t("wizard.burnInSrtNone")}</option>
					{value && !selected ? (
						<option value={value.inputFile}>
							{value.inputFile} {t("wizardX.missingParen")}
						</option>
					) : null}
					{inputFiles.map((file) => (
						<option key={file.key} value={file.key}>
							{file.label}
						</option>
					))}
				</SelectNative>
			</Field>
			{value ? (
				<Field
					label={t("wizard.subtitleEncoding")}
					htmlFor={`${idBase}-burn-encoding`}
				>
					<SelectNative
						id={`${idBase}-burn-encoding`}
						value={value.characterEncoding}
						onChange={(e) =>
							onChange({
								...value,
								characterEncoding: e.target
									.value as BurnIn["characterEncoding"],
							})
						}
					>
						{SRT_CHARACTER_ENCODINGS.map((encoding) => (
							<option key={encoding} value={encoding}>
								{SRT_CHARACTER_ENCODING_VALUES[encoding]}
							</option>
						))}
					</SelectNative>
				</Field>
			) : null}
		</Collapsible>
	);
}
