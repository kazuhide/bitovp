import "server-only";
import {
	type AisaLiveClient,
	type AisaLiveVersions,
	createAisaLiveClient,
} from "@bitovp/core/aisa-live-client";
import { aisaLiveAccessAllowed } from "./aisa-live-access";
import type { ServerContext } from "./context";

export type {
	AisaLiveClient,
	AisaLiveErrorCode,
	AisaLiveVersions,
} from "@bitovp/core/aisa-live-client";
export {
	AISA_LIVE_PREVIEW_SDK_VERSION,
	AisaLiveError,
	aisaLivePreviewEnabled,
} from "@bitovp/core/aisa-live-client";
export async function aisaLiveClientForAccount(
	ctx: ServerContext,
	accountId: string,
	versions: AisaLiveVersions = {},
): Promise<AisaLiveClient | null> {
	if (!aisaLiveAccessAllowed(ctx.tenant)) return null;
	const account = await ctx.bitmovinAccounts.get(accountId);
	if (!account) return null;
	return createAisaLiveClient({
		apiKey: await ctx.bitmovinAccounts.revealApiKey(accountId),
		...(account.tenantOrgId ? { tenantOrgId: account.tenantOrgId } : {}),
		versions,
	});
}
