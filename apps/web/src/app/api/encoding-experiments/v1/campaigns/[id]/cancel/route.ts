import { setExperimentCampaignState } from "@/lib/server/encoding-experiments";
import {
	type CampaignParams,
	experimentCampaignId,
	experimentRoute,
} from "@/lib/server/encoding-experiments-http";

export function POST(req: Request, route: CampaignParams) {
	return experimentRoute(req, "OPERATOR", async (ctx) =>
		setExperimentCampaignState(
			ctx,
			await experimentCampaignId(route),
			"cancel",
		),
	);
}
