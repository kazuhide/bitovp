import { describe, expect, it, vi } from "vitest";
import {
	assertSecretEgressAllowed,
	checkSecretEgressHosts,
	type EgressSite,
	parseSecretEgressAllowlist,
	type SecretEgressAllowlist,
	SecretEgressBlockedError,
	SecretEgressConfigError,
} from "./egress";
import type { PlanIssue } from "./validate";

const site = (url: string): EgressSite => ({
	field: "kantar.serverUrl",
	url,
	carries: "the Kantar watermarking login and password",
});

function run(
	url: string,
	allowlist: SecretEgressAllowlist,
): { codes: string[]; issues: PlanIssue[] } {
	const issues: PlanIssue[] = [];
	checkSecretEgressHosts([site(url)], allowlist, issues);
	return { codes: issues.map((i) => i.code), issues };
}

describe("checkSecretEgressHosts", () => {
	describe("the three caller states are three different behaviours", () => {
		it("undefined emits nothing — the caller is not the enforcement point", () => {
			// The client-side wizard preview cannot read server env. Silence beats
			// a warning whose answer this caller does not have.
			expect(run("https://anything.example.com/x", undefined).codes).toEqual(
				[],
			);
		});

		it("[] warns — the operator configured no restriction", () => {
			const { codes, issues } = run("https://kantar.example.com/x", []);
			expect(codes).toEqual(["PLAN_SECRET_EGRESS_HOST_UNRESTRICTED"]);
			expect(issues[0]?.level).toBe("warning");
			// The warning must name the host and the material, or it reads as noise.
			expect(issues[0]?.message).toContain("kantar.example.com");
			expect(issues[0]?.message).toContain("login and password");
			expect(issues[0]?.path).toBe("kantar.serverUrl");
		});

		it("a non-empty list errors on a host that is not on it", () => {
			const { codes, issues } = run("https://attacker.example.net/x", [
				"kantar.example.com",
			]);
			expect(codes).toEqual(["PLAN_SECRET_EGRESS_HOST_NOT_ALLOWED"]);
			expect(issues[0]?.level).toBe("error");
			expect(issues[0]?.message).toContain("attacker.example.net");
		});

		it("a non-empty list is SILENT on an allowed host", () => {
			// No warning either: the operator answered the question.
			expect(
				run("https://kantar.example.com/x", ["kantar.example.com"]).codes,
			).toEqual([]);
		});
	});

	describe("host matching", () => {
		const cases: {
			name: string;
			url: string;
			allow: string[];
			allowed: boolean;
		}[] = [
			{
				name: "exact hostname",
				url: "https://kantar.example.com/wm",
				allow: ["kantar.example.com"],
				allowed: true,
			},
			{
				name: "hostname match ignores case on both sides",
				url: "https://Kantar.Example.COM/wm",
				allow: ["KANTAR.example.com"],
				allowed: true,
			},
			{
				name: "hostname match ignores the port",
				url: "https://kantar.example.com:8443/wm",
				allow: ["kantar.example.com"],
				allowed: true,
			},
			{
				name: "path and query do not affect the host decision",
				url: "https://kantar.example.com/wm?tenant=jp#frag",
				allow: ["kantar.example.com"],
				allowed: true,
			},
			{
				name: "leading-dot entry matches a subdomain",
				url: "https://jp.kantar.example.com/wm",
				allow: [".kantar.example.com"],
				allowed: true,
			},
			{
				name: "leading-dot entry matches a DEEP subdomain",
				url: "https://a.b.kantar.example.com/wm",
				allow: [".kantar.example.com"],
				allowed: true,
			},
			{
				name: "leading-dot entry does NOT match the apex",
				// Documented: `.example.com` is written to cover per-tenant hosts;
				// including the apex would widen the grant beyond what was typed.
				url: "https://kantar.example.com/wm",
				allow: [".kantar.example.com"],
				allowed: false,
			},
			{
				name: "suffix confusion: evil-example.com is not example.com",
				url: "https://evilexample.com/wm",
				allow: ["example.com"],
				allowed: false,
			},
			{
				name: "suffix confusion: a dot-entry cannot be satisfied by a lookalike apex",
				url: "https://notkantar.example.com.attacker.net/wm",
				allow: [".kantar.example.com"],
				allowed: false,
			},
			{
				name: "prefix confusion: kantar.example.com.attacker.net is not allowed",
				url: "https://kantar.example.com.attacker.net/wm",
				allow: ["kantar.example.com"],
				allowed: false,
			},
			{
				name: "userinfo cannot smuggle the allowlisted host into the auth section",
				// `secretEgressUrlSchema` already rejects userinfo, but the matcher
				// must not be the thing relying on that: URL parsing puts this
				// host at attacker.net, not kantar.example.com.
				url: "https://kantar.example.com@attacker.net/wm",
				allow: ["kantar.example.com"],
				allowed: false,
			},
			{
				name: "a subdomain is not allowed by the apex entry alone",
				url: "https://jp.kantar.example.com/wm",
				allow: ["kantar.example.com"],
				allowed: false,
			},
			{
				name: "any one matching entry in a longer list is enough",
				url: "https://pois.example.org/esam",
				allow: ["kantar.example.com", ".vendor.example", "pois.example.org"],
				allowed: true,
			},
			{
				name: "an IP literal matches when listed exactly",
				url: "https://10.0.0.5/wm",
				allow: ["10.0.0.5"],
				allowed: true,
			},
		];

		for (const { name, url, allow, allowed } of cases) {
			it(`${allowed ? "allows" : "rejects"}: ${name}`, () => {
				expect(run(url, allow).codes).toEqual(
					allowed ? [] : ["PLAN_SECRET_EGRESS_HOST_NOT_ALLOWED"],
				);
			});
		}
	});

	describe("degenerate inputs", () => {
		it("an unparsable URL is skipped — the schema already reported it", () => {
			// Reporting it twice buries the real problem.
			expect(run("not a url", ["kantar.example.com"]).codes).toEqual([]);
		});

		it("blank allowlist entries never match", () => {
			// A list of nothing-but-blanks is non-empty, so it must still ERROR
			// rather than degrade into the permissive warning path.
			expect(run("https://kantar.example.com/x", ["", "   "]).codes).toEqual([
				"PLAN_SECRET_EGRESS_HOST_NOT_ALLOWED",
			]);
		});

		it("a bare '.' entry does not match everything", () => {
			expect(run("https://attacker.example.net/x", ["."]).codes).toEqual([
				"PLAN_SECRET_EGRESS_HOST_NOT_ALLOWED",
			]);
		});

		it("no egress sites means no issues, whatever the allowlist", () => {
			const issues: PlanIssue[] = [];
			checkSecretEgressHosts([], [], issues);
			expect(issues).toEqual([]);
		});

		it("reports one issue per site, not one per plan", () => {
			const issues: PlanIssue[] = [];
			checkSecretEgressHosts(
				[
					{ field: "kantar.serverUrl", url: "https://a.bad/x", carries: "K" },
					{
						field: "start.esam.poisEndpoint",
						url: "https://b.bad/x",
						carries: "P",
					},
				],
				["good.example.com"],
				issues,
			);
			expect(issues.map((i) => i.path)).toEqual([
				"kantar.serverUrl",
				"start.esam.poisEndpoint",
			]);
		});
	});
});

