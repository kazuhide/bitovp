import { z } from "zod";
import { parsePasswordHash } from "./password";

/**
 * Auth environment. Deliberately parsed here rather than in core's
 * `loadEnv`, following the same design note as `masterKeyFromEnv`: only
 * code that actually gates a request should require the auth vars to be
 * present, and an invalid value must surface as a 503 on the guarded path
 * instead of crashing every route that happens to read the environment.
 *
 * Fail-closed contract: an install that sets NOTHING lands in
 * `mode: "password"` with no hash — `loadAuthConfig` returns `ok: false`,
 * so `/api/*` answers 503. `AUTH_MODE=none` is the only way to get an open
 * install, and it has to be typed out.
 */
export const AUTH_MODES = ["password", "users", "oidc", "none"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** ≥32 bytes of key material — a shorter HMAC key is not worth signing with. */
const MIN_SESSION_SECRET_BYTES = 32;

const authEnvSchema = z.object({
	AUTH_MODE: z.enum(AUTH_MODES).default("password"),
	AUTH_PASSWORD_HASH: z.string().optional(),
	AUTH_SESSION_SECRET: z.string().optional(),
	/** Users-mode TLS rail (#32 §3c): the detection point is CONFIGURATION,
	 * not the request — a per-request refusal would mean the first http
	 * login POST already put a password on the wire. */
	PUBLIC_BASE_URL: z.string().optional(),
	AUTH_ALLOW_INSECURE_HTTP: z.string().optional(),
	/** Idle window: a session not used within it expires. */
	AUTH_SESSION_IDLE_MINUTES: z.coerce
		.number()
		.int()
		.min(5)
		.max(43_200)
		.default(720),
	/** Absolute ceiling: renewal can never extend a session past it. */
	AUTH_SESSION_MAX_HOURS: z.coerce
		.number()
		.int()
		.min(1)
		.max(8_760)
		.default(168),
});

export type AuthSettings =
	| { readonly mode: "none" }
	| { readonly mode: "oidc" }
	| {
			readonly mode: "password";
			readonly passwordHash: string;
			readonly sessionSecret: string;
			readonly idleMs: number;
			readonly maxMs: number;
	  }
	| {
			readonly mode: "users";
			readonly sessionSecret: string;
			readonly idleMs: number;
			readonly maxMs: number;
	  };

export type AuthConfig =
	| { readonly ok: true; readonly settings: AuthSettings }
	| { readonly ok: false; readonly reason: string };

const SETUP_HINT =
	"Set AUTH_PASSWORD_HASH (generate with: pnpm --filter @bitovp/web auth:hash) " +
	"and AUTH_SESSION_SECRET (openssl rand -base64 48). " +
	"AUTH_MODE=none is the deliberate opt-out for local development.";

const NONE_MODE_WARNING =
	"[auth] AUTH_MODE=none — /api/* IS UNAUTHENTICATED. Anyone who can reach " +
	"this server can read and delete encoding jobs, live channels, storage " +
	"credentials and Bitmovin accounts, reveal live stream keys, inject ad " +
	"signals into running channels, start/stop BILLABLE prewarmed encoder " +
	"pools, and WIPE EVERY OPERATIONAL ROW in one request. The reset refuses " +
	"API tokens, and this mode has no token to refuse. " +
	"Use AUTH_MODE=password outside a trusted local machine.";

let warnedNoneMode = false;

/** Once per process — a per-request warning would just train people to ignore it. */
function warnNoneModeOnce(log: (message: string) => void): void {
	if (warnedNoneMode) {
		return;
	}
	warnedNoneMode = true;
	log(NONE_MODE_WARNING);
}

/** Test seam: the once-per-process latch would hide the warning from later tests. */
export function resetNoneModeWarning(): void {
	warnedNoneMode = false;
}

/** `Record`, not `NodeJS.ProcessEnv`: next-env.d.ts makes NODE_ENV required there. */
export type EnvSource = Record<string, string | undefined>;

export function loadAuthConfig(
	source: EnvSource = process.env,
	log: (message: string) => void = console.warn,
): AuthConfig {
	// Blank means "unset" here too — copying .env.example must not brick auth.
	const cleaned = Object.fromEntries(
		Object.entries(source).filter(
			([, value]) => value !== undefined && value !== "",
		),
	);
	const parsed = authEnvSchema.safeParse(cleaned);
	if (!parsed.success) {
		return {
			ok: false,
			reason: `Invalid auth environment:\n${z.prettifyError(parsed.error)}`,
		};
	}
	const env = parsed.data;
	if (env.AUTH_MODE === "none") {
		warnNoneModeOnce(log);
		return { ok: true, settings: { mode: "none" } };
	}
	if (env.AUTH_MODE === "oidc") {
		// Readiness (and the 503) belong to the OIDC provider — see ./provider.ts.
		return { ok: true, settings: { mode: "oidc" } };
	}
	if (env.AUTH_MODE === "users") {
		if (!env.AUTH_SESSION_SECRET) {
			return {
				ok: false,
				reason:
					"AUTH_MODE=users requires AUTH_SESSION_SECRET (openssl rand -base64 48)",
			};
		}
		if (
			Buffer.byteLength(env.AUTH_SESSION_SECRET, "utf8") <
			MIN_SESSION_SECRET_BYTES
		) {
			return {
				ok: false,
				reason:
					`AUTH_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_BYTES} bytes ` +
					"(openssl rand -base64 48)",
			};
		}
		// TLS rail (#32 §3c): per-user passwords must never ride cleartext.
		// The commitment is CONFIGURATION — an https PUBLIC_BASE_URL — so the
		// refusal exists before any request can carry a password. The escape
		// hatch has to be typed out, mirroring AUTH_MODE=none's contract.
		const httpsCommitted = (env.PUBLIC_BASE_URL ?? "")
			.toLowerCase()
			.startsWith("https://");
		if (!httpsCommitted && env.AUTH_ALLOW_INSECURE_HTTP !== "true") {
			return {
				ok: false,
				reason:
					"AUTH_MODE=users refuses to run without TLS: set PUBLIC_BASE_URL to the " +
					"https:// origin (or, for a trusted local network ONLY, type out " +
					"AUTH_ALLOW_INSECURE_HTTP=true — per-user passwords would transit cleartext)",
			};
		}
		return {
			ok: true,
			settings: {
				mode: "users",
				sessionSecret: env.AUTH_SESSION_SECRET,
				idleMs: env.AUTH_SESSION_IDLE_MINUTES * 60_000,
				maxMs: env.AUTH_SESSION_MAX_HOURS * 3_600_000,
			},
		};
	}
	const missing: string[] = [];
	if (!env.AUTH_PASSWORD_HASH) {
		missing.push("AUTH_PASSWORD_HASH");
	}
	if (!env.AUTH_SESSION_SECRET) {
		missing.push("AUTH_SESSION_SECRET");
	}
	if (missing.length > 0) {
		return {
			ok: false,
			reason: `AUTH_MODE=password requires ${missing.join(" and ")}. ${SETUP_HINT}`,
		};
	}
	const passwordHash = env.AUTH_PASSWORD_HASH as string;
	const sessionSecret = env.AUTH_SESSION_SECRET as string;
	// The SAME validator verification uses, so a hash that reaches a request is
	// one config already accepted. The old shape-only regex accepted
	// `scrypt$16384$8$1$AA==$AA==`, a well-formed string with a one-byte digest
	// that made ~1 password in 256 sign in — the check existed and did not check
	// the thing that mattered.
	const hash = parsePasswordHash(passwordHash);
	if (!hash.ok) {
		return {
			ok: false,
			reason:
				`AUTH_PASSWORD_HASH is not a usable scrypt hash (${hash.reason}). ` +
				"Regenerate with: pnpm --filter @bitovp/web auth:hash",
		};
	}
	if (Buffer.byteLength(sessionSecret, "utf8") < MIN_SESSION_SECRET_BYTES) {
		return {
			ok: false,
			reason:
				`AUTH_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_BYTES} bytes ` +
				"(openssl rand -base64 48)",
		};
	}
	return {
		ok: true,
		settings: {
			mode: "password",
			passwordHash,
			sessionSecret,
			idleMs: env.AUTH_SESSION_IDLE_MINUTES * 60_000,
			maxMs: env.AUTH_SESSION_MAX_HOURS * 3_600_000,
		},
	};
}
