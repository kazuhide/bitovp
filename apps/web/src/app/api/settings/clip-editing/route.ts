import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import { readJson, routeError, validationError } from "@/lib/server/http";
import { diagnoseLocalSemanticReadiness } from "@/lib/server/local-semantic-readiness";

export const dynamic = "force-dynamic";
const response = (value: unknown) =>
	NextResponse.json(value, { headers: { "Cache-Control": "no-store" } });
export async function GET() {
	try {
		await getServerContext();
		return response(await diagnoseLocalSemanticReadiness());
	} catch (error) {
		return routeError(error);
	}
}
export async function POST(req: Request) {
	try {
		await getServerContext();
		const body = z.strictObject({}).safeParse(await readJson(req));
		if (!body.success) return validationError(body.error);
		return response(await diagnoseLocalSemanticReadiness({ diagnose: true }));
	} catch (error) {
		return routeError(error);
	}
}
