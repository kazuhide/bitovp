import { NextResponse } from "next/server";
import { jsonError } from "@/lib/server/http";
import { clientKey, createFixedWindowLimiter } from "@/lib/server/rate-limit";
import {
	readVodInputPreviewJson,
	vodInputPreviewRouteError,
} from "@/lib/server/vod-input-preview-http";
import { createVodInputPreviewTask } from "@/lib/server/vod-input-previews";

const limiter = createFixedWindowLimiter({ limit: 30, windowMs: 60_000 });
export async function POST(req: Request) {
	if (!limiter.check(clientKey(req)))
		return jsonError(429, "Too many requests");
	try {
		const task = await createVodInputPreviewTask(
			await readVodInputPreviewJson(req),
		);
		return NextResponse.json(
			{ task },
			{
				status: task.status === "SUCCEEDED" ? 200 : 202,
				headers: { "Cache-Control": "private, no-store" },
			},
		);
	} catch (error) {
		return vodInputPreviewRouteError(error);
	}
}
