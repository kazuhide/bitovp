import { beforeEach, describe, expect, it, vi } from "vitest";
import { type EnvSource, loadAuthConfig, resetNoneModeWarning } from "./config";
import { hashPassword } from "./password";
import { resolveProvider } from "./provider";

const HASH = hashPassword("a-strong-team-password");
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
	resetNoneModeWarning();
});

describe("loadAuthConfig", () => {
	it("defaults to password mode and FAILS CLOSED with nothing configured", () => {
		const config = loadAuthConfig({});
		expect(config.ok).toBe(false);
		if (config.ok) {
			return;
		}
		expect(config.reason).toContain("AUTH_MODE=password requires");
		expect(config.reason).toContain("AUTH_PASSWORD_HASH");
		expect(config.reason).toContain("AUTH_SESSION_SECRET");
		// The operator must be told that opening the install is a deliberate act.
		expect(config.reason).toContain("AUTH_MODE=none");
	});

	const invalid: [name: string, env: EnvSource, expect: string][] = [
		[
			"only the hash",
			{ AUTH_PASSWORD_HASH: HASH },
			"requires AUTH_SESSION_SECRET",
		],
		[
			"only the secret",
			{ AUTH_SESSION_SECRET: SECRET },
			"requires AUTH_PASSWORD_HASH",
		],
		[
			"blank values (a copied .env.example)",
			{ AUTH_PASSWORD_HASH: "", AUTH_SESSION_SECRET: "" },
			"AUTH_MODE=password requires",
		],
		[
			"a bcrypt-shaped hash",
			{ AUTH_PASSWORD_HASH: "$2b$12$abcdef", AUTH_SESSION_SECRET: SECRET },
			"not a usable scrypt hash",
		],
		[
			"a plaintext password in the hash slot",
			{ AUTH_PASSWORD_HASH: "hunter2", AUTH_SESSION_SECRET: SECRET },
			"not a usable scrypt hash",
		],
		[
			"a 31-byte session secret",
			{ AUTH_PASSWORD_HASH: HASH, AUTH_SESSION_SECRET: "a".repeat(31) },
			"at least 32 bytes",
		],
		[
			"an unknown AUTH_MODE",
			{
				AUTH_MODE: "basic",
				AUTH_PASSWORD_HASH: HASH,
				AUTH_SESSION_SECRET: SECRET,
			},
			"Invalid auth environment",
		],
		[
			"a non-numeric idle window",
			{
				AUTH_PASSWORD_HASH: HASH,
				AUTH_SESSION_SECRET: SECRET,
				AUTH_SESSION_IDLE_MINUTES: "forever",
			},
			"Invalid auth environment",
		],
	];

	for (const [name, env, expected] of invalid) {
		it(`fails closed on ${name}`, () => {
			const config = loadAuthConfig(env);
			expect(config.ok).toBe(false);
			if (!config.ok) {
				expect(config.reason).toContain(expected);
			}
		});
	}

	it("accepts a complete password configuration with sane defaults", () => {
		const config = loadAuthConfig({
			AUTH_PASSWORD_HASH: HASH,
			AUTH_SESSION_SECRET: SECRET,
		});
		expect(config).toEqual({
			ok: true,
			settings: {
				mode: "password",
				passwordHash: HASH,
				sessionSecret: SECRET,
				idleMs: 720 * 60_000,
				maxMs: 168 * 3_600_000,
			},
		});
	});

	it("honours the session-window overrides", () => {
		const config = loadAuthConfig({
			AUTH_PASSWORD_HASH: HASH,
			AUTH_SESSION_SECRET: SECRET,
			AUTH_SESSION_IDLE_MINUTES: "30",
			AUTH_SESSION_MAX_HOURS: "8",
		});
		expect(config.ok && config.settings).toMatchObject({
			idleMs: 30 * 60_000,
			maxMs: 8 * 3_600_000,
		});
	});

	it("warns LOUDLY once for AUTH_MODE=none, naming what is exposed", () => {
		const log = vi.fn();
		const config = loadAuthConfig({ AUTH_MODE: "none" }, log);
		expect(config).toEqual({ ok: true, settings: { mode: "none" } });
		expect(log).toHaveBeenCalledTimes(1);
		const warning = log.mock.calls[0]?.[0] as string;
		expect(warning).toContain("UNAUTHENTICATED");
		expect(warning).toContain("stream keys");
		expect(warning).toContain("BILLABLE");

		loadAuthConfig({ AUTH_MODE: "none" }, log);
		expect(log).toHaveBeenCalledTimes(1);
	});

	it("accepts AUTH_MODE=oidc as a config, but its provider is not ready", () => {
		const config = loadAuthConfig({ AUTH_MODE: "oidc" });
		expect(config).toEqual({ ok: true, settings: { mode: "oidc" } });
		if (!config.ok) {
			return;
		}
		const readiness = resolveProvider(config.settings).readiness();
		expect(readiness.ready).toBe(false);
		if (!readiness.ready) {
			expect(readiness.reason).toContain("no OIDC provider is implemented");
		}
	});
});

describe("resolveProvider", () => {
	it("verifies the shared password and rejects everything else", async () => {
		const provider = resolveProvider({
			mode: "password",
			passwordHash: HASH,
			sessionSecret: SECRET,
			idleMs: 60_000,
			maxMs: 600_000,
		});
		expect(provider.loginKind).toBe("password-form");
		await expect(
			provider.verify({ password: "a-strong-team-password" }),
		).resolves.toEqual({ ok: true });
		await expect(provider.verify({ password: "wrong" })).resolves.toEqual({
			ok: false,
			status: 401,
			error: "Invalid password",
		});
		await expect(provider.verify({})).resolves.toMatchObject({
			ok: false,
			status: 400,
		});
	});

	it("never authenticates through the OIDC seam", async () => {
		const provider = resolveProvider({ mode: "oidc" });
		expect(provider.loginKind).toBe("idp-redirect");
		await expect(
			provider.verify({ password: "anything" }),
		).resolves.toMatchObject({ ok: false, status: 503 });
	});

	it("reports mode none as ready but unusable for sign-in", async () => {
		const provider = resolveProvider({ mode: "none" });
		expect(provider.readiness()).toEqual({ ready: true });
		expect(provider.loginKind).toBe("disabled");
		await expect(provider.verify({ password: "x" })).resolves.toMatchObject({
			ok: false,
			status: 400,
		});
	});
});