describe("parseSecretEgressAllowlist", () => {
	it("returns [] for unset — which is the CONFIGURED-but-empty state", () => {
		// Callers that read env always pass an array; the "not the enforcement
		// point" state is expressed by not passing the option at all.
		expect(parseSecretEgressAllowlist(undefined)).toEqual([]);
		expect(parseSecretEgressAllowlist("")).toEqual([]);
		expect(parseSecretEgressAllowlist("   ")).toEqual([]);
	});

	it("splits, trims, lowercases and drops blanks", () => {
		expect(
			parseSecretEgressAllowlist(" Kantar.Example.com , .vendor.example ,, "),
		).toEqual(["kantar.example.com", ".vendor.example"]);
	});

	it("a trailing comma cannot produce a match-nothing entry", () => {
		expect(parseSecretEgressAllowlist("a.example.com,")).toEqual([
			"a.example.com",
		]);
	});
});

describe("host normalization (review catches)", () => {
	it("a trailing-dot FQDN matches a dotless entry", () => {
		// `kantar.example.com.` passes secretEgressUrlSchema and URL preserves the
		// dot, so without normalization the operator's entry misses by one
		// near-invisible character. Fails closed — but a false rejection is what
		// makes an operator turn the rail off entirely.
		expect(
			run("https://kantar.example.com./wm", ["kantar.example.com"]).codes,
		).toEqual([]);
	});

	it("a trailing dot in the ENTRY matches a dotless host", () => {
		expect(
			run("https://kantar.example.com/wm", ["kantar.example.com."]).codes,
		).toEqual([]);
	});

	it("a trailing dot cannot widen a suffix entry to the apex", () => {
		// The apex exclusion must survive normalization in both directions.
		expect(
			run("https://kantar.example.com./wm", [".kantar.example.com"]).codes,
		).toEqual(["PLAN_SECRET_EGRESS_HOST_NOT_ALLOWED"]);
	});

	it("an IDN entry matches its punycode host", () => {
		// URL.hostname always yields punycode; a raw-compared entry would give a
		// permanent rejection naming a host the operator never typed.
		expect(run("https://exämple.com/wm", ["exämple.com"]).codes).toEqual([]);
		expect(run("https://exämple.com/wm", ["xn--exmple-cua.com"]).codes).toEqual(
			[],
		);
	});

	it("an IDN suffix entry matches a punycode subdomain", () => {
		expect(run("https://a.exämple.com/wm", [".exämple.com"]).codes).toEqual([]);
	});

	it("REFUSES a malformed entry instead of resolving it to another host", () => {
		// Routing entries through `new URL` to fix IDN made them inherit URL
		// parsing: `example.com/evil` silently drops the path and
		// `example.com@evil.net` silently GRANTS evil.net. Before that, malformed
		// entries matched nothing; silently resolving to a host the operator never
		// typed is the same defect class as an allowlist that lists nothing, so it
		// gets the same treatment (review catch).
		for (const bad of [
			"not a host/path",
			"example.com/evil",
			"example.com@evil.net",
			"https://example.com",
			"example.com:8443",
		]) {
			expect(() => run("https://kantar.example.com/wm", [bad]), bad).toThrow(
				SecretEgressConfigError,
			);
		}
	});

	it("still accepts a bracketed IPv6 literal, whose colons are legitimate", () => {
		expect(run("https://[2001:db8::1]/wm", ["[2001:db8::1]"]).codes).toEqual(
			[],
		);
		expect(run("https://[2001:db8::2]/wm", ["[2001:db8::1]"]).codes).toEqual([
			"PLAN_SECRET_EGRESS_HOST_NOT_ALLOWED",
		]);
	});
});

