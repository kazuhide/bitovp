import {
	aisaTranslationsGet,
	aisaTranslationsPost,
} from "@/lib/server/aisa-live-translations";

export async function GET(
	req: Request,
	context: { params: Promise<{ analysisId: string }> },
) {
	return aisaTranslationsGet(req, (await context.params).analysisId);
}

export async function POST(
	req: Request,
	context: { params: Promise<{ analysisId: string }> },
) {
	return aisaTranslationsPost(req, (await context.params).analysisId);
}
