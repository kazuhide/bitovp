"use client";

import {
	createBitmovinAccountSchema,
	rateCardSchema,
	updateBitmovinAccountSchema,
} from "@bitovp/core";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { PrewarmedPoolPicker } from "@/components/prewarmed-pool-picker";
import { RegionSelect } from "@/components/region-select";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import type { BitmovinAccountDto } from "./types";

type FormValues = {
	label: string;
	apiKey: string;
	tenantOrgId: string;
	fallbackRegionsCsv: string;
	schedulingPriority: string;
	prewarmedPoolIdsCsv: string;
	rateCardJson: string;
	replaceApiKey: boolean;
};

type BitmovinFormProps = {
	account?: BitmovinAccountDto;
	submitting: boolean;
	onSubmit: (payload: unknown) => void;
};

function csvToList(csv: string): string[] {
	return csv
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

export function BitmovinForm({
	account,
	submitting,
	onSubmit,
}: BitmovinFormProps) {
	const { t } = useT();
	const isEdit = account !== undefined;
	const defaults = account?.defaults ?? {};
	const { register, handleSubmit, watch, setError, setValue, formState } =
		useForm<FormValues>({
			defaultValues: {
				label: account?.label ?? "",
				apiKey: "",
				tenantOrgId: account?.tenantOrgId ?? "",
				fallbackRegionsCsv: Array.isArray(defaults.fallbackRegions)
					? defaults.fallbackRegions.join(", ")
					: "",
				schedulingPriority:
					defaults.schedulingPriority !== undefined
						? String(defaults.schedulingPriority)
						: "",
				prewarmedPoolIdsCsv: Array.isArray(defaults.prewarmedPoolIds)
					? defaults.prewarmedPoolIds.join(", ")
					: "",
				// review-84b C1: every sibling defaults field hydrated EXCEPT
				// this one — the textarea rendered empty over a stored card,
				// so any unrelated save (rename, region change) omitted the
				// key and the wholesale defaults replace silently DESTROYED
				// the operator's contract rate card. Hydrating makes
				// "emptying the textarea deletes the card" an explicit act.
				rateCardJson: defaults.rateCard
					? JSON.stringify(defaults.rateCard, null, 2)
					: "",
				replaceApiKey: false,
			},
		});
	const replaceApiKey = watch("replaceApiKey");
	const showApiKey = !isEdit || replaceApiKey;
	const fallbackRegions = csvToList(watch("fallbackRegionsCsv"));
	const setFallbackRegions = (regions: string[]) =>
		setValue("fallbackRegionsCsv", regions.join(", "), { shouldDirty: true });

	const submit = handleSubmit((values) => {
		// The rate card is validated HERE (rateCardSchema), not by the loose
		// defaults schema — a typo must fail the save visibly, not store junk
		// that later reads as "no card". An emptied textarea deletes the card.
		let rateCard: unknown;
		if (values.rateCardJson.trim() !== "") {
			let candidate: unknown;
			try {
				candidate = JSON.parse(values.rateCardJson);
			} catch {
				setError("rateCardJson", { message: t("zerr.credValidJson") });
				return;
			}
			const parsedCard = rateCardSchema.safeParse(candidate);
			if (!parsedCard.success) {
				setError("rateCardJson", {
					message: parsedCard.error.issues
						.map(
							(issue) =>
								`${issue.path.join(".") || "rateCard"}: ${zodIssueMessage(issue, t)}`,
						)
						.join("; "),
				});
				return;
			}
			rateCard = parsedCard.data;
		}
		const accountDefaults = {
			...(defaults.encoderVersion !== undefined
				? { encoderVersion: defaults.encoderVersion }
				: {}),
			...(defaults.cloudRegion !== undefined
				? { cloudRegion: defaults.cloudRegion }
				: {}),
			fallbackRegions: csvToList(values.fallbackRegionsCsv),
			...(values.schedulingPriority !== ""
				? { schedulingPriority: Number(values.schedulingPriority) }
				: {}),
			prewarmedPoolIds: csvToList(values.prewarmedPoolIdsCsv),
			...(rateCard !== undefined ? { rateCard } : {}),
		};
		let parsed: z.ZodSafeParseResult<unknown>;
		if (isEdit) {
			parsed = updateBitmovinAccountSchema.safeParse({
				label: values.label,
				...(values.replaceApiKey ? { apiKey: values.apiKey } : {}),
				tenantOrgId: values.tenantOrgId === "" ? null : values.tenantOrgId,
				defaults: accountDefaults,
			});
		} else {
			parsed = createBitmovinAccountSchema.safeParse({
				label: values.label,
				apiKey: values.apiKey,
				...(values.tenantOrgId !== ""
					? { tenantOrgId: values.tenantOrgId }
					: {}),
				defaults: accountDefaults,
			});
		}
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				const path = issue.path.join(".");
				const field =
					path === "defaults.schedulingPriority"
						? "schedulingPriority"
						: path === "defaults.fallbackRegions"
							? "fallbackRegionsCsv"
							: (path as keyof FormValues);
				setError(field as keyof FormValues, {
					message: zodIssueMessage(issue, t),
				});
			}
			return;
		}
		onSubmit(parsed.data);
	});

	return (
		<form onSubmit={submit} noValidate>
			<fieldset disabled={submitting} className="space-y-4">
				<Field
					label={t("settingsForms.label")}
					htmlFor="bm-label"
					error={formState.errors.label?.message}
				>
					<Input
						id="bm-label"
						placeholder={t("settings.main")}
						{...register("label")}
					/>
				</Field>

				{isEdit ? (
					<label
						htmlFor="replaceApiKey"
						className="flex items-center gap-2 text-sm text-zinc-300"
					>
						<input
							id="replaceApiKey"
							type="checkbox"
							className="h-4 w-4 accent-emerald-600"
							{...register("replaceApiKey")}
						/>
						{t("settings.rotateApiKey")}
					</label>
				) : null}

				{showApiKey ? (
					<Field
						label={t("settings.apiKey")}
						htmlFor="bm-apiKey"
						error={formState.errors.apiKey?.message}
						help={t("settingsForms.writeOnlyEncryptedAtRestNeverShown")}
					>
						<Input
							id="bm-apiKey"
							type="password"
							autoComplete="off"
							{...register("apiKey")}
						/>
					</Field>
				) : null}

				<Field
					label={t("settingsForms.tenantOrgIdOptional")}
					htmlFor="bm-org"
					help={t("settingsForms.sentAsXTenantOrgIdOn")}
				>
					<Input id="bm-org" {...register("tenantOrgId")} />
				</Field>

				<Field
					label={t("settingsForms.fallbackRegionsCommaSeparated")}
					htmlFor="bm-fallback"
					error={formState.errors.fallbackRegionsCsv?.message}
				>
					<input type="hidden" {...register("fallbackRegionsCsv")} />
					<div className="space-y-2">
						{fallbackRegions.map((region, index) => (
							<div key={index} className="flex items-end gap-2">
								<div className="min-w-0 flex-1">
									<label className="sr-only" htmlFor={`bm-fallback-${index}`}>
										{t("settingsForms.fallbackRegionsCommaSeparated")}{" "}
										{index + 1}
									</label>
									<RegionSelect
										id={`bm-fallback-${index}`}
										value={region}
										onChange={(next) =>
											setFallbackRegions(
												fallbackRegions.map((item, i) =>
													i === index ? next : item,
												),
											)
										}
									/>
								</div>
								<Button
									type="button"
									variant="secondary"
									size="sm"
									aria-label={`${t("ui.remove")} ${region}`}
									onClick={() =>
										setFallbackRegions(
											fallbackRegions.filter((_, i) => i !== index),
										)
									}
								>
									{t("ui.remove")}
								</Button>
							</div>
						))}
						<RegionSelect
							id="bm-fallback"
							value=""
							emptyLabel={t("common.select")}
							onChange={(region) => {
								if (region) setFallbackRegions([...fallbackRegions, region]);
							}}
						/>
					</div>
				</Field>

				<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
					<Field
						label={t("settingsForms.schedulingPriority0100")}
						htmlFor="bm-priority"
						error={formState.errors.schedulingPriority?.message}
					>
						<Input
							id="bm-priority"
							type="number"
							min={0}
							max={100}
							{...register("schedulingPriority")}
						/>
					</Field>
				</div>

				{/* Registered for form state; the picker below is the visible control. */}
				<input type="hidden" {...register("prewarmedPoolIdsCsv")} />
				<Field
					label={t("settings.preWarmedPoolIds")}
					htmlFor="bm-pools-manual"
					help={t("settingsForms.defaultsAppliedToNewEncodingsPickFrom")}
				>
					<PrewarmedPoolPicker
						accountId={account?.id}
						csv={watch("prewarmedPoolIdsCsv")}
						inputId="bm-pools-manual"
						onChange={(csv) =>
							setValue("prewarmedPoolIdsCsv", csv, { shouldDirty: true })
						}
					/>
				</Field>

				<Field
					label={t("rateCard.label")}
					htmlFor="bm-rate-card"
					error={formState.errors.rateCardJson?.message}
					hint={t("rateCard.hint")}
				>
					<textarea
						id="bm-rate-card"
						rows={8}
						spellCheck={false}
						className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-200"
						placeholder='{ "currency": "USD", "liveRates": [ ... ] }'
						{...register("rateCardJson")}
					/>
				</Field>
				<div className="flex items-center gap-3">
					<Button
						type="button"
						variant="secondary"
						onClick={() =>
							setValue(
								"rateCardJson",
								JSON.stringify(
									{
										currency: "USD",
										liveRates: [
											{ maxHeight: 720, perHour: 3 },
											{ maxHeight: 1080, perHour: 6 },
											{ maxHeight: 2160, perHour: 12 },
										],
										notes: "EXAMPLE VALUES — replace with your contract",
									},
									null,
									2,
								),
								{ shouldDirty: true },
							)
						}
					>
						{t("rateCard.insertExample")}
					</Button>
					<span className="text-xs text-amber-400">
						{t("rateCard.exampleBanner")}
					</span>
				</div>

				<div className="flex justify-end pt-2">
					<Button type="submit" disabled={submitting}>
						{submitting
							? t("settings.saving")
							: isEdit
								? t("settings.saveChanges")
								: t("settings.addAccount")}
					</Button>
				</div>
			</fieldset>
		</form>
	);
}
