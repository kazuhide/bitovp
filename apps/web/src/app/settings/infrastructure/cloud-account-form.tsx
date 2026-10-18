"use client";

import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative, Textarea } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import {
	CLOUD_ACCOUNT_CREATE_SCHEMAS,
	type CloudProviderId,
} from "@/lib/infrastructure/schemas";

type FormValues = {
	name: string;
	description: string;
	// aws
	accountNumber: string;
	roleName: string;
	externalId: string;
	accessKey: string;
	secretKey: string;
	// gce
	gceMode: "json" | "split";
	serviceAccountCredentials: string;
	serviceAccountEmail: string;
	privateKey: string;
	projectId: string;
	// azure
	subscriptionId: string;
	resourceGroupId: string;
	tenantId: string;
	// oci
	tenancyId: string;
	compartmentId: string;
	// akamai
	apiToken: string;
};

const EMPTY: FormValues = {
	name: "",
	description: "",
	accountNumber: "",
	roleName: "",
	externalId: "",
	accessKey: "",
	secretKey: "",
	gceMode: "json",
	serviceAccountCredentials: "",
	serviceAccountEmail: "",
	privateKey: "",
	projectId: "",
	subscriptionId: "",
	resourceGroupId: "",
	tenantId: "",
	tenancyId: "",
	compartmentId: "",
	apiToken: "",
};

/** Blank strings are dropped so zod optionals apply. */
function put(
	out: Record<string, unknown>,
	key: string,
	value: string,
	{ keepBlank = false } = {},
) {
	if (keepBlank || value !== "") {
		out[key] = value;
	}
}

/**
 * Create form for one Cloud Connect provider. Secret inputs (AWS legacy
 * keys, GCE credentials, Akamai token) are write-only: they pass through to
 * Bitmovin on create and are never shown again — and there is no update
 * API, so changing anything means delete + re-create.
 */
