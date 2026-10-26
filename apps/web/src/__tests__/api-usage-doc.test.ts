import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	evaluateRole,
	isSelfTokenRevocation,
	ROUTE_RULES,
} from "@/lib/auth/roles";

const REPO = join(__dirname, "..", "..", "..", "..");
const DOC = readFileSync(join(REPO, "docs", "API-USAGE.md"), "utf8");

describe("API usage documentation contract", () => {
	it("every documented /api path has a route.ts on disk", () => {
		const paths = new Set(
			[...DOC.matchAll(/\/api\/[a-z0-9\-/<>]+[a-z0-9\]>]/gi)].map((m) => m[0]),
		);
		expect(paths.size).toBeGreaterThan(3);

		const resolves = (docPath: string): boolean => {
			let dir = join(REPO, "apps", "web", "src", "app");
			for (const segment of docPath.replace(/^\//, "").split("/")) {
				if (/^<[^>]+>$/.test(segment)) {
					const bracketed = readdirSync(dir, { withFileTypes: true }).find(
						(entry) => entry.isDirectory() && entry.name.startsWith("["),
					);
					if (!bracketed) {
						return false;
					}
					dir = join(dir, bracketed.name);
				} else {
					dir = join(dir, segment);
					if (!existsSync(dir)) {
						return false;
					}
				}
			}
			return existsSync(join(dir, "route.ts"));
		};
		const missing = [...paths].filter((p) => !resolves(p));
		expect(
			missing,
			`documented paths without a route: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("the two claims that burned stay pinned: plan wrapper + start action", () => {
		expect(DOC).toContain('{"plan": <EncodingPlan>}');

		expect(DOC).toContain('{"action":"start"}');
		expect(DOC).not.toContain('{"action":"provision"}');

		expect(DOC).toContain("400 is a SHAPE failure; 422 is a SEMANTIC one");
	});

	it("the live create body is the WRAPPER, on both sides", () => {
		expect(DOC).toContain('{"plan": <LiveChannelPlan>}');
		const route = readFileSync(
			join(REPO, "apps/web/src/app/api/live-channels/route.ts"),
			"utf8",
		);
		expect(route).toContain("plan: z.unknown()");
	});

	it("the doc warns that live CREATE bills, and the route still provisions on create", () => {
		expect(DOC).toMatch(/CREATION PROVISIONS IMMEDIATELY/);
		const route = readFileSync(
			join(REPO, "apps/web/src/app/api/live-channels/route.ts"),
			"utf8",
		);

		expect(route).toContain('action: "provision"');
	});

	it("derives the PAGINATED set and the doc names exactly it", () => {
		const routes = execFileSync("git", ["ls-files", "apps/web/src/app/api"], {
			cwd: REPO,
			encoding: "utf8",
		})
			.split("\n")
			.filter((f) => f.endsWith("route.ts"));
		const paginated = routes
			.filter((f) => {
				const t = readFileSync(join(REPO, f), "utf8")
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/\/\/[^\n]*/g, "");
				return /export async function GET/.test(t) && /nextCursor/.test(t);
			})
			.map((f) =>
				f.replace("apps/web/src/app/api/", "").replace("/route.ts", ""),
			)
			.sort();

		expect(paginated).toEqual([
			"access-events",
			"audit-logs",
			"encoding-jobs",
			"feeder-sessions",
			"live-channels",
			"live-channels/[id]/runs/[runId]/heartbeat-receipts",

			"live-channels/[id]/runs/[runId]/heartbeats",
			"vmaf-jobs",
			"webhook-events",
		]);
		for (const name of paginated) {
			expect(DOC).toContain(`\`${name}\``);
		}
		expect(DOC).toMatch(/Pagination is the EXCEPTION/);

		const NUMERAL: Record<number, string> = {
			5: "five",
			6: "six",
			7: "seven",
			8: "eight",
			9: "nine",
		};
		const word = NUMERAL[paginated.length];
		expect(word, `no numeral for ${paginated.length}`).toBeDefined();
		expect(DOC).toContain(`Exactly ${word} collection routes`);
		expect(DOC).toContain(`On the ${word} that do paginate`);
	});

	it("pins direct 422 responses and documents the import resource limit", () => {
		const routes = execFileSync("git", ["ls-files", "apps/web/src/app/api"], {
			cwd: REPO,
			encoding: "utf8",
		})
			.split("\n")
			.filter((f) => f.endsWith("route.ts"));
		const withA422 = routes.filter((f) => {
			const t = readFileSync(join(REPO, f), "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/[^\n]*/g, "");
			return /(?:jsonError|liveToVodRequestError)\(\s*422\b/.test(t);
		});

		expect(withA422).toHaveLength(19);
		expect(DOC).toContain(
			"Per-Title encoding import also returns 422 when its resource limit is exceeded",
		);
	});

	it("documents config failure as closed for tokens, without a raw-mode exception", () => {
		expect(DOC).toContain(
			"Invalid auth configuration fails closed for tokens too",
		);
		expect(DOC).toContain("`AUTH_MODE=users`");
		expect(DOC).toContain("`AUTH_NOT_CONFIGURED` before authorization");
		const proxy = readFileSync(join(REPO, "apps/web/src/proxy.ts"), "utf8");
		expect(proxy).toContain("resolveAuthenticatedContext");
		const tenancy = readFileSync(
			join(REPO, "apps/web/src/lib/auth/tenancy.ts"),
			"utf8",
		);
		expect(tenancy).toContain("if (!config.ok)");
		expect(tenancy).toContain("AuthContextError(503");
	});

	it("names every ADMIN-floor subtree the role bullet claims (derived from ROUTE_RULES)", () => {
		const adminPrefixes = ROUTE_RULES.filter(
			(rule) => rule.minRole === "ADMIN",
		).map((rule) => rule.prefix);

		expect(adminPrefixes.length).toBeGreaterThanOrEqual(9);
		for (const prefix of adminPrefixes) {
			expect(DOC, `ADMIN-floor subtree ${prefix} is undocumented`).toContain(
				prefix,
			);
		}
		expect(DOC).toContain("enforced in every `AUTH_MODE`");

		expect(
			evaluateRole("VIEWER", "/api/live/stream-keys/abc", "GET").allowed,
		).toBe(false);
		expect(
			evaluateRole("VIEWER", "/api/credentials/abc/storage/buckets", "GET")
				.allowed,
		).toBe(false);
		expect(
			evaluateRole("OPERATOR", "/api/live/stream-keys/abc", "GET").allowed,
		).toBe(true);
	});

	it("scopes token self-revocation to the modes where it works — which is now ALL of them", () => {
		expect(DOC).toMatch(/only an ADMIN token can/);
		expect(DOC).toContain("in every mode");

		expect(
			evaluateRole("OPERATOR", "/api/api-tokens/abc-123", "DELETE").allowed,
		).toBe(false);

		expect(
			evaluateRole("ADMIN", "/api/api-tokens/abc-123", "DELETE").allowed,
		).toBe(true);
	});

	it("promises SELF-revocation survives the ADMIN floor, and the subject rule delivers it", () => {
		expect(DOC).toMatch(/a token may always revoke\s+ITSELF/);
		expect(DOC).toContain("`SELF_REVOCATION_EXCEPTION`");
		const own = "6f1c9d0e-0000-4000-8000-0000000000a1";
		const other = "6f1c9d0e-0000-4000-8000-0000000000b2";
		expect(isSelfTokenRevocation(own, `/api/api-tokens/${own}`, "DELETE")).toBe(
			true,
		);
		expect(
			isSelfTokenRevocation(own, `/api/api-tokens/${other}`, "DELETE"),
		).toBe(false);

		expect(isSelfTokenRevocation(own, "/api/api-tokens", "DELETE")).toBe(false);
		expect(isSelfTokenRevocation(own, `/api/api-tokens/${own}`, "GET")).toBe(
			false,
		);
	});
});
