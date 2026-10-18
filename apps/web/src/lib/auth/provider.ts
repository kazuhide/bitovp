import type { AuthMode, AuthSettings } from "./config";
import { verifyPassword } from "./password";
import { type ResolvedUser, verifyUserLogin } from "./users";

/**
 * The seam every auth mode goes through. `password` is the only implemented
 * provider; `oidc` exists so the gate has one place to grow and reports
 * honestly that it is not implemented ( #31) instead of
 * failing open.
 */
export type ProviderReadiness =
	| { readonly ready: true }
	| { readonly ready: false; readonly reason: string };

export type LoginSubmission = {
	readonly password?: string;
	/** users mode only (#32): which account the password claims. */
	readonly email?: string;
};

/** The ok branch carries identity in users mode (#32 — the shared-password
 * contract had none to carry; ab-M7 named this as NEW, not reuse). */
export type VerifyResult =
	| {
			readonly ok: true;
			readonly user?: ResolvedUser;
			/** users mode only: binds the login linearization CAS to the hash
			 * that async scrypt actually verified. Never serialized to a client. */
			readonly verifiedCredential?: {
				readonly sessionGeneration: number;
				readonly passwordHash: string;
			};
	  }
	| {
			readonly ok: false;
			readonly status: number;
			readonly error: string;
			/** users mode: the ONE distinguishable failure (§2 — the caller
			 * already proved the password). */
			readonly passwordExpired?: boolean;
	  };

export type AuthProvider = {
	readonly mode: AuthMode;
	/** What /login has to render for this mode. */
	readonly loginKind: "password-form" | "idp-redirect" | "disabled";
	/**
	 * Gates every guarded request: not-ready fails closed with a 503 carrying
	 * `reason` (operator-actionable, names env vars only).
	 */
	readiness(): ProviderReadiness;
	verify(submission: LoginSubmission): Promise<VerifyResult>;
};

function passwordProvider(passwordHash: string): AuthProvider {
	return {
		mode: "password",
		loginKind: "password-form",
		// loadAuthConfig already proved the hash and the session secret exist and
		// parse; reaching here means the install is configured.
		readiness: () => ({ ready: true }),
		verify: async ({ password }) => {
			if (typeof password !== "string" || password.length === 0) {
				return { ok: false, status: 400, error: "Password is required" };
			}
			// awaited: verifyPassword is async now, so scrypt runs on the threadpool
			// instead of blocking the event loop for the whole process.
			return (await verifyPassword(password, passwordHash))
				? { ok: true }
				: { ok: false, status: 401, error: "Invalid password" };
		},
	};
}

function usersProvider(): AuthProvider {
	return {
		mode: "users",
		loginKind: "password-form",
		// loadAuthConfig proved the session secret and the TLS commitment; the
		// zero-users bootstrap state is the GATE's job (503/redirect, §3), not
		// a readiness failure — login against an empty table just fails closed.
		readiness: () => ({ ready: true }),
		verify: async ({ email, password }) => {
			if (typeof email !== "string" || email.trim().length === 0) {
				return { ok: false, status: 400, error: "Email is required" };
			}
			if (typeof password !== "string" || password.length === 0) {
				return { ok: false, status: 400, error: "Password is required" };
			}
			const verdict = await verifyUserLogin(email, password);
			if (verdict.ok) {
				return {
					ok: true,
					user: verdict.user,
					verifiedCredential: verdict.verifiedCredential,
				};
			}
			if (verdict.reason === "password-expired") {
				return {
					ok: false,
					status: 401,
					error:
						"This temporary password has expired — ask an admin to reissue one",
					passwordExpired: true,
				};
			}
			// One indistinguishable message for unknown/wrong/inactive .
			return { ok: false, status: 401, error: "Invalid credentials" };
		},
	};
}

const OIDC_NOT_IMPLEMENTED =
	"AUTH_MODE=oidc is unavailable because no OIDC provider is implemented. " +
	"Use AUTH_MODE=password, or " +
	"AUTH_MODE=none for local development.";

function oidcProvider(): AuthProvider {
	return {
		mode: "oidc",
		loginKind: "idp-redirect",
		readiness: () => ({ ready: false, reason: OIDC_NOT_IMPLEMENTED }),
		verify: async () => ({
			ok: false,
			status: 503,
			error: OIDC_NOT_IMPLEMENTED,
		}),
	};
}

function noneProvider(): AuthProvider {
	return {
		mode: "none",
		loginKind: "disabled",
		readiness: () => ({ ready: true }),
		verify: async () => ({
			ok: false,
			status: 400,
			error: "Authentication is disabled (AUTH_MODE=none); no sign-in needed",
		}),
	};
}

export function resolveProvider(settings: AuthSettings): AuthProvider {
	switch (settings.mode) {
		case "password":
			return passwordProvider(settings.passwordHash);
		case "users":
			return usersProvider();
		case "oidc":
			return oidcProvider();
		case "none":
			return noneProvider();
	}
}
