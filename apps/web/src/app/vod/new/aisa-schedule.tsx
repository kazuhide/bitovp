"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type { WizardStartOptions } from "./build-plan";
import { RowRemoveButton } from "./wizard-fields";

type Schedule = NonNullable<WizardStartOptions["aiSceneAnalysis"]>["schedule"];
const fields = [
	["position", "wizard.aisaPosition"],
	["maxDeviation", "wizard.aisaMaxDeviation"],
	["duration", "wizard.aisaDuration"],
] as const;
const blankCue = () => ({ position: Number.NaN, maxDeviation: Number.NaN });

export function AisaScheduleEditor({
	value,
	onChange,
}: {
	value: Schedule;
	onChange: (value: Schedule) => void;
}) {
	const { t } = useT();
	const id = useId();
	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<label
					htmlFor={`${id}-enable`}
					className="flex items-center gap-2 text-xs text-zinc-300"
				>
					<input
						id={`${id}-enable`}
						type="checkbox"
						className="h-3.5 w-3.5 accent-emerald-600"
						checked={value !== undefined}
						onChange={(e) =>
							onChange(e.target.checked ? [blankCue()] : undefined)
						}
					/>
					{t("wizard.aisaSchedule")}
				</label>
				<HelpOverlay labelFor={t("wizard.aisaSchedule")}>
					{t("wizard.aisaScheduleHelp")}
				</HelpOverlay>
			</div>
			{value !== undefined ? (
				<div className="space-y-3">
					{value.map((cue, index) => (
						// Rows have no independent local state; index tracks their editable order.
						<div
							key={index}
							className="grid grid-cols-1 items-start gap-2 sm:grid-cols-3"
						>
							{fields.map(([key, labelKey]) => {
								const raw = cue[key];
								const optional = key === "duration";
								const invalid =
									!(optional && raw === undefined) &&
									(raw === undefined || !Number.isFinite(raw) || raw < 0);
								return (
									<Field
										key={key}
										htmlFor={`${id}-${index}-${key}`}
										label={`${t(labelKey)} ${index + 1}`}
										error={
											invalid ? t("wizard.aisaNonnegativeNumber") : undefined
										}
									>
										<Input
											id={`${id}-${index}-${key}`}
											type="number"
											min={0}
											step="any"
											required={!optional}
											aria-invalid={invalid}
											value={
												raw !== undefined && Number.isFinite(raw) ? raw : ""
											}
											onChange={(e) =>
												onChange(
													value.map((entry, i) =>
														i === index
															? {
																	...entry,
																	[key]: e.target.validity.badInput
																		? Number.NaN
																		: e.target.value === ""
																			? optional
																				? undefined
																				: Number.NaN
																			: Number(e.target.value),
																}
															: entry,
													),
												)
											}
										/>
									</Field>
								);
							})}
							<div className="sm:col-span-3">
								<RowRemoveButton
									label={`${t("wizard.aisaRemoveCue")} ${index + 1}`}
									onClick={() => onChange(value.filter((_, i) => i !== index))}
								/>
							</div>
						</div>
					))}
					{value.length === 0 ? (
						<p className="text-xs text-red-400" role="alert">
							{t("wizard.aisaNeedsCue")}
						</p>
					) : null}
					<Button
						type="button"
						variant="secondary"
						size="sm"
						onClick={() => onChange([...value, blankCue()])}
					>
						{t("wizard.aisaAddCue")}
					</Button>
				</div>
			) : null}
		</div>
	);
}
