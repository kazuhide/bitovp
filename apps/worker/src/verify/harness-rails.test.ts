import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	assertFreshRun,
	awaitStatus,
	baseUrlPolicy,
	createSubmitBudget,
	defaultRunId,
	ensureTerminal,
	isProviderEncodingTerminal,
	pickAccount,
	pickByLabel,
	positiveInt,
	prepareRunDir,
	resolveBaseUrl,
	resumeEligibility,
	sealReport,
	validateRunId,
	verifyReportSeal,
} from "./harness-rails";

/**
 * Paid audit 893eb66 BLOCKER-3 / BLOCKER-4 / HIGH-11 : every rail
 * the harness lacked, as a table. Each arm is a value the audit either sent
 * or could have sent, and the rule's answer to it.
 */

describe("validateRunId", () => {
	it.each(["2026-08-28T09-00-00", "run.42", "a_b-c"])("accepts %s", (id) => {
		expect(validateRunId(id)).toBe(id);
	});
	it.each([
		["a path escape", "../../etc"],
		["a slash", "a/b"],
		["a leading dot", ".hidden"],
		["empty", ""],
		["a space", "run 1"],
		["a dotdot inside", "a..b"],
		["too long", "x".repeat(65)],
	])("refuses %s", (_what, id) => {
		expect(() => validateRunId(id)).toThrow(/not a run id/);
	});
});

describe("positiveInt", () => {
	it("returns the default when the flag is absent", () => {
		expect(positiveInt("max-submits", undefined, 7)).toBe(7);
	});
	it("parses a plain positive integer", () => {
		expect(positiveInt("timeout-ms", "900000", 1)).toBe(900000);
	});
	it.each([
		"abc",
		"NaN",
		"Infinity",
		"0",
		"-5",
		"1.5",
		"1e3",
		"",
	])("refuses %j instead of failing open", (raw) => {
		expect(() => positiveInt("max-submits", raw, 3)).toThrow(
			/not a positive integer/,
		);
	});
});

describe("baseUrlPolicy", () => {
	it.each([
		"http://127.0.0.1:3100",
		"http://localhost:3100",
		"http://[::1]:3100",
	])("allows loopback %s", (url) => {
		expect(baseUrlPolicy(url).ok).toBe(true);
	});
	it("refuses an HTTPS origin that is not allowlisted — the credential would go to whoever owns the name (re-audit HIGH-6)", () => {
		const verdict = baseUrlPolicy("https://ovp.example.com");
		expect(verdict.ok).toBe(false);
		expect(verdict.ok ? "" : verdict.reason).toMatch(/VERIFY_ALLOWED_ORIGINS/);
	});
	it("allows an HTTPS origin named in the allowlist, matched as an ORIGIN (scheme + host + port)", () => {
		const allowed = ["https://ovp.example.com"];
		expect(
			baseUrlPolicy("https://ovp.example.com", { allowedOrigins: allowed }),
		).toEqual({
			ok: true,
			url: "https://ovp.example.com",
		});
		expect(
			baseUrlPolicy("https://ovp.example.com:8443", { allowedOrigins: allowed })
				.ok,
		).toBe(false);
		expect(
			baseUrlPolicy("https://evil.example.com", { allowedOrigins: allowed }).ok,
		).toBe(false);
		expect(
			baseUrlPolicy("https://ovp.example.com", {
				allowedOrigins: ["not a url"],
			}).ok,
		).toBe(false);
	});
	it("allows any origin only under the explicit any-origin override", () => {
		expect(
			baseUrlPolicy("https://ovp.example.com", { allowAnyOrigin: true }).ok,
		).toBe(true);
	});
	it("refuses plaintext HTTP to a remote host even when the origin is allowlisted — the credential would travel in the clear", () => {
		const verdict = baseUrlPolicy("http://ovp.example.com:3100", {
			allowedOrigins: ["http://ovp.example.com:3100"],
		});
		expect(verdict.ok).toBe(false);
		expect(verdict.ok ? "" : verdict.reason).toMatch(/plaintext HTTP/);
	});
	it("allows remote plaintext only under BOTH the insecure override and an allowlisted origin", () => {
		expect(
			baseUrlPolicy("http://10.0.0.5:3100", {
				allowInsecure: true,
				allowedOrigins: ["http://10.0.0.5:3100"],
			}).ok,
		).toBe(true);
		expect(
			baseUrlPolicy("http://10.0.0.5:3100", { allowInsecure: true }).ok,
		).toBe(false);
	});
	it.each([
		["userinfo", "https://user:pw@ovp.example.com"],
		["a non-http scheme", "ftp://ovp.example.com"],
		["not a URL", "ovp.example.com"],
		["a query", "https://ovp.example.com/?x=1"],
		["a fragment", "https://ovp.example.com/#x"],
	])("refuses %s", (_what, url) => {
		expect(baseUrlPolicy(url).ok).toBe(false);
	});
	it("keeps a base path — a subpath deployment is not its origin (review-327 S1)", () => {
		const allowedOrigins = ["https://ovp.example.com"];
		expect(
			baseUrlPolicy("https://ovp.example.com/ovp/", { allowedOrigins }),
		).toEqual({
			ok: true,
			url: "https://ovp.example.com/ovp",
		});
		expect(
			baseUrlPolicy("https://ovp.example.com", { allowedOrigins }),
		).toEqual({
			ok: true,
			url: "https://ovp.example.com",
		});
		expect(baseUrlPolicy("http://127.0.0.1:3100/")).toEqual({
			ok: true,
			url: "http://127.0.0.1:3100",
		});
	});
});

