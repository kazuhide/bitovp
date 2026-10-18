import "server-only";
import type BitmovinApi from "@bitmovin/api-sdk";
import {
	AkamaiAccount,
	AkamaiAccountRegionSettings,
	type AkamaiCloudRegion,
	AwsAccount,
	AwsAccountRegionSettings,
	type AwsCloudRegion,
	AzureAccount,
	AzureAccountRegionSettings,
	type AzureCloudRegion,
	GceAccount,
	GceAccountRegionSettings,
	type GoogleCloudRegion,
	OciAccount,
	OciAccountRegionSettings,
	type OciCloudRegion,
} from "@bitmovin/api-sdk";
import type { CloudProviderId } from "@/lib/infrastructure/schemas";

type UnknownRecord = Record<string, unknown>;
type ListParams = { offset: number; limit: number };

/**
 * Uniform view over the five per-provider Cloud Connect APIs (identical
 * method sets, different model classes). Provider-specific typing stays in
 * this one switch; routes and tests see string regions + plain records, and
 * every response is treated as `unknown` until it passes the schemas.ts
 * allowlist sanitizers. Payloads arrive zod-validated (strict schemas), so
 * the Partial<Model> casts only bridge `unknown` field types.
 */
export type CloudAccountOps = {
	create(payload: UnknownRecord): Promise<unknown>;
	get(infrastructureId: string): Promise<unknown>;
	del(infrastructureId: string): Promise<unknown>;
	list(params: ListParams): Promise<unknown>;
	regions: {
		create(
			infrastructureId: string,
			region: string,
			settings: UnknownRecord,
		): Promise<unknown>;
		get(infrastructureId: string, region: string): Promise<unknown>;
		del(infrastructureId: string, region: string): Promise<unknown>;
		list(infrastructureId: string, params: ListParams): Promise<unknown>;
	};
};

export function cloudAccountOps(
	api: BitmovinApi,
	provider: CloudProviderId,
): CloudAccountOps {
	switch (provider) {
		case "aws": {
			const ops = api.encoding.infrastructure.aws;
			return {
				create: (payload) =>
					ops.create(new AwsAccount(payload as Partial<AwsAccount>)),
				get: (id) => ops.get(id),
				del: (id) => ops.delete(id),
				list: (params) => ops.list(params),
				regions: {
					create: (id, region, settings) =>
						ops.regions.create(
							id,
							region as AwsCloudRegion,
							new AwsAccountRegionSettings(
								settings as Partial<AwsAccountRegionSettings>,
							),
						),
					get: (id, region) => ops.regions.get(id, region as AwsCloudRegion),
					del: (id, region) => ops.regions.delete(id, region as AwsCloudRegion),
					list: (id, params) => ops.regions.list(id, params),
				},
			};
		}
		case "gce": {
			const ops = api.encoding.infrastructure.gce;
			return {
				create: (payload) =>
					ops.create(new GceAccount(payload as Partial<GceAccount>)),
				get: (id) => ops.get(id),
				del: (id) => ops.delete(id),
				list: (params) => ops.list(params),
				regions: {
					create: (id, region, settings) =>
						ops.regions.create(
							id,
							region as GoogleCloudRegion,
							new GceAccountRegionSettings(
								settings as Partial<GceAccountRegionSettings>,
							),
						),
					get: (id, region) => ops.regions.get(id, region as GoogleCloudRegion),
					del: (id, region) =>
						ops.regions.delete(id, region as GoogleCloudRegion),
					list: (id, params) => ops.regions.list(id, params),
				},
			};
		}
		case "azure": {
			const ops = api.encoding.infrastructure.azure;
			return {
				create: (payload) =>
					ops.create(new AzureAccount(payload as Partial<AzureAccount>)),
				get: (id) => ops.get(id),
				del: (id) => ops.delete(id),
				list: (params) => ops.list(params),
				regions: {
					create: (id, region, settings) =>
						ops.regions.create(
							id,
							region as AzureCloudRegion,
							new AzureAccountRegionSettings(
								settings as Partial<AzureAccountRegionSettings>,
							),
						),
					get: (id, region) => ops.regions.get(id, region as AzureCloudRegion),
					del: (id, region) =>
						ops.regions.delete(id, region as AzureCloudRegion),
					list: (id, params) => ops.regions.list(id, params),
				},
			};
		}
		case "akamai": {
			const ops = api.encoding.infrastructure.akamai;
			return {
				create: (payload) =>
					ops.create(new AkamaiAccount(payload as Partial<AkamaiAccount>)),
				get: (id) => ops.get(id),
				del: (id) => ops.delete(id),
				list: (params) => ops.list(params),
				regions: {
					create: (id, region, settings) =>
						ops.regions.create(
							id,
							region as AkamaiCloudRegion,
							new AkamaiAccountRegionSettings(
								settings as Partial<AkamaiAccountRegionSettings>,
							),
						),
					get: (id, region) => ops.regions.get(id, region as AkamaiCloudRegion),
					del: (id, region) =>
						ops.regions.delete(id, region as AkamaiCloudRegion),
					list: (id, params) => ops.regions.list(id, params),
				},
			};
		}
		case "oci": {
			const ops = api.encoding.infrastructure.oci;
			return {
				create: (payload) =>
					ops.create(new OciAccount(payload as Partial<OciAccount>)),
				get: (id) => ops.get(id),
				del: (id) => ops.delete(id),
				list: (params) => ops.list(params),
				regions: {
					create: (id, region, settings) =>
						ops.regions.create(
							id,
							region as OciCloudRegion,
							new OciAccountRegionSettings(
								settings as Partial<OciAccountRegionSettings>,
							),
						),
					get: (id, region) => ops.regions.get(id, region as OciCloudRegion),
					del: (id, region) => ops.regions.delete(id, region as OciCloudRegion),
					list: (id, params) => ops.regions.list(id, params),
				},
			};
		}
	}
}
