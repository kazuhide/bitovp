import {
	getExperimentCampaign,
	setExperimentCampaignState,
} from "@/lib/server/encoding-experiments";
import {
	type CampaignParams,
	experimentCampaignAction,
	experimentCampaignId,
	experimentRoute,
} from "@/lib/server/encoding-experiments-http";

export function GET(req: Request, route: CampaignParams) {
	return experimentRoute(req, "VIEWER", async (ctx) =>
		getExperimentCampaign(ctx, await experimentCampaignId(route)),
	);
}

export function PATCH(req: Request, route: CampaignParams) {
	return experimentRoute(req, "OPERATOR", async (ctx) =>
		setExperimentCampaignState(
			ctx,
			await experimentCampaignId(route),
			await experimentCampaignAction(req),
		),
	);
}