/**
 * The env half of the same rule, and the reason it is a function at all.
 *
 * `baseUrlPolicy` was called from `main` only, so `verify run` was fixed and
 * `verify smoke` — the command the nightly runs FIRST, which posts
 * VERIFY_PASSWORD and sends VERIFY_API_TOKEN — read `VERIFY_BASE_URL` itself
 * and sent the credential to an unchecked origin (review of this PR). A rule
 * every caller must remember to invoke is a rule one caller will not.
 */
describe("resolveBaseUrl — one reading of the environment, for every command", () => {
	it("defaults to the worker's own loopback", () => {
		expect(resolveBaseUrl({})).toEqual({
			ok: true,
			url: "http://127.0.0.1:3100",
		});
	});

	it("refuses a non-allowlisted https origin and names the variable", () => {
		const verdict = resolveBaseUrl({
			VERIFY_BASE_URL: "https://ovp.example.com",
		});
		expect(verdict.ok).toBe(false);
		expect(verdict.ok ? "" : verdict.reason).toMatch(/VERIFY_ALLOWED_ORIGINS/);
	});

	it("splits and trims VERIFY_ALLOWED_ORIGINS", () => {
		expect(
			resolveBaseUrl({
				VERIFY_BASE_URL: "https://ovp.example.com",
				VERIFY_ALLOWED_ORIGINS:
					" https://other.example.com , https://ovp.example.com ",
			}),
		).toEqual({ ok: true, url: "https://ovp.example.com" });
	});

	it("honours the two explicit overrides, and only when they say 1", () => {
		expect(
			resolveBaseUrl({
				VERIFY_BASE_URL: "https://anywhere.example.com",
				VERIFY_ALLOW_ANY_ORIGIN: "1",
			}).ok,
		).toBe(true);
		expect(
			resolveBaseUrl({
				VERIFY_BASE_URL: "https://anywhere.example.com",
				VERIFY_ALLOW_ANY_ORIGIN: "true",
			}).ok,
		).toBe(false);
		expect(
			resolveBaseUrl({
				VERIFY_BASE_URL: "http://10.0.0.5:3100",
				VERIFY_ALLOW_ANY_ORIGIN: "1",
			}).ok,
		).toBe(false);
		expect(
			resolveBaseUrl({
				VERIFY_BASE_URL: "http://10.0.0.5:3100",
				VERIFY_ALLOW_ANY_ORIGIN: "1",
				VERIFY_ALLOW_INSECURE_BASE_URL: "1",
			}),
		).toEqual({ ok: true, url: "http://10.0.0.5:3100" });
	});
});

describe("resumeEligibility", () => {
	const fp = {
		commit: "abc",
		checkoutLatestMigration: "20260828120000_x",
		dbLatestMigration: "20260828120000_x",
	};
	const current = {
		fingerprint: fp,
		planSha256: "p1",
		sourceObject: "bbb.mov",
		sourceIdentity: 'etag="e1";size=5',
		bitmovinAccountId: "acct-1",
	};
	const pass = {
		verdict: "PASS",
		planSha256: "p1",
		sourceObject: "bbb.mov",
		sourceIdentity: 'etag="e1";size=5',
		bitmovinAccountId: "acct-1",
	};

	it("honours a PASS whose every recorded identity matches", () => {
		expect(
			resumeEligibility(
				{ fingerprint: fp, outcome: pass, runId: "r1" },
				current,
			),
		).toEqual({ honor: true, runId: "r1" });
	});
	it.each([
		[
			"a different commit",
			{ fingerprint: { ...fp, commit: "def" }, outcome: pass },
		],
		[
			"a different DB migration",
			{
				fingerprint: { ...fp, dbLatestMigration: "20260901000000_y" },
				outcome: pass,
			},
		],
		[
			"a different plan",
			{ fingerprint: fp, outcome: { ...pass, planSha256: "p2" } },
		],
		[
			"a different source",
			{ fingerprint: fp, outcome: { ...pass, sourceObject: "other.mov" } },
		],
		[
			"a different account",
			{ fingerprint: fp, outcome: { ...pass, bitmovinAccountId: "acct-2" } },
		],
		[
			"the same source NAME with different bytes (re-audit BLOCKER-3)",
			{
				fingerprint: fp,
				outcome: { ...pass, sourceIdentity: 'etag="e2";size=5' },
			},
		],
		[
			"a prior report whose source identity was unavailable",
			{ fingerprint: fp, outcome: { ...pass, sourceIdentity: "unavailable" } },
		],
		[
			"an unknown commit on the prior side — unknown cannot equal unknown",
			{ fingerprint: { ...fp, commit: "unknown" }, outcome: pass },
		],
		[
			"a prior FAIL",
			{ fingerprint: fp, outcome: { ...pass, verdict: "FAIL" } },
		],
		["no prior outcome", { fingerprint: fp }],
	])("refuses %s", (_what, prior) => {
		const verdict = resumeEligibility(prior as never, current);
		expect(verdict.honor).toBe(false);
	});
	it("refuses a prior report that recorded no identity — an unknown is a reason to spend, not to skip", () => {
		const verdict = resumeEligibility(
			{ fingerprint: fp, outcome: { verdict: "PASS" } },
			current,
		);
		expect(verdict.honor).toBe(false);
		expect(verdict.honor ? "" : verdict.reason).toMatch(
			/predates identity recording/,
		);
		const noFp = resumeEligibility({ outcome: pass }, current);
		expect(noFp.honor).toBe(false);
	});
	it("refuses when the CURRENT commit is unknown, even against a matching 'unknown' prior (re-audit BLOCKER-3)", () => {
		const verdict = resumeEligibility(
			{ fingerprint: { ...fp, commit: "unknown" }, outcome: pass, runId: "r1" },
			{ ...current, fingerprint: { ...fp, commit: "unknown" } },
		);
		expect(verdict.honor).toBe(false);
		expect(verdict.honor ? "" : verdict.reason).toMatch(/unknown/);
	});
	it("refuses when the current source identity is unavailable — a HEAD that failed is not a match", () => {
		const verdict = resumeEligibility(
			{ fingerprint: fp, outcome: pass, runId: "r1" },
			{ ...current, sourceIdentity: "unavailable" },
		);
		expect(verdict.honor).toBe(false);
		expect(verdict.honor ? "" : verdict.reason).toMatch(/unavailable/);
	});
});

