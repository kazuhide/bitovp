import { selectExperimentQuality } from "@/lib/server/encoding-experiments";
import {
	type CampaignParams,
	experimentBody,
	experimentCampaignId,
	experimentRoute,
} from "@/lib/server/encoding-experiments-http";

export function POST(req: Request, route: CampaignParams) {
	return experimentRoute(req, "OPERATOR", async (ctx) =>
		selectExperimentQuality(
			ctx,
			await experimentCampaignId(route),
			await experimentBody(req, 8192),
		),
	);
}
