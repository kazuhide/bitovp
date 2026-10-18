import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatSmoke, type SmokeResult, smokeConfigFromEnv } from "./smoke";

/**
 * The smoke's own output, which is the whole product: a person reads it at 02:00 to learn
 * which variable to set. `verifySmoke` itself is deliberately NOT unit-tested against a fake
 * — a fake would be another injected seam, and the entire reason this command exists is that
 * the injected seams could not see the real one. Its correctness is established by RUNNING
 * it, which found two defects in itself on the first attempt.
 */
describe("formatSmoke", () => {
	function result(steps: SmokeResult["steps"]): SmokeResult {
		return { steps, ok: steps.every((s) => s.ok) };
	}

	it("prints the fix for a failing step, so the reader does not have to go and find it", () => {
		const text = formatSmoke(
			result([
				{ name: "reach the product", ok: true, detail: "200 ok" },
				{
					name: "authenticated read",
					ok: false,
					detail: "GET /api/encoding-jobs → 401",
					fix: "set VERIFY_PASSWORD",
				},
			]),
		);
		expect(text).toContain("FAIL  authenticated read");
		expect(text).toContain("fix: set VERIFY_PASSWORD");
		expect(text).toContain("STOP.");
	});

	it("does not print a fix for a step that passed", () => {
		const text = formatSmoke(
			result([
				{ name: "a", ok: true, detail: "fine", fix: "should not appear" },
			]),
		);
		expect(text).not.toContain("should not appear");
	});

	it("says plainly that results will mean something when everything passed", () => {
		const text = formatSmoke(result([{ name: "a", ok: true, detail: "fine" }]));
		expect(text).toContain("will mean something");
		expect(text).not.toContain("STOP.");
	});

	it("reports the observation verbatim, never a paraphrase", () => {
		// The failure's own words are the diagnostic. "Host is not allowed" is what took
		// months to find; a summary like "connection problem" would have taken longer.
		const text = formatSmoke(
			result([
				{
					name: "reach the product",
					ok: false,
					detail:
						'http://web:3100 rejected the Host header: {"error":"Host is not allowed"}',
					fix: "add it to ALLOWED_ORIGIN_HOSTS",
				},
			]),
		);
		expect(text).toContain('{"error":"Host is not allowed"}');
	});
});

/**
 * Where the SMOKE may send its credential (review of this PR).
 *
 * The origin allowlist (re-audit HIGH-6) was wired into `verify
 * run` only, and `verify smoke` — which  says "runs first
 * in the nightly", and which POSTs `VERIFY_PASSWORD` to `/api/auth/login` and
 * sends `VERIFY_API_TOKEN` as a Bearer — built its base URL straight out of the
 * environment. So every night the real credentials crossed the unchecked path
 * before the checked one ran. These are the smoke's OWN refusals, not the
 * runner's.
 */
describe("smokeConfigFromEnv", () => {
	const allowed = { VERIFY_ALLOWED_ORIGINS: "https://ovp.example.com" };

	it("defaults to loopback and resolves", () => {
		const resolved = smokeConfigFromEnv({});
		expect(resolved.ok).toBe(true);
		expect(resolved.ok && resolved.config.baseUrl).toBe(
			"http://127.0.0.1:3100",
		);
	});

	it("refuses plaintext HTTP to a non-loopback host, in the policy's own words", () => {
		// Allowlisted AS PLAINTEXT, so the refusal that fires is the scheme one
		// and not the origin one — an allowlist entry is an exact origin, and
		// `https://ovp.example.com` does not cover `http://ovp.example.com:3100`.
		const resolved = smokeConfigFromEnv({
			VERIFY_BASE_URL: "http://ovp.example.com:3100",
			VERIFY_ALLOWED_ORIGINS: "http://ovp.example.com:3100",
			VERIFY_PASSWORD: "hunter2",
		});
		expect(resolved.ok).toBe(false);
		expect(resolved.ok ? "" : resolved.reason).toMatch(/plaintext HTTP/);
		expect(resolved.ok ? "" : resolved.reason).toMatch(
			/VERIFY_ALLOW_INSECURE_BASE_URL/,
		);
	});

	it("refuses an https origin nobody allowlisted — a typo is a credential leak", () => {
		const resolved = smokeConfigFromEnv({
			VERIFY_BASE_URL: "https://evil.example.com",
			...allowed,
			VERIFY_API_TOKEN: "tok",
		});
		expect(resolved.ok).toBe(false);
		expect(resolved.ok ? "" : resolved.reason).toMatch(
			/VERIFY_ALLOWED_ORIGINS/,
		);
	});

	it("accepts an allowlisted origin and carries the credential and storage config", () => {
		const resolved = smokeConfigFromEnv({
			VERIFY_BASE_URL: "https://ovp.example.com/ovp/",
			...allowed,
			VERIFY_PASSWORD: "hunter2",
			VERIFY_S3_INPUT_BUCKET: "in-bucket",
			VERIFY_SOURCE_OBJECT: "mezz.mov",
		});
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) {
			return;
		}
		// The path is kept and the trailing slash dropped — the smoke appends
		// `/api/health` to this.
		expect(resolved.config.baseUrl).toBe("https://ovp.example.com/ovp");
		expect(resolved.config.password).toBe("hunter2");
		expect(resolved.config.inputBucket).toBe("in-bucket");
		expect(resolved.config.sourceObject).toBe("mezz.mov");
	});

	it("the explicit dangerous override still works, and only when it is set", () => {
		const url = "https://anywhere.example.com";
		expect(smokeConfigFromEnv({ VERIFY_BASE_URL: url }).ok).toBe(false);
		expect(
			smokeConfigFromEnv({ VERIFY_BASE_URL: url, VERIFY_ALLOW_ANY_ORIGIN: "1" })
				.ok,
		).toBe(true);
	});
});

/**
 * The CLI branch is a two-line adapter, like `clean` — and nothing else can
 * be: a branch in `scripts/verify.ts` IS the wiring, and no test runs it. So
 * the pin is that the raw environment read happens in exactly ONE place, and
 * that this file reaches it through `smokeConfigFromEnv`.
 */
describe("the `verify smoke` command is wired through the shared policy", () => {
	const cli = readFileSync(
		new URL("../../scripts/verify.ts", import.meta.url),
		"utf8",
	);

	it("builds its config from smokeConfigFromEnv and refuses on the policy's reason", () => {
		expect(cli).toContain("smokeConfigFromEnv(process.env)");
		expect(cli).toContain("[smoke] refusing to start:");
		expect(cli).toMatch(/if \(!resolved\.ok\)/);
	});

	it("reads VERIFY_BASE_URL nowhere itself — the bypass this fixes", () => {
		expect(cli).not.toMatch(/env\.VERIFY_BASE_URL/);
	});
});
