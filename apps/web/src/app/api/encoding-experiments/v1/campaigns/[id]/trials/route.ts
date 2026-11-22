import {
	enqueueExperimentTrials,
	listExperimentTrials,
} from "@/lib/server/encoding-experiments";
import {
	type CampaignParams,
	experimentBody,
	experimentCampaignId,
	experimentCursor,
	experimentRoute,
} from "@/lib/server/encoding-experiments-http";

export function GET(req: Request, route: CampaignParams) {
	return experimentRoute(req, "VIEWER", async (ctx) =>
		listExperimentTrials(
			ctx,
			await experimentCampaignId(route),
			experimentCursor(req),
		),
	);
}

export function POST(req: Request, route: CampaignParams) {
	return experimentRoute(
		req,
		"OPERATOR",
		async (ctx) =>
			enqueueExperimentTrials(
				ctx,
				await experimentCampaignId(route),
				await experimentBody(req, 256 * 1024),
				req.headers.get("idempotency-key"),
			),
		202,
	);
}
