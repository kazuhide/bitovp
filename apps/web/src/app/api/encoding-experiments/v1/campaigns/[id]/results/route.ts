import { listExperimentResults } from "@/lib/server/encoding-experiments";
import {
	type CampaignParams,
	experimentCampaignId,
	experimentCursor,
	experimentRoute,
} from "@/lib/server/encoding-experiments-http";

export function GET(req: Request, route: CampaignParams) {
	return experimentRoute(req, "VIEWER", async (ctx) =>
		listExperimentResults(
			ctx,
			await experimentCampaignId(route),
			experimentCursor(req),
		),
	);
}
