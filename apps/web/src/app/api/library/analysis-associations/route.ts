import {
	confirmAnalysisAssociation,
	inspectAnalysisAssociation,
} from "@/lib/server/library-analysis-associations";
import { editingBody, editingRoute } from "@/lib/server/library-editing-common";
import { editingMutation } from "@/lib/server/library-editing-routes";

export async function GET(req: Request) {
	return editingRoute(() =>
		inspectAnalysisAssociation(
			Object.fromEntries(new URL(req.url).searchParams),
		),
	);
}
export async function POST(req: Request) {
	return editingMutation(req, async (actor) =>
		confirmAnalysisAssociation(await editingBody(req), actor),
	);
}
