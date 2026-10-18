import { NextResponse } from "next/server";
import { isHumanActor } from "@/lib/auth/api-token-gate";
import { actorFrom } from "@/lib/server/audit";

/**
 * review-265 130-A3: an API TOKEN must not be able to wipe the database.
 *
 * The proxy authenticates a valid bearer token for every `/api/*` path with
 * no path or role check (`ApiToken.role` exists and nothing consults it —
 * that RBAC is #32/P11's job). Before this feature that gap bought a token
 * the same reach as the console; THIS route is what would turn it into total
 * data loss, so it refuses token auth now rather than waiting for #32. The
 * actor header the proxy stamps is the discriminator: `token:<id>` for bearer
 * auth, anything else for a session.
 */
export function tokenActorRefusal(req: Request): NextResponse | null {
	const actor = actorFrom(req);
	// #32 §4 (sec-B2/N10): an ALLOWLIST of accepted actor kinds, kept as
	// defence in depth under the gate's own ADMIN rule. The old
	// startsWith("token:") denylist passed "none" AND a missing header — the
	// exact shape #81's fail-closed fix warned about. "none" stays accepted
	// HERE deliberately: AUTH_MODE=none is the typed-out full-open escape
	// hatch and this refusal's job is only to keep TOKENS out.
	if (
		actor !== null &&
		(actor === "session" || actor === "none" || isHumanActor(actor))
	) {
		return null;
	}
	return NextResponse.json(
		{
			error:
				"API tokens cannot reset this deployment — sign in to the console and use Settings → Reset data.",
		},
		{ status: 403 },
	);
}
