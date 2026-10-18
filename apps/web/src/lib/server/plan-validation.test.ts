import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createTenantPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import {
	credentialProviderMap,
	recordUnrestrictedEgress,
	serverPlanValidationOptions,
	submitterValidationOptions,
} from "./plan-validation";

const WEB_SRC = join(__dirname, "../..");

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";

/**
 * Call sites that deliberately do NOT enforce the egress allowlist, with the
 * reason. All four run in the browser: they parse or preview a plan the user is
 * still editing and cannot read server env, so they would have to either ship
 * the allowlist to the client or invent one. Staying silent is correct — the
 * server rejects the plan on submit, which is the moment that matters.
 *
 * Adding a file here is a decision, not a formality: it means "this code path
 * may hand a plan naming any host to something that will POST vault material
 * there". Only client-side code qualifies.
 */
const CLIENT_ONLY_EXEMPT = new Set([
	"app/vod/new/plan-import.ts",
	"app/vod/new/plan-preview.tsx",
	"app/live/new/live-plan-import.ts",
	"app/live/new/live-plan-preview.tsx",
]);

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...sourceFiles(path));
			continue;
		}
		if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
			continue;
		}
		out.push(path);
	}
	return out;
}

describe("every plan-validation call site is classified (C22, ledger #34)", () => {
	// `validatePlan` only checks egress hosts when the caller passes the
	// allowlist, so a NEW route that forgets the options argument validates
	// clean and ships an unauthenticated exfiltration path. Per-call-site
	// tests only cover the routes their author remembered; this one walks the
	// tree, so a route added later fails here instead of shipping quietly.
	const callSites = sourceFiles(WEB_SRC)
		.map((path) => ({ path, text: readFileSync(path, "utf8") }))
		.filter(({ text }) => /\bvalidate(Plan|LiveChannel)\(/.test(text))
		.map(({ path, text }) => ({
			rel: relative(WEB_SRC, path).replaceAll("\\", "/"),
			text,
		}));

	it("finds the call sites at all (guards against a broken walk)", () => {
		// Without this, deleting every call site — or breaking `sourceFiles` —
		// would make the suite below vacuously pass.
		expect(callSites.length).toBeGreaterThanOrEqual(5);
	});

	it("has no stale exemptions", () => {
		const found = new Set(callSites.map((c) => c.rel));
		for (const exempt of CLIENT_ONLY_EXEMPT) {
			expect(
				found,
				`${exempt} is exempted but no longer validates a plan`,
			).toContain(exempt);
		}
	});

	it("every non-exempt call site passes the server validation options", () => {
		const offenders = callSites
			.filter((c) => !CLIENT_ONLY_EXEMPT.has(c.rel))
			// Either helper counts: `submitterValidationOptions` wraps the other
			// and adds credential compatibility and MSL publishing-auth context.
			.filter(
				(c) =>
					!c.text.includes("serverPlanValidationOptions") &&
					!c.text.includes("submitterValidationOptions"),
			)
			.map((c) => c.rel);
		expect(
			offenders,
			"these validate a plan without the egress allowlist — pass " +
				"serverPlanValidationOptions(), or add them to CLIENT_ONLY_EXEMPT " +
				"with a reason if they genuinely run in the browser",
		).toEqual([]);
	});

	it("a file with several call sites passes the options at each one", () => {
		// Importing the helper is not the same as using it everywhere.
		const offenders = callSites
			.filter((c) => !CLIENT_ONLY_EXEMPT.has(c.rel))
			.filter((c) => {
				const calls = c.text.match(/\bvalidate(Plan|LiveChannel)\(/g) ?? [];
				// Both helpers accept context arguments.
				const passes =
					c.text.match(
						/(serverPlanValidationOptions|submitterValidationOptions)\(/g,
					) ?? [];
				return passes.length < calls.length;
			})
			.map((c) => c.rel);
		expect(offenders).toEqual([]);
	});
});

describe("serverPlanValidationOptions", () => {
	it("resolves an unset allowlist to [] — configured-but-empty, not absent", () => {
		// `undefined` would mean "not the enforcement point" and skip the check
		// entirely, silently turning the warning off for every server route.
		vi.stubEnv("SECRET_EGRESS_ALLOWED_HOSTS", "");
		expect(serverPlanValidationOptions().secretEgressAllowedHosts).toEqual([]);
		vi.unstubAllEnvs();
	});

	it("parses a configured allowlist", () => {
		vi.stubEnv(
			"SECRET_EGRESS_ALLOWED_HOSTS",
			" Kantar.Example.com , .vendor.example ",
		);
		expect(serverPlanValidationOptions().secretEgressAllowedHosts).toEqual([
			"kantar.example.com",
			".vendor.example",
		]);
		vi.unstubAllEnvs();
	});
});

describe("recordUnrestrictedEgress", () => {
	/**
	 * The sink is the C7 AuditLog, not stdout (review catch): nothing under
	 * app/api logs to console, the log is queryable from Settings → Audit, and
	 * the plan that triggered the warning is persisted forever while a stdout
	 * line is gone when the terminal closes.
	 */
	const issue = (code: string) => ({
		code,
		level: "warning" as const,
		path: "kantar.serverUrl",
		message: "goes to whoever.example.net",
	});

	function fakePrisma() {
		const create = vi.fn(
			async (_args: { data: Record<string, unknown> }) => ({}),
		);
		return { create, prisma: { auditLog: { create } } };
	}

	it("files one POLICY audit row per unrestricted-egress issue", async () => {
		const { create, prisma } = fakePrisma();
		await recordUnrestrictedEgress(
			prisma as never,
			[issue("PLAN_SECRET_EGRESS_HOST_UNRESTRICTED")],
			{
				path: "/api/encoding-jobs",
				bitmovinAccountId: ACCOUNT_ID,
				actor: null,
			},
		);
		expect(create).toHaveBeenCalledTimes(1);
		const row = create.mock.calls[0]?.[0].data;
		expect(row?.method).toBe("POLICY");
		expect(row?.path).toBe("/api/encoding-jobs");
		expect(row?.bitmovinAccountId).toBe(ACCOUNT_ID);
		// The host has to be IN the row — a row saying only "policy tripped" does
		// not answer "which jobs ran before we set the allowlist?".
		expect(JSON.stringify(row?.request)).toContain("whoever.example.net");
		expect(JSON.stringify(row?.request)).toContain("kantar.serverUrl");
	});

	it("ignores unrelated issues", async () => {
		const { create, prisma } = fakePrisma();
		await recordUnrestrictedEgress(prisma as never, [issue("PLAN_OTHER")], {
			path: "/api/encoding-jobs",
			actor: null,
		});
		expect(create).not.toHaveBeenCalled();
	});

	it("writes nothing when there is nothing to record", async () => {
		const { create, prisma } = fakePrisma();
		await recordUnrestrictedEgress(prisma as never, [], {
			path: "/x",
			actor: null,
		});
		expect(create).not.toHaveBeenCalled();
	});

	it("does not throw when the audit write fails", async () => {
		// A job must not fail because its warning could not be filed.
		const create = vi.fn(
			async (_args: { data: Record<string, unknown> }): Promise<never> => {
				throw new Error("db down");
			},
		);
		await expect(
			recordUnrestrictedEgress(
				{ auditLog: { create } } as never,
				[issue("PLAN_SECRET_EGRESS_HOST_UNRESTRICTED")],
				{ path: "/x", actor: null },
			),
		).resolves.toBeUndefined();
	});
});

describe("server submission validation context", () => {
	it("resolves providers without deployment restrictions", async () => {
		const findMany = vi.fn(async () => [{ id: "c1", provider: "DRM_SPEKE" }]);
		const options = await submitterValidationOptions(
			{ credential: { findMany } },
			null,
		);
		expect(findMany).toHaveBeenCalledWith({
			select: { id: true, provider: true },
		});
		expect(options.credentialProviders?.get("c1")).toBe("DRM_SPEKE");
		expect(options).not.toHaveProperty("deploymentProfile");
	});

	it("resolves the MSL publishing-auth set and preserves an empty set", async () => {
		const prisma = { credential: { findMany: vi.fn(async () => []) } };
		for (const ids of [new Set(["msl-credential"]), new Set<string>()]) {
			const publishingAuthCredentialIds = vi.fn(async () => ids);
			const options = await submitterValidationOptions(prisma, {
				publishingAuthCredentialIds,
			});
			expect(options.credentialHasPublishingAuth).toBe(ids);
			expect(publishingAuthCredentialIds).toHaveBeenCalledOnce();
		}
	});

	it("leaves publishing auth undefined for a caller without vault access", async () => {
		const options = await submitterValidationOptions(
			{ credential: { findMany: vi.fn(async () => []) } },
			null,
		);
		expect(options.credentialHasPublishingAuth).toBeUndefined();
	});

	it("uses the supplied tenant Prisma scope for the provider map", async () => {
		const organizationId = "00000000-0000-4000-8000-00000000000a";
		let scopedOrganization: string | undefined;
		const scopedFindMany = vi.fn(async () => {
			expect(scopedOrganization).toBe(organizationId);
			return [{ id: "tenant-speke", provider: "DRM_SPEKE" }];
		});
		const unscopedFindMany = vi.fn(() => {
			throw new Error("unscoped read");
		});
		const base = {
			credential: { findMany: unscopedFindMany },
			$transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
				callback({
					$queryRaw: async () => [{ rolsuper: false, rolbypassrls: false }],
					$executeRaw: async (_sql: unknown, value: string) => {
						scopedOrganization = value;
						return 1;
					},
					credential: { findMany: scopedFindMany },
				}),
		};
		const scoped = createTenantPrismaClient(base as never, organizationId);
		expect(await credentialProviderMap(scoped)).toEqual(
			new Map([["tenant-speke", "DRM_SPEKE"]]),
		);
		expect(unscopedFindMany).not.toHaveBeenCalled();
		expect(scopedFindMany).toHaveBeenCalledWith({
			select: { id: true, provider: true },
		});
	});

	it("preserves explicitly supplied credential compatibility metadata", () => {
		const providers = new Map([["speke", "DRM_SPEKE"]]);
		expect(serverPlanValidationOptions(providers).credentialProviders).toBe(
			providers,
		);
	});
});

describe("every submit pipeline keeps server egress enforcement", () => {
	const repo = join(WEB_SRC, "..", "..", "..");
	const doors = execFileSync("git", ["ls-files", "apps"], {
		cwd: repo,
		encoding: "utf8",
	})
		.split("\n")
		.filter((file) => /\.tsx?$/.test(file) && !file.includes(".test."))
		.map((file) => join(repo, file))
		.filter((file) =>
			/validationOptions\s*[,:]/.test(readFileSync(file, "utf8")),
		);
	it("includes the re-run door and every door carries server options", () => {
		expect(doors.length).toBeGreaterThan(1);
		expect(doors.some((file) => file.endsWith("rerun-job.ts"))).toBe(true);
		for (const file of doors) {
			const text = readFileSync(file, "utf8");
			expect(
				/secretEgressAllowedHosts:/.test(text) ||
					/submitterValidationOptions\s*\(/.test(text),
				file,
			).toBe(true);
		}
	});
});
