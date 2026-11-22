import { experimentRequestByteLimit } from "@bitovp/core/encoding-experiments";
import { validateExperimentTrial } from "@/lib/server/encoding-experiments";
import {
	experimentBody,
	experimentRoute,
} from "@/lib/server/encoding-experiments-http";

export function POST(req: Request) {
	return experimentRoute(req, "OPERATOR", async ({ organizationId }) =>
		validateExperimentTrial(
			organizationId,
			await experimentBody(req, experimentRequestByteLimit),
		),
	);
}