describe("parseSecretEgressAllowlist — configured-but-empty is an error", () => {
	it("throws when the value lists no hostnames", () => {
		// [] would be indistinguishable from "operator declined to restrict" and
		// would downgrade enforcement from error to warning on a typo.
		expect(() => parseSecretEgressAllowlist(",")).toThrow(
			SecretEgressConfigError,
		);
		expect(() => parseSecretEgressAllowlist(" , , ")).toThrow(
			/lists no hostnames/,
		);
	});

	it("still treats a genuinely absent value as unrestricted", () => {
		expect(parseSecretEgressAllowlist(undefined)).toEqual([]);
		expect(parseSecretEgressAllowlist("")).toEqual([]);
		expect(parseSecretEgressAllowlist("   ")).toEqual([]);
	});
});

describe("assertSecretEgressAllowed — worker-side enforcement", () => {
	/**
	 * The rail the review found missing: several routes replay an
	 * already-persisted plan into the queue without revalidating it, so
	 * create-time validation alone let a plan authored before the allowlist was
	 * configured reach the encoder unchecked.
	 */
	const kantar: EgressSite = {
		field: "kantar.serverUrl",
		url: "https://attacker.example.net/wm",
		carries: "the Kantar watermarking login and password",
	};

	it("THROWS on a host outside a configured allowlist", () => {
		const warn = vi.fn();
		expect(() =>
			assertSecretEgressAllowed([kantar], ["kantar.example.com"], warn),
		).toThrow(SecretEgressBlockedError);
		expect(warn).not.toHaveBeenCalled();
	});

	it("names the field and the host, so the failure is actionable", () => {
		expect(() =>
			assertSecretEgressAllowed([kantar], ["kantar.example.com"], vi.fn()),
		).toThrow(/kantar\.serverUrl.*attacker\.example\.net/s);
	});

	it("warns but does NOT throw when no allowlist is configured", () => {
		const warn = vi.fn();
		expect(() => assertSecretEgressAllowed([kantar], [], warn)).not.toThrow();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("attacker.example.net");
	});

	it("is silent for an allowed host", () => {
		const warn = vi.fn();
		assertSecretEgressAllowed(
			[{ ...kantar, url: "https://kantar.example.com/wm" }],
			["kantar.example.com"],
			warn,
		);
		expect(warn).not.toHaveBeenCalled();
	});

	it("does nothing when there is no egress site", () => {
		const warn = vi.fn();
		assertSecretEgressAllowed([], ["kantar.example.com"], warn);
		expect(warn).not.toHaveBeenCalled();
	});
});