describe("ensureTerminal — the PROVIDER's word, not the product's (re-audit BLOCKER-2, ledger #217)", () => {
	it.each([
		"FINISHED",
		"ERROR",
		"CANCELED",
		"TRANSFER_ERROR",
		"NOT_FOUND",
	])("accepts only the explicit provider terminal state %s", (status) => {
		expect(isProviderEncodingTerminal(status)).toBe(true);
	});
	it.each([
		undefined,
		null,
		"UNKNOWN",
		"STOPPED",
		"A_FUTURE_PROVIDER_STATE",
		"PROVIDER_DISCOVERY_PENDING",
		"PROVIDER_IDENTITY_CONFLICT",
		"COMPENSATION_DELETE_PENDING",
	])("fails closed for unknown or synthetic provider status %s", (status) => {
		expect(isProviderEncodingTerminal(status)).toBe(false);
	});

	function clock() {
		let t = 0;
		return {
			now: () => t,
			sleep: async () => {
				t += 10_000;
			},
		};
	}
	it("a local CANCELED with a provider encoding still RUNNING is NOT terminal", async () => {
		const c = clock();
		const result = await ensureTerminal({
			cancel: async () => 202,
			readStatus: async () => "CANCELED",
			readProviderStatuses: async () => [
				{ encodingId: "enc-1", status: "RUNNING" },
			],
			...c,
			budgetMs: 60_000,
		});
		expect(result.localTerminal).toBe(true);
		expect(result.providerTerminal).toBe(false);
		expect(result.terminal).toBe(false);
		expect(result.provider).toEqual([
			{ encodingId: "enc-1", status: "RUNNING" },
		]);
	});
	it.each([
		"COMPENSATION_DELETE_PENDING",
		"PROVIDER_DISCOVERY_PENDING",
		"PROVIDER_IDENTITY_CONFLICT",
	])("treats the fail-closed provider sentinel %s as non-terminal", async (status) => {
		const result = await ensureTerminal({
			cancel: async () => 202,
			readStatus: async () => "CANCELED",
			readProviderStatuses: async () => [{ encodingId: "enc-1", status }],
			...clock(),
			budgetMs: 20_000,
		});
		expect(result.providerTerminal).toBe(false);
		expect(result.terminal).toBe(false);
	});
	it("waits for the provider to settle and then reports terminal", async () => {
		const c = clock();
		let reads = 0;
		const result = await ensureTerminal({
			cancel: async () => 202,
			readStatus: async () => "CANCELED",
			readProviderStatuses: async () => [
				{ encodingId: "enc-1", status: ++reads < 3 ? "RUNNING" : "CANCELED" },
				{ encodingId: "enc-2", status: "FINISHED" },
			],
			...c,
			budgetMs: 60_000,
		});
		expect(reads).toBeGreaterThanOrEqual(3);
		expect(result.providerTerminal).toBe(true);
		expect(result.terminal).toBe(true);
	});
	it("an unreadable provider is NOT terminal, and a missing encoding counts as gone", async () => {
		const c = clock();
		const unreadable = await ensureTerminal({
			cancel: async () => 202,
			readStatus: async () => "CANCELED",
			readProviderStatuses: async () => {
				throw new Error("provider 500");
			},
			...c,
			budgetMs: 30_000,
		});
		expect(unreadable.providerTerminal).toBe(false);
		expect(unreadable.terminal).toBe(false);
		const gone = await ensureTerminal({
			cancel: async () => 202,
			readStatus: async () => "CANCELED",
			readProviderStatuses: async () => [
				{ encodingId: "enc-1", status: "NOT_FOUND" },
			],
			...clock(),
			budgetMs: 30_000,
		});
		expect(gone.terminal).toBe(true);
	});
	it("an empty provider-id read is UNKNOWN after create-before-persist, never terminal", async () => {
		/**
		 * An empty array only says the local step log has no CREATE_ENCODING id.
		 * The provider can have accepted CREATE immediately before the process or
		 * database died, so absence from that projection is not proof of absence.
		 */
		const none = await ensureTerminal({
			cancel: async () => 409,
			readStatus: async () => "CANCELED",
			readProviderStatuses: async () => [],
			...clock(),
			budgetMs: 30_000,
		});
		expect(none.provider).toEqual([]);
		expect(none.providerTerminal).toBe(false);
		expect(none.terminal).toBe(false);
	});
	it("without a provider reader it says so ('unread') instead of claiming provider terminal", async () => {
		const result = await ensureTerminal({
			cancel: async () => 202,
			readStatus: async () => "CANCELED",
			...clock(),
			budgetMs: 30_000,
		});
		expect(result.providerTerminal).toBe("unread");
		expect(result.terminal).toBe(true);
	});
});