export function CloudAccountForm({
	provider,
	submitting,
	onSubmit,
}: {
	provider: CloudProviderId;
	submitting: boolean;
	onSubmit: (account: unknown) => void;
}) {
	const { t } = useT();
	const { register, handleSubmit, watch, setError, formState } =
		useForm<FormValues>({ defaultValues: EMPTY });
	const gceMode = watch("gceMode");
	const accountNumber = watch("accountNumber");
	const roleName = watch("roleName");

	const submit = handleSubmit((values) => {
		const account: Record<string, unknown> = {};
		put(account, "name", values.name);
		put(account, "description", values.description);
		if (provider === "aws") {
			// The API requires accountNumber — keep "" so the friendly
			// min(1) message fires instead of "received undefined".
			put(account, "accountNumber", values.accountNumber, { keepBlank: true });
			put(account, "roleName", values.roleName);
			put(account, "externalId", values.externalId);
			put(account, "accessKey", values.accessKey);
			put(account, "secretKey", values.secretKey);
		} else if (provider === "gce") {
			if (values.gceMode === "json") {
				put(
					account,
					"serviceAccountCredentials",
					values.serviceAccountCredentials,
				);
			} else {
				put(account, "serviceAccountEmail", values.serviceAccountEmail);
				put(account, "privateKey", values.privateKey);
				put(account, "projectId", values.projectId);
			}
		} else if (provider === "azure") {
			put(account, "subscriptionId", values.subscriptionId, {
				keepBlank: true,
			});
			put(account, "resourceGroupId", values.resourceGroupId, {
				keepBlank: true,
			});
			put(account, "tenantId", values.tenantId, { keepBlank: true });
		} else if (provider === "oci") {
			put(account, "tenancyId", values.tenancyId, { keepBlank: true });
			put(account, "compartmentId", values.compartmentId, { keepBlank: true });
		} else {
			put(account, "apiToken", values.apiToken, { keepBlank: true });
		}
		const parsed = CLOUD_ACCOUNT_CREATE_SCHEMAS[provider].safeParse(account);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				const path = issue.path.join(".");
				setError((path || "root") as keyof FormValues | "root", {
					message: zodIssueMessage(issue, t),
				});
			}
			return;
		}
		onSubmit(parsed.data);
	});

	return (
		<form onSubmit={submit} className="space-y-4" noValidate>
			{formState.errors.root?.message ? (
				<p role="alert" className="text-red-400 text-xs">
					{formState.errors.root.message}
				</p>
			) : null}

			<Field
				label={t("settingsForms.nameOptional")}
				htmlFor="cc-name"
				error={formState.errors.name?.message}
			>
				<Input id="cc-name" placeholder="prod-byoc" {...register("name")} />
			</Field>
			<Field
				label={t("settingsForms.descriptionOptional")}
				htmlFor="cc-description"
				error={formState.errors.description?.message}
			>
				<Input id="cc-description" {...register("description")} />
			</Field>

			{provider === "aws" ? (
				<>
					<Field
						label={t("settings.awsAccountNumber")}
						htmlFor="cc-accountNumber"
						error={formState.errors.accountNumber?.message}
						help={t("settingsForms.k12DigitAccountId")}
					>
						<Input
							id="cc-accountNumber"
							placeholder="123456789012"
							autoComplete="off"
							{...register("accountNumber")}
						/>
					</Field>
					<Field
						label={t("settings.iamRoleName")}
						htmlFor="cc-roleName"
						error={formState.errors.roleName?.message}
						help={t("settingsForms.modernPathBitmovinAssumesThisRoleNo")}
					>
						<Input
							id="cc-roleName"
							placeholder="bitmovin-encoding"
							autoComplete="off"
							{...register("roleName")}
						/>
					</Field>
					{accountNumber && roleName ? (
						<p className="break-all text-xs text-zinc-500">
							{t("settingsX.roleArn")}{" "}
							<code>{`arn:aws:iam::${accountNumber}:role/${roleName}`}</code>
						</p>
					) : null}
					<Field
						label={t("settingsForms.externalIdOptional")}
						htmlFor="cc-externalId"
						error={formState.errors.externalId?.message}
					>
						<Input
							id="cc-externalId"
							autoComplete="off"
							{...register("externalId")}
						/>
					</Field>
					<details className="rounded-md border border-zinc-800 p-3">
						<summary className="cursor-pointer text-xs text-zinc-400">
							{t("settings.advancedLegacyStaticAccessKeysDeprecated")}
						</summary>
						<div className="mt-3 space-y-4">
							<Field
								label={t("settings.accessKey")}
								htmlFor="cc-accessKey"
								error={formState.errors.accessKey?.message}
								help={t("settingsForms.writeOnlyPassesThroughToBitmovinNever")}
							>
								<Input
									id="cc-accessKey"
									type="password"
									autoComplete="off"
									{...register("accessKey")}
								/>
							</Field>
							<Field
								label={t("settings.secretKey")}
								htmlFor="cc-secretKey"
								error={formState.errors.secretKey?.message}
							>
								<Input
									id="cc-secretKey"
									type="password"
									autoComplete="off"
									{...register("secretKey")}
								/>
							</Field>
						</div>
					</details>
				</>
			) : null}

			{provider === "gce" ? (
				<>
					<Field
						label={t("settings.credentialsMode")}
						htmlFor="cc-gceMode"
						help={t("settingsForms.eitherTheWholeServiceAccountJsonOr")}
					>
						<SelectNative id="cc-gceMode" {...register("gceMode")}>
							<option value="json">{t("settings.serviceAccountJson")}</option>
							<option value="split">
								{t("settings.emailPrivateKeyProject")}
							</option>
						</SelectNative>
					</Field>
					{gceMode === "json" ? (
						<Field
							label={t("settingsForms.serviceAccountCredentialsJson")}
							htmlFor="cc-sac"
							error={formState.errors.serviceAccountCredentials?.message}
							help={t("settingsForms.writeOnlyPassesThroughToBitmovinNever")}
						>
							<Textarea
								id="cc-sac"
								autoComplete="off"
								placeholder='{"type": "service_account", ...}'
								{...register("serviceAccountCredentials")}
							/>
						</Field>
					) : (
						<>
							<Field
								label={t("settings.serviceAccountEmail")}
								htmlFor="cc-saEmail"
								error={formState.errors.serviceAccountEmail?.message}
							>
								<Input
									id="cc-saEmail"
									autoComplete="off"
									placeholder="encoder@project.iam.gserviceaccount.com"
									{...register("serviceAccountEmail")}
								/>
							</Field>
							<Field
								label={t("settings.privateKey")}
								htmlFor="cc-privateKey"
								error={formState.errors.privateKey?.message}
								help={t("settingsForms.writeOnlyPassesThroughToBitmovinNever")}
							>
								<Textarea
									id="cc-privateKey"
									autoComplete="off"
									placeholder="-----BEGIN PRIVATE KEY-----"
									{...register("privateKey")}
								/>
							</Field>
							<Field
								label={t("settings.projectId")}
								htmlFor="cc-projectId"
								error={formState.errors.projectId?.message}
							>
								<Input
									id="cc-projectId"
									autoComplete="off"
									{...register("projectId")}
								/>
							</Field>
						</>
					)}
				</>
			) : null}

			{provider === "azure" ? (
				<>
					<Field
						label={t("settings.subscriptionId")}
						htmlFor="cc-subscriptionId"
						error={formState.errors.subscriptionId?.message}
					>
						<Input
							id="cc-subscriptionId"
							autoComplete="off"
							{...register("subscriptionId")}
						/>
					</Field>
					<Field
						label={t("settings.resourceGroupId")}
						htmlFor="cc-resourceGroupId"
						error={formState.errors.resourceGroupId?.message}
					>
						<Input
							id="cc-resourceGroupId"
							autoComplete="off"
							{...register("resourceGroupId")}
						/>
					</Field>
					<Field
						label={t("settings.tenantId")}
						htmlFor="cc-tenantId"
						error={formState.errors.tenantId?.message}
					>
						<Input
							id="cc-tenantId"
							autoComplete="off"
							{...register("tenantId")}
						/>
					</Field>
				</>
			) : null}

			{provider === "oci" ? (
				<>
					<Field
						label={t("settings.tenancyOcid")}
						htmlFor="cc-tenancyId"
						error={formState.errors.tenancyId?.message}
					>
						<Input
							id="cc-tenancyId"
							autoComplete="off"
							placeholder={t("settings.ocid1TenancyOc1")}
							{...register("tenancyId")}
						/>
					</Field>
					<Field
						label={t("settings.compartmentOcid")}
						htmlFor="cc-compartmentId"
						error={formState.errors.compartmentId?.message}
					>
						<Input
							id="cc-compartmentId"
							autoComplete="off"
							placeholder={t("settings.ocid1CompartmentOc1")}
							{...register("compartmentId")}
						/>
					</Field>
				</>
			) : null}

			{provider === "akamai" ? (
				<Field
					label={t("settings.apiToken")}
					htmlFor="cc-apiToken"
					error={formState.errors.apiToken?.message}
					help={t("settingsForms.writeOnlyPassesThroughToBitmovinNever")}
				>
					<Input
						id="cc-apiToken"
						type="password"
						autoComplete="off"
						{...register("apiToken")}
					/>
				</Field>
			) : null}

			<div className="flex justify-end pt-2">
				<Button type="submit" disabled={submitting}>
					{submitting ? t("settings.creating") : t("settings.createAccount")}
				</Button>
			</div>
		</form>
	);
}
