"use client";

import {
	CREDENTIAL_GROUPS,
	CREDENTIAL_PROVIDER_GROUP,
	CREDENTIAL_PROVIDER_LABELS,
	CREDENTIAL_PROVIDERS,
	type CredentialProviderId,
	createCredentialSchema,
	formatPublicBaseUrls,
	ociCompatHost,
	parsePublicBaseUrls,
	readPublicBaseUrls,
	updateCredentialSchema,
} from "@bitovp/core";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative, Textarea } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import { GROUP_HEADING } from "./groups";
import { MslEdgeCandidate } from "./msl-edge-candidate";
import { type FieldDef, PROVIDER_FIELDS } from "./provider-fields";
import type { CredentialDto } from "./types";

type FormValues = {
	provider: CredentialProviderId;
	label: string;
	config: Record<string, unknown>;
	secret: Record<string, string>;
	replaceSecret: boolean;
};

type CredentialFormProps = {
	credential?: CredentialDto;
	submitting: boolean;
	onSubmit: (payload: unknown) => void;
};

function defaultsFor(provider: CredentialProviderId, label = ""): FormValues {
	return {
		provider,
		label,
		config:
			provider === "GENERIC_S3" ? { ssl: true, signatureVersion: "S3_V4" } : {},
		secret: {},
		replaceSecret: false,
	};
}

/**
 * A `urlmap` field is edited as text and stored as an object, so the form's
 * value for it is the text — `readPublicBaseUrls` first, because a row edited
 * straight in Postgres can hold anything.
 */
function toFormConfig(
	fields: FieldDef[],
	config: Record<string, unknown>,
): Record<string, unknown> {
	const out = { ...config };
	for (const def of fields) {
		if (def.type === "urlmap") {
			out[def.name] = formatPublicBaseUrls(readPublicBaseUrls(config));
		}
	}
	return out;
}

/**
 * Optional fields are dropped when blank so zod's `.optional` applies;
 * required fields keep "" so the friendly min(1) messages fire instead of
 * "expected string, received undefined".
 */
function normalize(
	fields: FieldDef[],
	raw: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const def of fields) {
		if (def.type === "urlmap") {
			// Parsed in `submit`, which can report a parse error on the field.
			continue;
		}
		const value = raw[def.name];
		if (value === undefined || value === null) {
			continue;
		}
		if (value === "" && def.optional) {
			continue;
		}
		if (def.type === "number") {
			const num = Number(value);
			if (value !== "" && !Number.isNaN(num)) {
				out[def.name] = num;
			}
			continue;
		}
		out[def.name] = value;
	}
	return out;
}

