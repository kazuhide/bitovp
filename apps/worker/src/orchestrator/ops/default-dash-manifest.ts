import { DashManifestDefault } from "@bitmovin/api-sdk";
import type { SdkOps } from "../sdk-ops";
import type { OpsContext } from "./context";
import { createOwnedDefaultManifest } from "./owned-default-manifest";

type Params = Parameters<SdkOps["createDefaultDashManifest"]>[0];
const label = "default DASH";

/** Bind either selection form to its complete wire request and owned job step. */
export async function createOwnedDefaultDashManifest(
	ctx: OpsContext,
	params: Params,
	source: DashManifestDefault,
): Promise<string> {
	const explicitPeriods = params.periods !== undefined;
	if (
		explicitPeriods
			? !params.periods?.length ||
				params.periods.some((period) => !period.encodingIds.length) ||
				params.encodingId !== undefined ||
				params.version !== "V2"
			: !params.encodingId
	) {
		throw new Error(
			`${label} requires an encodingId, or V2 with nonempty period encoding IDs and no root encodingId`,
		);
	}
	return createOwnedDefaultManifest(ctx, params, source, {
		label,
		path: "/encoding/manifests/dash",
		encodingId:
			source.encodingId ?? source.periods?.[0]?.encodingIds?.[0] ?? "",
		request: (value) => new DashManifestDefault(value),
		list: (query) => ctx.api.encoding.manifests.dash.list(query),
		customData: (id) => ctx.api.encoding.manifests.dash.customdata.get(id),
		create: (request) =>
			ctx.api.encoding.manifests.dash.default.create(request),
		auditSelection: (request) => ({
			periodEncodingIds: request.periods?.map((period) => period.encodingIds),
		}),
	});
}
