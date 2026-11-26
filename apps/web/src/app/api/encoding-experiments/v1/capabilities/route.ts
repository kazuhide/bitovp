import { getExperimentCapabilities } from "@/lib/server/encoding-experiments";
import {
	experimentBackend,
	experimentRoute,
} from "@/lib/server/encoding-experiments-http";

export function GET(req: Request) {
	return experimentRoute(req, "VIEWER", () =>
		getExperimentCapabilities(experimentBackend(req)),
	);
}
