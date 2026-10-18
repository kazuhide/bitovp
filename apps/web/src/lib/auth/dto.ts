import type { CustomerErrorCode } from "@/lib/customer-error";
import type { AuthMode } from "./config";

/** Shape returned by GET /api/auth/session — client-safe types only. */
export type SessionDto = {
	organizationUnavailable?: boolean;
	mode: AuthMode;
	configured: boolean;
	organizationId?: string;
	organizationName?: string;
	organizations?: {
		id: string;
		name: string;
		slug: string;
		role: "ADMIN" | "OPERATOR" | "VIEWER";
	}[];
	actorUserId?: string | null;
	effectiveUserId?: string | null;
	platformOwner?: boolean;
	isImpersonating?: boolean;
	targetDisplayName?: string | null;
	impersonationExpiresAt?: number;
	authenticated: boolean;
	loginKind: "password-form" | "idp-redirect" | "disabled";
	/** Stable customer-copy reason; raw provider diagnostics stay server-side. */
	reasonCode?: CustomerErrorCode;
	expiresAt?: string;
	absoluteExpiresAt?: string;
	/** users mode (#32 §6): resolved from the DB by the session endpoint —
	 * the cookie carries no role claim, so this is the ONLY role source the
	 * UI ever reads. */
	displayName?: string;
	email?: string;
	role?: "ADMIN" | "OPERATOR" | "VIEWER";
	mustChangePassword?: boolean;
};
