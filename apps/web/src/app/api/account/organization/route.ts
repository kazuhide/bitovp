import { z } from "zod";
import { loadAuthConfig } from "@/lib/auth/config";
import { authError, sessionResponse } from "@/lib/auth/route-context";
import { signSession } from "@/lib/auth/session";
import {
	AuthContextError,
	resolveAuthenticatedContext,
	resolveSessionIdentity,
} from "@/lib/auth/tenancy";

const schema = z.strictObject({ organizationId: z.uuid() });
export async function POST(req: Request) {
	try {
		const { user, payload } = await resolveSessionIdentity(req.headers);
		if (payload.targetUserId || user.mustChangePassword)
			throw new AuthContextError(403, "Organization switching is unavailable");
		const input = schema.safeParse(await req.json());
		if (!input.success) return new Response(null, { status: 400 });
		const next = { ...payload, organizationId: input.data.organizationId };
		const config = loadAuthConfig();
		if (!config.ok || config.settings.mode !== "users")
			throw new AuthContextError(503, "User authentication is unavailable");
		const secret = config.settings.sessionSecret;
		const headers = new Headers(req.headers);
		headers.delete("x-bitovp-expected-org");
		headers.delete("authorization");
		// Validate the proposed signed scope through the same tenant/IP resolver.
		await resolveAuthenticatedContext(headers, {
			get: (name) =>
				name === "bitovp_session"
					? { value: signSession(next, secret) }
					: undefined,
		});
		return sessionResponse(req, next);
	} catch (err) {
		return authError(err);
	}
}