describe("report seal and default run id (re-audit BLOCKER-3, ledger #218)", () => {
	/**
	 * The fixture carries a FAIL, because the edit the seal exists to catch is
	 * turning one into a PASS so `--resume-from` skips the re-run. The first
	 * version's `.replace('"FAIL"', '"PASS"')` matched nothing — the fixture was
	 * all-PASS — so the check was carried entirely by a second, cosmetic edit
	 * (review of this PR).
	 */
	const json =
		'{"runId":"r1","outcomes":[{"scenario":"a","verdict":"FAIL"},{"scenario":"b","verdict":"PASS"}]}\n';
	it("a plain seal verifies the unedited report and refuses a forged verdict", () => {
		const seal = sealReport(json);
		expect(seal).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(verifyReportSeal(json, seal)).toEqual({ ok: true });
		const forged = json.replace('"FAIL"', '"PASS"');
		// Both ends: the edit really happened, and it really is refused.
		expect(forged).not.toBe(json);
		expect(forged).toContain('"scenario":"a","verdict":"PASS"');
		expect(verifyReportSeal(forged, seal).ok).toBe(false);
		// And re-sealing the forgery does not launder it under the real seal.
		expect(sealReport(forged)).not.toBe(seal);
	});
	it("an HMAC seal needs the key to verify and refuses a different key", () => {
		const seal = sealReport(json, "k1");
		expect(seal).toMatch(/^hmac-sha256:/);
		expect(verifyReportSeal(json, seal, "k1")).toEqual({ ok: true });
		expect(verifyReportSeal(json, seal).ok).toBe(false);
		expect(verifyReportSeal(json, seal, "k2").ok).toBe(false);
	});
	it("an unrecognised seal is refused", () => {
		expect(verifyReportSeal(json, "md5:abc").ok).toBe(false);
	});
	it("the default run id carries milliseconds and random hex, and passes validateRunId", () => {
		const id = defaultRunId(
			new Date("2026-08-29T12:34:56.789Z"),
			() => "a1b2c3",
		);
		expect(id).toBe("2026-08-29T12-34-56-789-a1b2c3");
		expect(validateRunId(id)).toBe(id);
		expect(
			defaultRunId(new Date("2026-08-29T12:34:56.789Z"), () => "ffffff"),
		).not.toBe(id);
	});
});

describe("pickByLabel", () => {
	const rows = [
		{ id: "1", label: "verify-aws" },
		{ id: "2", label: "verify-aws-backup" },
		{ id: "3", label: "verify-gcs" },
	];
	it("prefers the exact label over a prefix match", () => {
		expect(pickByLabel(rows, "verify-aws", "s3")?.id).toBe("1");
	});
	it("accepts a prefix when it is the only match", () => {
		expect(pickByLabel(rows, "verify-g", "gcs")?.id).toBe("3");
	});
	it("refuses an ambiguous prefix instead of taking the first row", () => {
		// No exact "verify-aws" row, two rows that start with it: the old
		// `.find` returned whichever came first.
		expect(() =>
			pickByLabel(
				[
					{ id: "2", label: "verify-aws-backup" },
					{ id: "4", label: "verify-aws-old" },
					{ id: "3", label: "verify-gcs" },
				],
				"verify-aws",
				"s3",
			),
		).toThrow(/2 credentials match/);
	});
	it("returns undefined when nothing matches — the caller names the remedy", () => {
		expect(pickByLabel(rows, "verify-azure", "azure")).toBeUndefined();
	});
});

describe("pickAccount", () => {
	const accounts = [{ id: "a1" }, { id: "a2" }];
	it("takes the named account", () => {
		expect(pickAccount(accounts, "a2")?.id).toBe("a2");
	});
	it("refuses a named account that is not registered", () => {
		expect(() => pickAccount(accounts, "zz")).toThrow(
			/not a registered account/,
		);
	});
	it("takes the only account when none is named", () => {
		expect(pickAccount([{ id: "a1" }], undefined)?.id).toBe("a1");
	});
	it("refuses to choose between two by creation date", () => {
		expect(() => pickAccount(accounts, undefined)).toThrow(/none is named/);
	});
	it("returns undefined with no accounts at all", () => {
		expect(pickAccount([], undefined)).toBeUndefined();
	});
});

