"use client";

import {
	automaticVmafProfile,
	type VmafCloudProfile,
	vmafCloudProfileSchema,
} from "@bitovp/core";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { CloudSetupGuide, getCloudFieldHelp } from "./cloud-setup-guide";
import {
	CLOUD_NAMES,
	COMPUTE_AUTH,
	type CredentialRow,
	type ProfileRow,
	STORAGE_AUTH,
	STORAGE_NAMES,
} from "./types";

const numericFields = [
	"timeoutSeconds",
	"queueTimeoutSeconds",
	"maxCostUsdPerHour",
	"transferUsdPerGiB",
	"overheadUsd",
	"maxStagingGiB",
] as const;
const providerFields = {
	AWS_BATCH: ["jobQueue", "jobDefinition"],
	GCP_BATCH: ["project", "serviceAccount"],
	AZURE_BATCH: ["accountUrl", "poolId"],
	AKAMAI_VM: ["bootImage"],
} as const;
type TextField =
	| "id"
	| "label"
	| "region"
	| "image"
	| (typeof numericFields)[number]
	| (typeof providerFields)[keyof typeof providerFields][number]
	| "bucket"
	| "container"
	| "endpoint"
	| "storageRegion"
	| "storageAccountUrl"
	| "spotMaxRetries"
	| "spotDeadlineSeconds";

function initialValues(row?: ProfileRow): Record<string, string> {
	const initial: Record<string, string> = {
		timeoutSeconds: "14400",
		queueTimeoutSeconds: "1800",
		maxStagingGiB: "400",
		spotMaxRetries: "2",
		spotDeadlineSeconds: "21600",
	};
	if (!row) return initial;
	for (const [key, value] of Object.entries(row.config))
		if (typeof value === "string" || typeof value === "number")
			initial[key] = String(value);
	if (row.config.provider === "GCP_BATCH" && row.config.spotPolicy) {
		initial.spotMaxRetries = String(row.config.spotPolicy.maxRetries);
		initial.spotDeadlineSeconds = String(row.config.spotPolicy.deadlineSeconds);
	}
	const staging = row.config.staging;
	for (const [key, value] of Object.entries(staging))
		initial[
			key === "region"
				? "storageRegion"
				: key === "accountUrl"
					? "storageAccountUrl"
					: key
		] = String(value);
	return initial;
}

