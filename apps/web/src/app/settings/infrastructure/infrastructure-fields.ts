import type { MessageKey } from "@/lib/i18n";
import type { Translator } from "@/lib/i18n/context";
import type {
	CloudAccountDto,
	CloudProviderId,
} from "@/lib/infrastructure/schemas";

/**
 * Per-provider display + region-settings form metadata for the Cloud
 * Connect panel. Validation stays in lib/infrastructure/schemas.ts — these
 * tables only drive rendering.
 */

export type RegionFieldDef = {
	name: string;
	labelKey: MessageKey;
	type?: "number";
	optional?: boolean;
	hintKey?: MessageKey;
};

export const REGION_SETTINGS_FIELDS: Record<CloudProviderId, RegionFieldDef[]> =
	{
		aws: [
			{ name: "securityGroupId", labelKey: "fields.securityGroupId" },
			{ name: "subnetId", labelKey: "fields.subnetId" },
			{
				name: "limitParallelEncodings",
				labelKey: "fields.limitParallelEncodingsOptional",
				type: "number",
				optional: true,
			},
			{
				name: "sshPort",
				labelKey: "fields.sshPortOptional",
				type: "number",
				optional: true,
				hintKey: "fields.k165535",
			},
		],
		gce: [
			{ name: "network", labelKey: "fields.network" },
			{ name: "subnetId", labelKey: "fields.subnetId" },
		],
		azure: [
			{ name: "networkName", labelKey: "fields.networkName" },
			{ name: "subnetName", labelKey: "fields.subnetName" },
		],
		akamai: [
			{
				name: "subnetId",
				labelKey: "fields.subnetId",
				type: "number",
				hintKey: "fields.numericAkamaiIdsAreNumbersUnlike",
			},
			{ name: "firewallId", labelKey: "fields.firewallId", type: "number" },
		],
		oci: [{ name: "subnetId", labelKey: "fields.subnetOcid" }],
	};

/** One-line summary under each account row in the list. */
export const CLOUD_ACCOUNT_SUMMARY: Record<
	CloudProviderId,
	(account: CloudAccountDto, t: Translator) => string
> = {
	aws: (a, t) =>
		a.roleName
			? `arn:aws:iam::${a.accountNumber ?? "?"}:role/${a.roleName}`
			: t("fields.accountLegacyKeys", { number: a.accountNumber ?? "?" }),
	gce: (a, t) =>
		a.serviceAccountEmail
			? `${a.serviceAccountEmail}${a.projectId ? ` · ${a.projectId}` : ""}`
			: t("fields.serviceAccountJson"),
	azure: (a, t) =>
		t("fields.azureSummary", {
			subscription: a.subscriptionId ?? "?",
			group: a.resourceGroupId ?? "?",
			tenant: a.tenantId ?? "?",
		}),
	akamai: (_a, t) => t("fields.apiTokenConfigured"),
	oci: (a) => `${a.tenancyId ?? "?"} · ${a.compartmentId ?? "?"}`,
};
