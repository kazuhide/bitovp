"use client";

import {
	type ExperimentNvencSdkBinding,
	type ExperimentNvencSdkSettings,
	experimentFrameCount,
	experimentNvencSdkSettingsSchema,
	experimentNvencSdkVersion,
	experimentTrialSchema,
	isExperimentNvencSdkFieldValue,
} from "@bitovp/core/encoding-experiments";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";

export function SdkSettings({
	draft,
	catalogSha256,
	disabled,
	onChange,
}: {
	draft: Record<string, unknown>;
	catalogSha256: string;
	disabled: boolean;
	onChange: (draft: Record<string, unknown>) => void;
}) {
	const { t } = useT();
	const filterInput = useId();
	const fieldInput = useId();
	const valueInput = useId();
	const frameInput = useId();
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const [field, setField] = useState("");
	const [rawValue, setRawValue] = useState("");
	const [frame, setFrame] = useState("0");
	const [invalid, setInvalid] = useState(false);
	const catalog = useQuery({
		queryKey: ["encoding-experiments", "catalog", catalogSha256],
		queryFn: () =>
			apiFetch<{ sdkBindings: ExperimentNvencSdkBinding[] }>(
				"/api/encoding-experiments/v1/catalog",
			),
		enabled: open,
	});

	const { sdk: rawSdk, ...base } = draft;
	const trial = open ? experimentTrialSchema.safeParse(base).data : undefined;
	const sdk: ExperimentNvencSdkSettings | undefined = open
		? rawSdk === undefined
			? { version: experimentNvencSdkVersion }
			: experimentNvencSdkSettingsSchema.safeParse(rawSdk).data
		: undefined;
	const bindings =
		trial &&
		catalog.data?.sdkBindings?.filter(
			(binding) =>
				binding.phase !== "reconfigure" &&
				binding.codecs.includes(trial.codec) &&
				binding.field.toLowerCase().includes(filter.trim().toLowerCase()),
		);
	const binding = bindings?.find((candidate) => candidate.field === field);
	const frameIndex = Number(frame);
	const frameCount = trial ? experimentFrameCount(trial.window) : 0;
	const value =
		binding?.type === "boolean" ? rawValue === "true" : Number(rawValue);

	function applySetting() {
		if (!sdk || !binding) return;
		const pictures = sdk.pictures ?? [];
		const picture = pictures.find((item) => item.frameIndex === frameIndex);
		const next = {
			...draft,
			sdk:
				binding.phase === "session"
					? { ...sdk, session: { ...sdk.session, [binding.field]: value } }
					: {
							...sdk,
							pictures: [
								...pictures.filter((item) => item.frameIndex !== frameIndex),
								{
									...picture,
									frameIndex,
									fields: { ...picture?.fields, [binding.field]: value },
								},
							],
						},
		};
		const parsed = experimentNvencSdkSettingsSchema.safeParse(next.sdk);
		setInvalid(!parsed.success);
		if (parsed.success) onChange({ ...draft, sdk: parsed.data });
	}

	return (
		<details
			className="rounded-md border border-zinc-800 px-3 py-2"
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary className="cursor-pointer text-sm font-medium">
				{t("experiments.sdkSettings")}
			</summary>
			{open && (
				<div className="mt-3 space-y-2">
					{(!trial || !sdk || catalog.isPending || catalog.isError) && (
						<p role="status" className="text-xs text-zinc-400">
							{!trial || !sdk
								? t("experiments.invalidJson")
								: catalog.isPending
									? t("common.loading")
									: t("experiments.sdkCatalogUnavailable")}
						</p>
					)}
					{bindings && trial && sdk && (
						<>
							<Field label={t("experiments.sdkFilter")} htmlFor={filterInput}>
								<Input
									id={filterInput}
									type="search"
									value={filter}
									onChange={(event) => {
										setFilter(event.target.value);
										setField("");
										setRawValue("");
									}}
								/>
							</Field>
							<Field label={t("experiments.sdkField")} htmlFor={fieldInput}>
								<SelectNative
									id={fieldInput}
									value={field}
									onChange={(event) => {
										setField(event.target.value);
										setRawValue("");
										setInvalid(false);
									}}
								>
									<option value="">{t("experiments.sdkSelectField")}</option>
									{(["session", "picture"] as const).map((phase) => (
										<optgroup
											key={phase}
											label={t(
												phase === "session"
													? "experiments.sdkSession"
													: "experiments.sdkPicture",
											)}
										>
											{bindings
												.filter((item) => item.phase === phase)
												.map((item) => (
													<option key={item.field} value={item.field}>
														{item.field}
													</option>
												))}
										</optgroup>
									))}
								</SelectNative>
							</Field>
							{binding && (
								<>
									{binding.phase === "picture" && (
										<Field
											label={t("experiments.sdkFrame")}
											htmlFor={frameInput}
										>
											<Input
												id={frameInput}
												type="number"
												min={0}
												max={frameCount - 1}
												step={1}
												value={frame}
												onChange={(event) => setFrame(event.target.value)}
											/>
										</Field>
									)}
									<Field label={t("experiments.sdkValue")} htmlFor={valueInput}>
										{binding.type === "boolean" || binding.values ? (
											<SelectNative
												id={valueInput}
												value={rawValue}
												onChange={(event) => setRawValue(event.target.value)}
											>
												<option value="">
													{t("experiments.sdkSelectValue")}
												</option>
												{binding.type === "boolean"
													? [true, false].map((choice) => (
															<option
																key={String(choice)}
																value={String(choice)}
															>
																{String(choice)}
															</option>
														))
													: binding.values
															?.filter((choice) =>
																isExperimentNvencSdkFieldValue(
																	binding,
																	choice,
																	trial.codec,
																),
															)
															.map((choice) => (
																<option key={choice} value={choice}>
																	{binding.choices?.find(
																		(item) => item.value === choice,
																	)?.name ?? choice}
																</option>
															))}
											</SelectNative>
										) : (
											<Input
												id={valueInput}
												type="number"
												min={binding.minimum}
												max={binding.maximum}
												step={1}
												value={rawValue}
												onChange={(event) => setRawValue(event.target.value)}
											/>
										)}
									</Field>
									<Button
										variant="secondary"
										size="sm"
										onClick={applySetting}
										disabled={
											disabled ||
											rawValue === "" ||
											!isExperimentNvencSdkFieldValue(
												binding,
												value,
												trial.codec,
											) ||
											(binding.phase === "picture" &&
												(frame === "" ||
													!Number.isInteger(frameIndex) ||
													frameIndex < 0 ||
													frameIndex >= frameCount))
										}
									>
										{t("experiments.sdkApply")}
									</Button>
									{invalid && (
										<p role="alert" className="text-xs text-red-400">
											{t("experiments.invalidJson")}
										</p>
									)}
								</>
							)}
						</>
					)}
				</div>
			)}
		</details>
	);
}