export function ProfileForm({
	row,
	credentials,
	pending,
	onSave,
}: {
	row?: ProfileRow;
	credentials: CredentialRow[];
	pending: boolean;
	onSave: (payload: {
		profile: VmafCloudProfile;
		enabled: boolean;
		expectedVersion?: number;
	}) => void;
}) {
	const { t } = useT();
	const prefix = useId();
	const [values, setValues] = useState(() => initialValues(row));
	const [provider, setProvider] = useState<VmafCloudProfile["provider"]>(
		row?.config.provider ?? "AWS_BATCH",
	);
	const [storage, setStorage] = useState<
		VmafCloudProfile["staging"]["provider"]
	>(row?.config.staging.provider ?? "S3");
	const [enabled, setEnabled] = useState(row?.enabled ?? true);
	const [spot, setSpot] = useState(
		row?.config.provider === "GCP_BATCH" ||
			row?.config.provider === "AZURE_BATCH"
			? row.config.spot
			: true,
	);
	const [spotFallback, setSpotFallback] = useState(
		!row || (row.config.provider === "GCP_BATCH" && !!row.config.spotPolicy),
	);
	const [reaper, setReaper] = useState(
		row?.config.provider === "AKAMAI_VM" && row.config.reaperEnabled,
	);
	const [error, setError] = useState(false);
	const [step, setStep] = useState<1 | 2 | 3>(row ? 2 : 1);
	const activeStep = useRef<HTMLLIElement>(null);
	const validationError = useRef<HTMLParagraphElement>(null);
	const previousStep = useRef(step);
	useEffect(() => {
		if (error) validationError.current?.focus();
		else if (previousStep.current !== step) activeStep.current?.focus();
		previousStep.current = step;
	}, [step, error]);
	const set = (key: string, value: string) =>
		setValues((v) => ({ ...v, [key]: value }));
	const field = (key: TextField, numeric = false, optional = false) => {
		const guidance = getCloudFieldHelp(provider, key);
		return (
			<Field
				key={key}
				label={t(`vmafSettings.${key}`)}
				htmlFor={`${prefix}-${key}`}
				help={guidance ? t(guidance.helpKey) : undefined}
			>
				<Input
					id={`${prefix}-${key}`}
					value={values[key] ?? ""}
					placeholder={guidance?.example}
					onChange={(e) => set(key, e.target.value)}
					type={numeric ? "number" : "text"}
					step={numeric ? "any" : undefined}
					min={numeric ? 0 : undefined}
					required={!optional}
					disabled={key === "id" && !!row}
					autoComplete="off"
				/>
			</Field>
		);
	};
	const credential = (
		key: "computeCredentialId" | "stagingCredentialId",
		cloud: CredentialRow["provider"],
	) => {
		const guidance = getCloudFieldHelp(provider, key);
		return (
			<Field
				label={t(`vmafSettings.${key}`)}
				htmlFor={`${prefix}-${key}`}
				help={guidance ? t(guidance.helpKey) : undefined}
			>
				<SelectNative
					id={`${prefix}-${key}`}
					value={values[key] ?? ""}
					onChange={(e) => set(key, e.target.value)}
				>
					<option value="">{t("vmafSettings.identity")}</option>
					{credentials
						.filter(
							(c) =>
								c.provider === cloud && (!c.disabledAt || c.id === values[key]),
						)
						.map((c) => (
							<option key={c.id} value={c.id} disabled={!!c.disabledAt}>
								{c.label}
								{c.disabledAt ? ` (${t("vmafSettings.disabled")})` : ""}
							</option>
						))}
				</SelectNative>
			</Field>
		);
	};
	return (
		<form
			className="space-y-5"
			noValidate
			onSubmit={(e) => {
				e.preventDefault();
				setError(false);
				if (step === 1) {
					setStep(2);
					return;
				}
				if (!e.currentTarget.reportValidity()) return;
				if (step === 2) {
					setStep(3);
					return;
				}
				// Schema compatibility only; automaticVmafProfile supplies the
				// shared policy and the worker sizes each task from its media.
				const raw: Record<string, unknown> = {
					provider,
					cpu: 4,
					memoryMiB: 8192,
					diskGiB: 500,
					maxParallel: 100,
					...(provider === "GCP_BATCH" ? { machineType: "e2-standard-4" } : {}),
					...(provider === "AKAMAI_VM"
						? { instanceType: "g6-dedicated-4" }
						: {}),
				};
				for (const key of [
					"id",
					"label",
					"region",
					"image",
					...providerFields[provider],
				])
					raw[key] = values[key] ?? "";
				for (const key of numericFields)
					raw[key] = values[key]?.trim() ? Number(values[key]) : undefined;
				for (const key of ["computeCredentialId", "stagingCredentialId"])
					if (values[key]) raw[key] = values[key];
				if (provider === "GCP_BATCH" || provider === "AZURE_BATCH")
					raw.spot = spot;
				if (provider === "GCP_BATCH" && spot && spotFallback)
					raw.spotPolicy = {
						maxRetries: Number(values.spotMaxRetries),
						deadlineSeconds: Number(values.spotDeadlineSeconds),
					};
				if (provider === "AKAMAI_VM") raw.reaperEnabled = reaper;
				raw.staging =
					storage === "S3"
						? {
								provider: storage,
								bucket: values.bucket,
								region: values.storageRegion,
								...(values.endpoint ? { endpoint: values.endpoint } : {}),
							}
						: storage === "GCS"
							? { provider: storage, bucket: values.bucket }
							: {
									provider: storage,
									accountUrl: values.storageAccountUrl,
									container: values.container,
								};
				const parsed = vmafCloudProfileSchema.safeParse(raw);
				if (!parsed.success) {
					setError(true);
					const hasSettingsError = parsed.error.issues.some(
						(issue) =>
							issue.path[0] !== "spotPolicy" &&
							!numericFields.some((key) => key === issue.path[0]),
					);
					setStep(hasSettingsError ? 2 : 3);
					return;
				}
				onSave({
					profile: automaticVmafProfile(parsed.data),
					enabled,
					...(row ? { expectedVersion: row.version } : {}),
				});
			}}
		>
			<fieldset disabled={pending} className="space-y-5">
				<div className="flex items-center gap-2">
					<ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
						{([1, 2, 3] as const).map((item) => (
							<li
								key={item}
								aria-current={step === item ? "step" : undefined}
								ref={step === item ? activeStep : undefined}
								tabIndex={step === item ? -1 : undefined}
								className={
									step === item ? "font-medium text-zinc-100" : undefined
								}
							>
								{t(`vmafSetup.step${item}`)}
							</li>
						))}
					</ol>
					<HelpOverlay labelFor={t("vmafSettings.title")}>
						{t("vmafSettings.autoCompute")}
					</HelpOverlay>
				</div>
				{step === 1 && (
					<section className="space-y-4">
						<Field
							label={t("vmafSettings.provider")}
							htmlFor={`${prefix}-provider`}
						>
							<SelectNative
								id={`${prefix}-provider`}
								value={provider}
								onChange={(e) => {
									const next = e.target.value as VmafCloudProfile["provider"];
									setProvider(next);
									setSpotFallback(true);
									setStorage(
										next === "GCP_BATCH"
											? "GCS"
											: next === "AZURE_BATCH"
												? "AZURE"
												: "S3",
									);
									setReaper(false);
									setValues((current) => {
										const updated = { ...current };
										for (const key of [
											...Object.values(providerFields).flat(),
											"computeCredentialId",
											"stagingCredentialId",
											"region",
											"image",
											"bucket",
											"container",
											"storageRegion",
											"storageAccountUrl",
											"endpoint",
											"maxCostUsdPerHour",
											"transferUsdPerGiB",
											"overheadUsd",
										])
											delete updated[key];
										return updated;
									});
								}}
							>
								{Object.entries(CLOUD_NAMES).map(([value, label]) => (
									<option key={value} value={value}>
										{label}
									</option>
								))}
							</SelectNative>
						</Field>
						<CloudSetupGuide provider={provider} />
					</section>
				)}
				{step === 2 && (
					<>
						<div className="grid gap-3 sm:grid-cols-2">
							{field("label")}
							{field("id")}
							{field("region")}
						</div>
						<section className="space-y-3">
							<h3 className="font-medium text-sm">
								{t("vmafSettings.platform")}
							</h3>
							{field("image")}
							<div className="grid gap-3 sm:grid-cols-2">
								{providerFields[provider].map((key) => field(key))}
								{credential("computeCredentialId", COMPUTE_AUTH[provider])}
							</div>
							{(provider === "GCP_BATCH" || provider === "AZURE_BATCH") && (
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={spot}
										onChange={(e) => setSpot(e.target.checked)}
									/>
									{t("vmafSettings.spot")}
								</label>
							)}
							{provider === "AKAMAI_VM" && (
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										required
										checked={reaper}
										onChange={(e) => setReaper(e.target.checked)}
									/>
									{t("vmafSettings.reaperEnabled")}
								</label>
							)}
						</section>
						<section className="space-y-3">
							<h3 className="font-medium text-sm">
								{t("vmafSettings.storage")}
							</h3>
							<div className="grid gap-3 sm:grid-cols-2">
								<Field
									label={t("vmafSettings.storageProvider")}
									htmlFor={`${prefix}-storage`}
								>
									<SelectNative
										id={`${prefix}-storage`}
										value={storage}
										onChange={(e) => {
											setStorage(e.target.value as typeof storage);
											set("stagingCredentialId", "");
										}}
									>
										{Object.entries(STORAGE_NAMES).map(([value, label]) => (
											<option key={value} value={value}>
												{label}
											</option>
										))}
									</SelectNative>
								</Field>
								{storage === "AZURE" ? (
									<>
										{field("storageAccountUrl")}
										{field("container")}
									</>
								) : (
									field("bucket")
								)}
								{storage === "S3" && (
									<>
										{field("storageRegion")}
										{field("endpoint", false, true)}
									</>
								)}
								{credential("stagingCredentialId", STORAGE_AUTH[storage])}
							</div>
						</section>
					</>
				)}
				{step === 3 && (
					<>
						<section>
							<h3 className="font-medium text-sm">
								{t("vmafSettings.limits")}
							</h3>
							<p className="my-3 text-xs text-zinc-400">
								{t("vmafSettings.costHelp")}
							</p>
							<div className="grid gap-3 sm:grid-cols-2">
								{numericFields.map((key) => field(key, true))}
							</div>
						</section>
						{provider === "GCP_BATCH" && spot && (
							<section className="space-y-3">
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={spotFallback}
										onChange={(e) => setSpotFallback(e.target.checked)}
									/>
									{t("vmafSettings.spotFallback")}
								</label>
								{spotFallback && (
									<>
										<div className="grid gap-3 sm:grid-cols-2">
											{field("spotMaxRetries", true)}
											{field("spotDeadlineSeconds", true)}
										</div>
										<p className="text-xs text-zinc-400">
											{t("vmafSettings.spotPolicyHelp")}
										</p>
									</>
								)}
							</section>
						)}
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={enabled}
								onChange={(e) => setEnabled(e.target.checked)}
							/>
							{t("vmafSettings.enabled")}
						</label>
						<p className="text-xs text-zinc-400">{t("vmafSetup.saveHint")}</p>
					</>
				)}
				{error && (
					<p
						ref={validationError}
						tabIndex={-1}
						role="alert"
						className="text-red-400 text-sm"
					>
						{t("vmafSettings.invalid")}
					</p>
				)}
				<div className="flex gap-2">
					{step > 1 && (
						<Button
							type="button"
							variant="secondary"
							onClick={() => {
								setError(false);
								setStep(step === 3 ? 2 : 1);
							}}
						>
							{t("vmafSetup.back")}
						</Button>
					)}
					<Button type="submit" disabled={pending}>
						{step === 3 ? t("vmafSettings.save") : t("vmafSetup.next")}
					</Button>
				</div>
			</fieldset>
		</form>
	);
}
