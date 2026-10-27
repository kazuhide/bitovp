import { HlsManifestDefault } from "@bitmovin/api-sdk";
import type { SdkOps } from "../sdk-ops";
import type { OpsContext } from "./context";
import { createOwnedDefaultManifest } from "./owned-default-manifest";

/** A Default HLS root has the same owned-request recovery contract as Default DASH. */
export function createOwnedDefaultHlsManifest(
	ctx: OpsContext,
	params: Parameters<SdkOps["createDefaultHlsManifest"]>[0],
	source: HlsManifestDefault,
): Promise<string> {
	if (!params.encodingId) throw new Error("Default HLS requires an encodingId");
	return createOwnedDefaultManifest(ctx, params, source, {
		label: "default HLS",
		path: "/encoding/manifests/hls",
		encodingId: source.encodingId ?? "",
		request: (value) => new HlsManifestDefault(value),
		list: (query) => ctx.api.encoding.manifests.hls.list(query),
		customData: (id) => ctx.api.encoding.manifests.hls.customdata.get(id),
		create: (request) => ctx.api.encoding.manifests.hls.default.create(request),
		auditSelection: (request) => ({ encodingId: request.encodingId }),
	});
}
