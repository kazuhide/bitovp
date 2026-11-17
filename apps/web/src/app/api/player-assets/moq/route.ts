import { passiveOrganizationBinding } from "@/lib/passive-request";
import { readMoqPlayerBundle } from "@/lib/server/moq-player-asset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** The auth proxy requires OPERATOR; the caller never selects a file or URL. */
export async function GET(req: Request) {
	const url = new URL(req.url),
		binding = passiveOrganizationBinding(url, req.method);
	if (
		binding.kind === "invalid" ||
		(url.searchParams.size > 0 && binding.kind !== "bound")
	) {
		return Response.json(
			{ error: "Asset parameters are not supported" },
			{ status: 400, headers },
		);
	}
	try {
		return new Response(await readMoqPlayerBundle(), {
			headers: {
				...headers,
				"Content-Type": "application/javascript; charset=utf-8",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch {
		return Response.json(
			{ error: "MoQ player bundle unavailable" },
			{ status: 503, headers },
		);
	}
}
