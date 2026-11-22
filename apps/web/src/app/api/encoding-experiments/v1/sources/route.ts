import { listExperimentSources } from "@/lib/server/encoding-experiments";
import { experimentRoute } from "@/lib/server/encoding-experiments-http";

export function GET(req: Request) {
	return experimentRoute(req, "VIEWER", ({ organizationId }) =>
		listExperimentSources(organizationId),
	);
}
