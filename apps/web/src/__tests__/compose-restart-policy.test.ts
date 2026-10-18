import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every long-lived compose service restarts; the one-shot migrator does not.
 *
 * , and it had already happened: `postgres` and `redis` were left on
 * the default `no` while `web` / `worker` were `unless-stopped`,
 * so a Docker restart brought the APP back without its DATABASE. Postgres
 * exited cleanly on 2026-08-19T22:55:33Z and three web containers were still
 * serving ~20 hours later, answering "Internal error" from a
 * PrismaClientInitializationError.
 *
 * Nothing in the suite read `docker-compose.yml` before this — review-282's
 * observation.
 *
 * WHAT THIS DOES NOT COVER, stated because I nearly claimed otherwise. The
 * first fix put redis's two lines under `migrate`'s comment block; YAML
 * tolerated it (comments and blank lines do not end a block mapping) so redis
 * really did get the policy, while an eye audit read redis as having none and
 * migrate as `unless-stopped`. This test CANNOT catch that, and I verified it
 * cannot: replanting the misplacement leaves all four assertions green,
 * because the parser reads it the way YAML does — correctly. The hazard is the
 * next edit that moves or replaces that comment block and carries redis's
 * policy away with it, which is a readability property no parser can assert.
 * The lines now sit inside their own service block; that is the whole
 * mitigation.
 *
 * `unless-stopped`, not `always`: the only documented stop procedure is
 * `docker compose stop worker` (README), and `unless-stopped` honours a manual
 * stop across daemon restarts while `always` would fight it.
 */
const COMPOSE = join(__dirname, "../../../..", "docker-compose.yml");

/** Services that are SUPPOSED to run once and exit, each with the reason. */
const ONE_SHOT = new Map<string, string>([
	[
		"migrate",
		"applies committed Prisma migrations then exits; restarting it would loop forever",
	],
]);

/**
 * Per SERVICE, its `restart:` value — parsed, not grepped.
 *
 * Scoped to the `services:` block. The first version collected every
 * two-space-indented key in the file, which meant `volumes:`' `pgdata` and
 * `redisdata` were read as services with no restart policy. The enumerated
 * version of the assertion below hid that; deriving the population exposed it
 * immediately, which is the argument for deriving.
 */
function restartPolicies(): Map<string, string | undefined> {
	const out = new Map<string, string | undefined>();
	let inServices = false;
	let service: string | undefined;
	for (const raw of readFileSync(COMPOSE, "utf8").split("\n")) {
		const line = raw.replace(/\s+$/, "");
		if (/^\s*(#|$)/.test(line)) continue;
		// A top-level key ends whatever block we were in.
		const top = /^([A-Za-z0-9_-]+):/.exec(line);
		if (top) {
			inServices = top[1] === "services";
			service = undefined;
			continue;
		}
		if (!inServices) continue;
		// Tolerate a trailing comment on the service head. Requiring
		// end-of-line made population detection FAIL OPEN: `  redis: # cache`
		// would drop out of the walk silently rather than loudly, which is the
		// one hazard left in a file about exactly that class (review-282).
		const head = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
		if (head?.[1]) {
			service = head[1];
			if (!out.has(service)) out.set(service, undefined);
			continue;
		}
		const restart = /^ {4}restart:\s*"?([A-Za-z-]+)"?\s*$/.exec(line);
		if (service && restart?.[1]) out.set(service, restart[1]);
	}
	return out;
}

describe("compose restart policies (ledger #145)", () => {
	const policies = restartPolicies();

	it("parsed the services at all, so this cannot pass over an empty file", () => {
		// Below this and the parser broke rather than the file being fine.
		expect([...policies.keys()].sort()).toEqual(
			expect.arrayContaining(["postgres", "redis", "web", "worker", "migrate"]),
		);
	});

	it("restarts EVERY service except the declared one-shots", () => {
		// Derived, not enumerated (review-282's suggestion): the first version
		// listed four services by name, so a long-lived service added later with
		// no policy passed clean — the same defect this file exists to prevent,
		// one service along. Same shape as `credential-picker-coverage.test.ts`:
		// walk the population, name the exemptions.
		const wrong = [...policies.entries()]
			.filter(([name]) => !ONE_SHOT.has(name))
			.filter(([, policy]) => policy !== "unless-stopped")
			.map(([name, policy]) => `${name}=${policy ?? "(none)"}`);
		expect(
			wrong,
			"these can leave the app outliving its own storage — or add them to ONE_SHOT with a reason",
		).toEqual([]);
	});

	it("does NOT restart the one-shots, and the exemption list is not stale", () => {
		// The counterweight: a blanket "everything restarts" would loop the
		// migrator forever. And an exemption for a service that no longer
		// exists would silently shrink the population above.
		for (const [name, reason] of ONE_SHOT) {
			expect(
				policies.has(name),
				`${name} is exempt but absent: ${reason}`,
			).toBe(true);
			expect(policies.get(name), name).toBe("no");
		}
	});
});
