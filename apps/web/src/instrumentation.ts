/**
 * Boot rail (#32 §3c, refinement B): the TLS commitment is CONFIGURATION,
 * checked before the server accepts a single request — a per-request refusal
 * would mean the first http login POST already put a per-user password on
 * the wire. Only users mode is gated; password/none installs boot as before.
 *
 * Next runs register once at server startup (node runtime). Throwing here
 * refuses the boot with the operator-actionable reason on stdout.
 */
export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs") {
		return;
	}
	if (process.env.AUTH_MODE !== "users") {
		return;
	}
	const { loadAuthConfig } = await import("./lib/auth/config");
	const config = loadAuthConfig();
	if (!config.ok) {
		throw new Error(`[auth] refusing to start: ${config.reason}`);
	}
}