export function CredentialForm({
	credential,
	submitting,
	onSubmit,
}: CredentialFormProps) {
	const { t } = useT();
	const isEdit = credential !== undefined;
	const form = useForm<FormValues>({
		defaultValues: isEdit
			? {
					provider: credential.provider,
					label: credential.label,
					config: toFormConfig(
						PROVIDER_FIELDS[credential.provider].config,
						credential.config,
					),
					secret: {},
					replaceSecret: false,
				}
			: defaultsFor("AWS_S3"),
	});
	const {
		register,
		handleSubmit,
		watch,
		reset,
		setError,
		setValue,
		formState,
		getValues,
	} = form;
	const provider = watch("provider");
	const replaceSecret = watch("replaceSecret");
	const fields = PROVIDER_FIELDS[provider];
	const showSecret = !isEdit || replaceSecret;
	const ociPreview =
		provider === "OCI_OBJECT_STORAGE"
			? ociCompatHost(
					String(watch("config.namespace") || "<namespace>"),
					String(watch("config.region") || "<region>"),
				)
			: null;

	const submit = handleSubmit((values) => {
		const config = normalize(fields.config, values.config);
		for (const def of fields.config) {
			if (def.type !== "urlmap") {
				continue;
			}
			const parsed = parsePublicBaseUrls(String(values.config[def.name] ?? ""));
			if (!parsed.ok) {
				setError(`config.${def.name}` as keyof FormValues, {
					message: parsed.error,
				});
				return;
			}
			if (parsed.value) {
				config[def.name] = parsed.value;
			}
		}
		const secret = normalize(fields.secret, values.secret) as Record<
			string,
			string
		>;
		let parsed: z.ZodSafeParseResult<unknown>;
		if (isEdit) {
			parsed = updateCredentialSchema(provider).safeParse({
				label: values.label,
				config,
				...(values.replaceSecret ? { secret } : {}),
			});
		} else {
			parsed = createCredentialSchema.safeParse({
				provider,
				label: values.label,
				config,
				secret,
			});
		}
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				const path = issue.path.join(".");
				if (path) {
					setError(path as keyof FormValues, {
						message: zodIssueMessage(issue, t),
					});
				} else {
					setError("root", { message: zodIssueMessage(issue, t) });
				}
			}
			return;
		}
		onSubmit(parsed.data);
	});

	function renderField(scope: "config" | "secret", def: FieldDef) {
		const id = `${scope}-${def.name}`;
		const helpKey = def.tooltipKey ?? def.hintKey;
		const name = `${scope}.${def.name}` as const;
		const error = (
			formState.errors[scope] as
				| Record<string, { message?: string }>
				| undefined
		)?.[def.name]?.message;
		if (def.type === "checkbox") {
			return (
				<label
					key={def.name}
					htmlFor={id}
					className="flex items-center gap-2 text-sm text-zinc-300"
				>
					<input
						id={id}
						type="checkbox"
						className="h-4 w-4 accent-emerald-600"
						{...register(name)}
					/>
					{t(def.labelKey)}
				</label>
			);
		}
		return (
			<Field
				key={def.name}
				label={t(def.labelKey)}
				htmlFor={id}
				error={error}
				{...(helpKey ? { tooltip: t(helpKey) } : {})}
			>
				{def.type === "textarea" || def.type === "urlmap" ? (
					<Textarea
						id={id}
						placeholder={def.placeholder}
						autoComplete="off"
						aria-invalid={error ? true : undefined}
						{...register(name)}
					/>
				) : def.type === "select" ? (
					<SelectNative id={id} {...register(name)}>
						{def.optional ? (
							<option value="">{t("wizard.unset")}</option>
						) : null}
						{(def.options ?? []).map((option) => (
							<option key={option} value={option}>
								{option}
							</option>
						))}
					</SelectNative>
				) : (
					<Input
						id={id}
						type={def.type === "password" ? "password" : (def.type ?? "text")}
						placeholder={def.placeholder}
						autoComplete="off"
						aria-invalid={error ? true : undefined}
						{...register(name)}
					/>
				)}
			</Field>
		);
	}

	return (
		<form onSubmit={submit} noValidate>
			<fieldset disabled={submitting} className="space-y-4">
				{formState.errors.root?.message ? (
					<p role="alert" className="text-red-400 text-xs">
						{formState.errors.root.message}
					</p>
				) : null}

				{!isEdit && (
					<Field label={t("settingsForms.provider")} htmlFor="provider">
						<SelectNative
							id="provider"
							{...register("provider", {
								onChange: (e) =>
									reset(
										defaultsFor(
											e.target.value as CredentialProviderId,
											getValues("label"),
										),
									),
							})}
						>
							{/*
							 * Grouped by the SAME classification the list uses
							 * . The list was grouped and this dropdown
							 * was left flat — eighteen providers in one run, with a
							 * DRM content key sitting between object stores. The
							 * owner asked whether that was by design. It was not:
							 * it was the half of the screen I did not look at.
							 *
							 * `<optgroup>` rather than a second component, because a
							 * native select already knows how to render this and the
							 * keyboard behaviour comes free.
							 */}
							{CREDENTIAL_GROUPS.map((group) => (
								<optgroup key={group} label={t(GROUP_HEADING[group])}>
									{CREDENTIAL_PROVIDERS.filter(
										(p) => CREDENTIAL_PROVIDER_GROUP[p] === group,
									).map((p) => (
										<option key={p} value={p}>
											{CREDENTIAL_PROVIDER_LABELS[p]}
										</option>
									))}
								</optgroup>
							))}
						</SelectNative>
					</Field>
				)}

				<Field
					label={t("settingsForms.label")}
					htmlFor="label"
					error={formState.errors.label?.message}
				>
					<Input id="label" placeholder="prod-origin" {...register("label")} />
				</Field>

				{fields.config.map((def) => renderField("config", def))}
				{ociPreview ? (
					<p className="break-all text-xs text-zinc-500">
						{t("settings.s3CompatEndpoint")} <code>{ociPreview}</code>
					</p>
				) : null}
				{provider === "AKAMAI_MSL" ? (
					<MslEdgeCandidate
						streamId={watch("config.streamId")}
						eventName={watch("config.eventName")}
						onFill={(url) =>
							// Into the registered input, so the operator sees it, can
							// edit it, and the same submit path validates it.
							setValue("config.edgeBaseUrl", url, { shouldDirty: true })
						}
					/>
				) : null}

				{isEdit && fields.secret.length > 0 ? (
					<label
						htmlFor="replaceSecret"
						className="flex items-center gap-2 text-sm text-zinc-300"
					>
						<input
							id="replaceSecret"
							type="checkbox"
							className="h-4 w-4 accent-emerald-600"
							{...register("replaceSecret")}
						/>
						{t("settings.replaceSecretMaterial")}
					</label>
				) : null}

				{showSecret && fields.secret.length > 0 ? (
					<fieldset className="space-y-4 rounded-md border border-zinc-800 p-3">
						<legend className="px-1 text-xs text-zinc-500">
							{t("settings.secretMaterialWriteOnlyAes256")}
						</legend>
						{fields.secret.map((def) => renderField("secret", def))}
					</fieldset>
				) : null}

				<div className="flex justify-end gap-2 pt-2">
					<Button type="submit" disabled={submitting}>
						{submitting
							? t("settings.saving")
							: isEdit
								? t("settings.saveChanges")
								: t("settings.createCredential")}
					</Button>
				</div>
			</fieldset>
		</form>
	);
}