/** A clock that advances once per read, so budgets are exact in test time. */
function ticking(statuses: (string | undefined)[], stepMs: number) {
	let i = 0;
	let t = 1_000_000;
	return {
		now: () => t,
		sleep: async () => {
			t += stepMs;
		},
		read: async () => statuses[Math.min(i++, statuses.length - 1)],
		reads: () => i,
	};
}

describe("ensureTerminal", () => {
	it("cancels, then waits until the row leaves its billable states", async () => {
		const world = ticking(["RUNNING", "RUNNING", "CANCELED"], 100);
		const result = await ensureTerminal({
			cancel: async () => 200,
			readStatus: world.read,
			sleep: world.sleep,
			now: world.now,
			budgetMs: 10_000,
		});
		expect(result).toMatchObject({
			status: "CANCELED",
			cancelHttp: 200,
			terminal: true,
		});
		expect(world.reads()).toBe(3);
	});
	it("reports a job still RUNNING after the budget as NOT terminal — the caller must not look away", async () => {
		const world = ticking(["RUNNING"], 100);
		const result = await ensureTerminal({
			cancel: async () => 409,
			readStatus: world.read,
			sleep: world.sleep,
			now: world.now,
			budgetMs: 250,
		});
		expect(result.terminal).toBe(false);
		expect(result.status).toBe("RUNNING");
		expect(result.cancelHttp).toBe(409);
	});
	it("treats AWAITING_QC as still billable and an unreadable row as not terminal", async () => {
		const parked = await ensureTerminal({
			cancel: async () => 200,
			readStatus: async () => "AWAITING_QC",
			sleep: async () => {},
			now: (() => {
				let t = 0;
				return () => (t += 1000);
			})(),
			budgetMs: 2500,
		});
		expect(parked.terminal).toBe(false);
		const unreadable = await ensureTerminal({
			cancel: async () => {
				throw new Error("network");
			},
			readStatus: async () => {
				throw new Error("db");
			},
			sleep: async () => {},
			now: () => 0,
			budgetMs: 0,
		});
		expect(unreadable).toMatchObject({
			status: "UNKNOWN",
			cancelHttp: 0,
			terminal: false,
		});
	});
});

describe("awaitStatus", () => {
	it("reaches the wanted state", async () => {
		const world = ticking(["STOPPING", "STOPPING", "STOPPED"], 100);
		expect(
			await awaitStatus({
				read: world.read,
				wanted: ["STOPPED", "ERROR"],
				sleep: world.sleep,
				now: world.now,
				budgetMs: 10_000,
			}),
		).toEqual({ status: "STOPPED", reached: true });
	});
	it("gives up at the budget and names the last state seen", async () => {
		const world = ticking(["STOPPING"], 100);
		expect(
			await awaitStatus({
				read: world.read,
				wanted: ["STOPPED"],
				sleep: world.sleep,
				now: world.now,
				budgetMs: 350,
			}),
		).toEqual({ status: "STOPPING", reached: false });
	});
});

/**
 * Code without its explanations. A grep-style pin over a file that DOCUMENTS
 * the thing it forbids answers "covered" about its own prose — both new pins
 * below were satisfied by their own comments on the first run. Block comments
 * go, and so do whole-line `//` ones; a `//` mid-line is left alone so a URL
 * in a string literal cannot swallow the rest of its line.
 */
function withoutComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("the wiring, pinned by shape", () => {
	// `runVerification` needs a database, credentials, a product and a bucket,
	// and no test invokes it (review-298 recorded the same gap for the VOD
	// verdict). The rules above are unit-tested; this catches the one revert
	// that matters — a rule existing and the runner not calling it — and the
	// ORDER the audit's BLOCKER-3 turned on: a prior PASS may be honoured only
	// after the scenario is runnable and its plan is rewritten.
	const runner = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
	const live = readFileSync(
		new URL("./runner-live.ts", import.meta.url),
		"utf8",
	);

	it("main() validates every argument before anything is spent", () => {
		const main = runner.slice(runner.indexOf("export async function main("));
		for (const call of [
			/validateRunId\(/,
			/resolveBaseUrl\(process\.env\)/,
			/positiveInt\(\s*"concurrency"/,
			/positiveInt\(\s*"timeout-ms"/,
			/positiveInt\(\s*"max-submits"/,
		]) {
			expect(main, String(call)).toMatch(call);
		}
		expect(main).not.toMatch(/Number\(flag\(/);
		const validateCanary = main.indexOf(
			"validatePostCreateResponseLossCanary({",
		);
		const createPrisma = main.indexOf("createPrismaClient(");
		expect(validateCanary).toBeGreaterThan(-1);
		expect(validateCanary).toBeLessThan(createPrisma);
		expect(main).toMatch(
			/argv\.includes\(\s*"--inject-post-create-response-loss"/,
		);
	});

	it("runVerification refuses a reused run directory and a non-empty output prefix, in EVERY output family", () => {
		// The refusals live in `prepareRunDir` / `assertFreshRun` and are
		// exercised above; what is pinned here is that the runner CALLS them
		// (review-327 I1), and that every bucket the rewrite can write to is
		// listed (review-327 I3).
		expect(runner).toContain("await prepareRunDir(config.runDir, {");
		expect(runner).toContain("await assertFreshRun({");
		for (const family of [
			'family: "S3"',
			'family: "GenericS3"',
			'family: "GCS"',
		]) {
			expect(runner, family).toContain(family);
		}
		expect(runner).toContain(
			"prefixHoldsObjects(config, family.credentialId, family.bucket, prefix)",
		);
	});

	it("nothing resume-shaped runs before the rewrite — the audited name-only shortcut cannot come back (review-327 I2)", () => {
		// The order pin below fixes the RELATIVE order of three literals; it did
		// not notice an earlier return honouring a prior PASS by name, ahead of
		// the runnable/invalid checks (the audited BLOCKER-3 shape). Any such
		// shortcut has to reach the prior report — `priorReport`, or
		// `loadResumePasses`/`config.resumeFrom` — so the code (comments
		// stripped, because a comment once faked a kill) before the rewrite may
		// not mention either.
		const body = runner.slice(runner.indexOf("const runOne = async ("));
		const beforeRewrite = body
			.slice(0, body.indexOf("plan = rewriteForRun("))
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/[^\n]*/g, "");
		expect(beforeRewrite.length).toBeGreaterThan(200);
		expect(beforeRewrite).not.toMatch(/priorReport|resum/i);
	});

	it("the identity is run-independent and the submit budget is spent at the spend sites (review-327 Critical / I4)", () => {
		expect(runner).toContain(
			"planSha256: planIdentitySha256(s.plan, rewriteOptions, s.name)",
		);
		expect(runner).not.toMatch(/planSha256: createHash/);
		expect(runner).not.toContain("submitsSpent");
		const body = runner.slice(runner.indexOf("const runOne = async ("));
		const eligibility = body.indexOf("resumeEligibility(");
		const vodSpend = body.indexOf("const spend = budget.spend();");
		const submit = body.indexOf("await submit(config, session, {");
		expect(eligibility).toBeGreaterThan(-1);
		expect(vodSpend).toBeGreaterThan(eligibility);
		expect(submit).toBeGreaterThan(vodSpend);
		const liveSpend = body.indexOf("const liveSpend = budget.spend();");
		const live = body.indexOf("return await runLive(");
		expect(liveSpend).toBeGreaterThan(-1);
		expect(live).toBeGreaterThan(liveSpend);
	});

	it("identity is chosen by pickByLabel / pickAccount, never by .find on a prefix or by creation date", () => {
		const body = runner.slice(
			runner.indexOf("export async function runVerification("),
		);
		expect(body).toContain("pickAccount(");
		expect(body).not.toContain('orderBy: { createdAt: "asc" }');
		expect(body).not.toMatch(
			/credentials\.find\(\(c\) =>\s*c\.label\.startsWith/,
		);
	});

	it("a prior PASS is honoured only after the rewrite, with the eligibility check", () => {
		const body = runner.slice(runner.indexOf("const runOne = async ("));
		const rewrite = body.indexOf("plan = rewriteForRun(");
		const eligibility = body.indexOf("resumeEligibility(");
		const submit = body.indexOf("await submit(config, session, {");
		expect(rewrite).toBeGreaterThan(-1);
		expect(eligibility).toBeGreaterThan(rewrite);
		expect(submit).toBeGreaterThan(eligibility);
	});

	it("every paid VOD verification excludes foreign objects, and an abandoned job is driven terminal — with the PROVIDER's word", () => {
		const verify = runner.slice(
			runner.indexOf("const verified = await verifyJob({"),
		);
		expect(verify.slice(0, 600)).toContain("excludeOlderThanJob: true");
		// ONE set of cleanup deps, and it reads the provider through the SDK
		// with the TYPED 404 (review of this PR — the message match read a 500
		// whose prose contained "404" as gone).
		const deps = runner.slice(
			runner.indexOf("function vodCleanupDeps("),
			runner.indexOf("async function liveVerificationProviderContext("),
		);
		expect(deps.length).toBeGreaterThan(0);
		expect(deps).toContain("readProviderStatuses: async () =>");
		expect(deps).toContain("readVerificationProviderEncodingStatus(");
		expect(deps).toContain("provider.sdk.stopEncoding(encodingId)");
		const exactReadback = runner.slice(
			runner.indexOf(
				"export async function readVerificationProviderEncodingStatus(",
			),
			runner.indexOf("async function liveVerificationProviderContext("),
		);
		expect(exactReadback).toContain("encodingIsGone(err)");
		// Comments stripped: the docblock on `encodingIsGone` QUOTES the message
		// match it replaced, and a negative pin that its own explanation
		// satisfies is a pin that never fires.
		expect(withoutComments(runner)).not.toMatch(/\/404\|not found\/i/);
	});

	it("BOTH ways a VOD scenario ends ask the provider — the rule was scoped to the abandon path (review of this PR)", () => {
		// A local terminal status that is not FINISHED used to return without
		// ever asking Bitmovin, so a multi-encoding plan could close its report
		// while a sibling encoding was still RUNNING and billing.
		const body = runner.slice(runner.indexOf("const runOne = async ("));
		const calls = body.match(
			/await ensureTerminal\(\{\n\t+\.\.\.cleanupDeps\(/g,
		);
		// Four with the response-loss canary: the two scenario endings, the
		// mismatched-adoption safety cleanup, plus the run-level intent teardown's
		// VOD resolver for a job adopted after the scenario loop lost its response.
		expect(calls?.length).toBe(4);
		const teardownSite = body.indexOf(
			"const teardown = await intents.teardown({",
		);
		expect(teardownSite).toBeGreaterThan(-1);
		expect(
			body
				.slice(teardownSite, teardownSite + 600)
				.match(/await ensureTerminal\(\{/g)?.length,
		).toBe(1);
		const failPath = body.slice(body.indexOf('terminal.status !== "FINISHED"'));
		expect(failPath.slice(0, 1200)).toContain("await ensureTerminal({");
		expect(failPath.slice(0, 1200)).toContain("...failedJobOutcome(terminal,");
		// …and the abandon path still does, with its own (longer) budget.
		expect(body).toContain("budgetMs: ABANDON_CLEANUP_BUDGET_MS");
		expect(body).toContain("budgetMs: TERMINAL_PROVIDER_BUDGET_MS");
	});

	it("VERIFY_BASE_URL is read in exactly ONE place, and every command goes through it", () => {
		/**
		 * The population, derived rather than listed: every non-test module of
		 * the verify surface plus the CLI. `verify smoke` read the variable
		 * itself and posted the password to whatever it said (review of this
		 * PR), so the pin is a count over the whole set — a third command
		 * cannot reintroduce the bypass without turning this red.
		 */
		const dir = new URL(".", import.meta.url);
		const modules = readdirSync(dir)
			.filter((f) => f.endsWith(".ts") && !/\.(test|d)\.ts$/.test(f))
			.map((f) => ({
				file: f,
				source: readFileSync(new URL(f, dir), "utf8"),
			}));
		modules.push({
			file: "../../scripts/verify.ts",
			source: readFileSync(
				new URL("../../scripts/verify.ts", import.meta.url),
				"utf8",
			),
		});
		// The population is real, and it includes the three files that mattered.
		expect(modules.length).toBeGreaterThanOrEqual(10);
		for (const name of [
			"runner.ts",
			"smoke.ts",
			"harness-rails.ts",
			"../../scripts/verify.ts",
		]) {
			expect(modules.map((m) => m.file)).toContain(name);
		}
		// Code only — every one of these files EXPLAINS the variable in prose,
		// and the first version of this pin was satisfied by its own comments.
		const readers = modules
			.map((m) => ({ file: m.file, code: withoutComments(m.source) }))
			.filter((m) => /env\.VERIFY_BASE_URL/.test(m.code));
		expect(readers.map((m) => m.file)).toEqual(["harness-rails.ts"]);
		expect((readers[0]?.code.match(/env\.VERIFY_BASE_URL/g) ?? []).length).toBe(
			1,
		);
		// And both commands reach it.
		expect(runner).toContain("resolveBaseUrl(process.env)");
		expect(modules.find((m) => m.file === "smoke.ts")?.source).toContain(
			"resolveBaseUrl(env)",
		);
		expect(
			modules.find((m) => m.file === "../../scripts/verify.ts")?.source,
		).toContain("smokeConfigFromEnv(process.env)");
	});

	it("the DB owns the sealed report before recoverable exports, a resume joins durable DB/file evidence first, and the default run id is not the wall-clock second (re-audit BLOCKER-3)", () => {
		const reportExports = runner.slice(
			runner.indexOf("const sealedRunReportFiles"),
			runner.indexOf("export async function publishSealedRunReport("),
		);
		const publisher = runner.slice(
			runner.indexOf("export async function publishSealedRunReport("),
			runner.indexOf("export type RunReport ="),
		);
		expect(reportExports).toContain("report.seal.pending.");
		expect(reportExports).toContain('randomBytes(12).toString("hex")');
		expect(reportExports).toContain(
			"await publishFile(file.pending, file.published)",
		);
		expect(publisher).toContain("await input.validateDurably()");
		expect(publisher).toContain("await input.sealDurably()");
		expect(publisher).toContain(
			"return publishStagedRunReportExports(files, input.publishFile ?? rename)",
		);
		expect(publisher.indexOf("await input.validateDurably()")).toBeLessThan(
			publisher.indexOf("await input.sealDurably()"),
		);
		expect(publisher.indexOf("await input.sealDurably()")).toBeLessThan(
			publisher.indexOf("return publishStagedRunReportExports("),
		);
		const resume = runner.slice(runner.indexOf("if (config.resumeFrom)"));
		const load = resume.indexOf("await loadResumeEvidence({");
		const decision = resume.indexOf("await recorder.resumeDecision({");
		const refusal = resume.indexOf("if (!loaded.ok)");
		const liveSpend = resume.indexOf("const liveSpend = budget.spend()");
		const vodSpend = resume.indexOf("const spend = budget.spend()");
		expect(load).toBeGreaterThanOrEqual(0);
		expect(decision).toBeGreaterThan(load);
		expect(refusal).toBeGreaterThan(decision);
		expect(liveSpend).toBeGreaterThan(refusal);
		expect(vodSpend).toBeGreaterThan(refusal);
		expect(runner).toContain(
			'defaultRunId(new Date(), () => randomBytes(3).toString("hex"))',
		);
		expect(runner).not.toMatch(
			/toISOString\(\)\.replace\(\/\[:\.\]\/g, "-"\)\.slice\(0, 19\)/,
		);
		// The image's commit is read before git (BLOCKER-3: no `.git` in the container).
		expect(runner).toContain("process.env.BITOVP_COMMIT");
		// The source identity rides on every outcome — over EVERY ingest, not
		// just the first (review of this PR).
		expect(runner).toContain(
			"sourceIdentity: await planSourceIdentity(plan, sourceIdentityFor)",
		);
		expect(runner).not.toContain("const ingest = plan.ingest[0];");
	});

	it("the live teardown waits for the confirmation and a refused roll is a status, not a skip", () => {
		expect(live).toContain("await awaitStatus({");
		expect(live).toContain('wanted: ["STOPPED", "ERROR"]');
		expect(live).toMatch(/REFUSED \(HTTP \$\{requested\.status\}\)/);
	});
});

describe("assertFreshRun — a run id is never reused, in ANY output family (ledger #209, review-327 I1/I3)", () => {
	const FAMILIES = [
		{ family: "S3", credentialId: "c-s3", bucket: "verify-out" },
		{ family: "GenericS3", credentialId: "c-akamai", bucket: "verify-akamai" },
		{ family: "GCS", credentialId: "c-gcs", bucket: "verify-gcs" },
	] as const;

	it("lists every family and proceeds when all three are empty", async () => {
		const listed: string[] = [];
		await expect(
			assertFreshRun({
				prefix: "verify/r1/",
				families: FAMILIES,
				holds: async (f) => {
					listed.push(f.family);
					return { holds: false };
				},
			}),
		).resolves.toBeUndefined();
		expect(listed).toEqual(["S3", "GenericS3", "GCS"]);
	});

	it("refuses when the THIRD family holds objects, even though S3 is empty — the audited gap", async () => {
		await expect(
			assertFreshRun({
				prefix: "verify/r1/",
				families: FAMILIES,
				holds: async (f) =>
					f.family === "GCS"
						? { holds: true, first: "verify/r1/multi-output-s3-gcs/x.m3u8" }
						: { holds: false },
			}),
		).rejects.toThrow(
			/GCS verify-gcs\/verify\/r1\/ already holds objects \(e\.g\. verify\/r1\/multi-output-s3-gcs\/x\.m3u8\) — a run id is never reused/,
		);
	});

	it("refuses a prefix whose state is unknown — a failed listing is not an empty prefix", async () => {
		await expect(
			assertFreshRun({
				prefix: "verify/r1/",
				families: FAMILIES,
				holds: async (f) =>
					f.family === "GenericS3"
						? { error: "SignatureDoesNotMatch" }
						: { holds: false },
			}),
		).rejects.toThrow(
			/could not verify that GenericS3 verify-akamai\/verify\/r1\/ is empty \(SignatureDoesNotMatch\)/,
		);
	});

	it("passes the prefix through to the listing unchanged", async () => {
		const seen: string[] = [];
		await assertFreshRun({
			prefix: "verify/2026-08-28T09-00-00/",
			families: FAMILIES.slice(0, 1),
			holds: async (_f, prefix) => {
				seen.push(prefix);
				return {};
			},
		});
		expect(seen).toEqual(["verify/2026-08-28T09-00-00/"]);
	});
});

describe("prepareRunDir — the on-disk half (review-327 I1)", () => {
	it("refuses an existing run directory and creates nothing", async () => {
		const made: string[] = [];
		await expect(
			prepareRunDir("/runs/r1", {
				exists: () => true,
				mkdir: async (p) => {
					made.push(p);
				},
			}),
		).rejects.toThrow(
			/run directory \/runs\/r1 already exists — a run id is never reused/,
		);
		expect(made).toEqual([]);
	});

	it("creates a fresh one", async () => {
		const made: string[] = [];
		await prepareRunDir("/runs/r2", {
			exists: () => false,
			mkdir: async (p) => {
				made.push(p);
			},
		});
		expect(made).toEqual(["/runs/r2"]);
	});
});

describe("createSubmitBudget — charged at the spend site, in one step (review-327 I4)", () => {
	it("is unlimited without a cap", () => {
		const budget = createSubmitBudget(undefined);
		for (let i = 0; i < 5; i += 1) {
			expect(budget.spend()).toEqual({ ok: true });
		}
		expect(budget.exhausted()).toBe(false);
		expect(budget.spent()).toBe(5);
	});

	it("refuses the (max+1)th spend by name and does not count the refusal", () => {
		const budget = createSubmitBudget(2);
		expect(budget.exhausted()).toBe(false);
		expect(budget.spend()).toEqual({ ok: true });
		expect(budget.spend()).toEqual({ ok: true });
		expect(budget.exhausted()).toBe(true);
		expect(budget.spend()).toEqual({
			ok: false,
			reason: "max-submits cap (2) reached",
		});
		expect(budget.spent()).toBe(2);
	});

	it("exhausted() reserves nothing — asking is free", () => {
		const budget = createSubmitBudget(1);
		expect(budget.exhausted()).toBe(false);
		expect(budget.exhausted()).toBe(false);
		expect(budget.spent()).toBe(0);
		expect(budget.spend()).toEqual({ ok: true });
	});
});
