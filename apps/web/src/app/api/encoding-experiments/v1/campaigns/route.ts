import {
	createExperimentCampaign,
	listExperimentCampaigns,
} from "@/lib/server/encoding-experiments";
import {
	experimentBody,
	experimentCursor,
	experimentRoute,
} from "@/lib/server/encoding-experiments-http";

export function GET(req: Request) {
	return experimentRoute(req, "VIEWER", (ctx) =>
		listExperimentCampaigns(ctx, experimentCursor(req)),
	);
}

export function POST(req: Request) {
	return experimentRoute(
		req,
		"OPERATOR",
		async (ctx) =>
			createExperimentCampaign(ctx, await experimentBody(req, 4096)),
		201,
	);
}
