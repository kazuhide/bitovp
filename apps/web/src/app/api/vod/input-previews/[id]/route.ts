import { NextResponse } from "next/server";
import { invalidIdResponse } from "@/lib/server/http";
import { vodInputPreviewRouteError } from "@/lib/server/vod-input-preview-http";
import {
	cancelVodInputPreviewTask,
	getVodInputPreviewTask,
} from "@/lib/server/vod-input-previews";

type Context = { params: Promise<{ id: string }> };
export async function GET(_req: Request, context: Context) {
	const { id } = await context.params;
	const invalid = invalidIdResponse(id);
	if (invalid) return invalid;
	try {
		return NextResponse.json(
			{ task: await getVodInputPreviewTask(id) },
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (error) {
		return vodInputPreviewRouteError(error);
	}
}
export async function DELETE(_req: Request, context: Context) {
	const { id } = await context.params;
	const invalid = invalidIdResponse(id);
	if (invalid) return invalid;
	try {
		return NextResponse.json(
			{ task: await cancelVodInputPreviewTask(id) },
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (error) {
		return vodInputPreviewRouteError(error);
	}
}
