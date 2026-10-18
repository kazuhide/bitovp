import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "./instrumentation";

/**
 *  §3c / review-32 M5 — the TLS boot rail. sec-M10's whole
 * resolution is that users mode REFUSES TO BOOT without a TLS commitment,
 * and proxy.ts M1's fail-closed depends on this abort actually happening.
 * "Correct as far as I can read" is the evidence tier this repo rejects, so
 * the three arms are pinned: users+http throws, users+https resolves,
 * password never even reads config.
 */

const HASH =
	"scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=";
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
	vi.stubEnv("NEXT_RUNTIME", "nodejs");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("register() TLS boot rail", () => {
	it("users mode over plain http REFUSES to boot", async () => {
		vi.stubEnv("AUTH_MODE", "users");
		vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
		// No https PUBLIC_BASE_URL, no typed-out escape hatch.
		await expect(register()).rejects.toThrow(/refusing to start/);
	});

	it("users mode with an https PUBLIC_BASE_URL boots", async () => {
		vi.stubEnv("AUTH_MODE", "users");
		vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
		vi.stubEnv("PUBLIC_BASE_URL", "https://ovp.example.com");
		await expect(register()).resolves.toBeUndefined();
	});

	it("users mode with the typed-out insecure escape hatch boots", async () => {
		vi.stubEnv("AUTH_MODE", "users");
		vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
		vi.stubEnv("AUTH_ALLOW_INSECURE_HTTP", "true");
		await expect(register()).resolves.toBeUndefined();
	});

	it("password mode boots regardless of TLS — the rail is users-only", async () => {
		vi.stubEnv("AUTH_MODE", "password");
		vi.stubEnv("AUTH_PASSWORD_HASH", HASH);
		vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
		await expect(register()).resolves.toBeUndefined();
	});

	it("the edge runtime is a no-op — the rail is a node-boot concern", async () => {
		vi.stubEnv("NEXT_RUNTIME", "edge");
		vi.stubEnv("AUTH_MODE", "users");
		// Would throw on nodejs; the edge early-return means it does not.
		await expect(register()).resolves.toBeUndefined();
	});
});
