import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema, storageSummaries } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { credentialRefsForPlan } from "./credential-refs";

/**
 * This module had no test, unlike the `playback-links.ts` precedent its own
 * docblock names — and the realistic refactor survives the whole 169-file web
 * suite: widen the Prisma `select` AND return the row directly.
 *
 * WHAT THE DANGER ACTUALLY IS (an earlier version of this comment named the wrong
 * column — review finding). `config` is NOT secret-bearing: `schema.prisma` keeps
 * them apart, `config` being "Non-secret configuration: region, endpoint host,
 * default bucket" while the AES-256-GCM blob lives in its own `encryptedSecret`
 * column. `playback-links.ts:65` deliberately selects `config`, which it could not
 * if that were false. So projecting `config` here would be an over-share — the page
 * needs two strings and would receive endpoints, regions and base URLs — not a
 * secret leak.
 *
 * The real hazard is `select: { encryptedSecret: true }`, because
 * `packages/db/src/client.ts` warns that an explicit `select` **overrides** the
 * client's global omit of that column. That is why the assertion below is on the
 * EXACT key set rather than "config is absent": the exact set is what catches
 * `encryptedSecret`, and a subset check would not.
 *
 * Both defences are pinned separately — a narrow `select` and an explicit
 * re-projection — because either alone is enough to be correct and neither alone is
 * enough to stay correct.
 */

function ctxWith(rows: Array<Record<string, unknown>>) {
	const findMany = vi.fn(async (..._args: unknown[]) => rows);
	return {
		ctx: { prisma: { credential: { findMany } } } as never,
		findMany,
	};
}

/**
 * A REAL plan, because the ids are derived through `storageSummaries` — a
 * hand-built partial object throws inside it and lands in the `{}` fallback, so
 * the test would pass over the code it means to exercise.
 */
const PLAN = encodingPlanSchema.parse(
	JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
			),
			"utf8",
		),
	),
);
/** The ids the plan actually names, derived the same way the module derives them. */
const PLAN_IDS = [
	...new Set(
		[...storageSummaries(PLAN).inputs, ...storageSummaries(PLAN).outputs]
			.map((endpoint) => endpoint.credentialId)
			.filter((id): id is string => typeof id === "string"),
	),
];
const ID_A = PLAN_IDS[0] as string;

describe("credentialRefsForPlan", () => {
	it("derives a non-empty id list from the fixture", () => {
		// Guards every assertion below: a fixture that stopped naming credentials
		// would make them all pass over nothing.
		expect(PLAN_IDS.length).toBeGreaterThan(0);
	});

	it("selects ONLY id, label and provider — never config", async () => {
		const { ctx, findMany } = ctxWith([
			{ id: ID_A, label: "source", provider: "AWS_S3" },
		]);
		await credentialRefsForPlan(ctx, PLAN);
		const select = findMany.mock.calls[0]?.[0] as {
			select?: Record<string, unknown>;
		};
		// The exact key set, not a subset check: adding `config: true` here would
		// override the client's global omit and put an encrypted secret on the wire.
		expect(Object.keys(select?.select ?? {}).sort()).toEqual([
			"id",
			"label",
			"provider",
		]);
	});

	it("re-projects, so a widened select still cannot leak", async () => {
		// The second defence, independent of the first: even handed a row carrying
		// `config`, the returned map holds only the two display fields.
		// The row shape a widened `select` would actually return: `encryptedSecret` as
		// its own column, plus `config`. The first version planted the secret INSIDE
		// `config`, which the schema cannot produce — a defect that cannot occur is
		// not a test (review finding).
		const { ctx } = ctxWith([
			{
				id: ID_A,
				label: "source",
				provider: "AWS_S3",
				encryptedSecret: "SHOULD-NEVER-APPEAR",
				config: { region: "ap-northeast-1", endpoint: "s3.example.invalid" },
			},
		]);
		const refs = await credentialRefsForPlan(ctx, PLAN);
		expect(refs[ID_A]).toEqual({ label: "source", provider: "AWS_S3" });
		expect(JSON.stringify(refs)).not.toContain("SHOULD-NEVER-APPEAR");
		// And the non-secret over-share is dropped too: two strings is the contract.
		expect(JSON.stringify(refs)).not.toContain("ap-northeast-1");
	});

	it("scopes the query to the ids the plan names", async () => {
		const { ctx, findMany } = ctxWith([]);
		await credentialRefsForPlan(ctx, PLAN);
		const where = findMany.mock.calls[0]?.[0] as {
			where?: { id?: { in?: string[] } };
		};
		expect(where?.where?.id?.in?.slice().sort()).toEqual(
			PLAN_IDS.slice().sort(),
		);
	});

	it("does not query at all when the plan names no credentials", async () => {
		// An HTTPS-input plan names no credential anywhere.
		const { ctx, findMany } = ctxWith([]);
		const noCreds = { ...PLAN, inputs: [], outputs: [], muxings: [], drm: [] };
		expect(await credentialRefsForPlan(ctx, noCreds)).toEqual({});
		expect(findMany).not.toHaveBeenCalled();
	});

	it("returns {} for a plan that does not parse, rather than throwing", async () => {
		// The job route renders legacy and hand-edited rows; a bad plan must cost the
		// labels, not the page.
		const { ctx, findMany } = ctxWith([]);
		expect(await credentialRefsForPlan(ctx, { not: "a plan" })).toEqual({});
		expect(findMany).not.toHaveBeenCalled();
	});

	it("uses a null-prototype map, since the keys are operator-controlled", async () => {
		const { ctx } = ctxWith([
			{ id: ID_A, label: "source", provider: "AWS_S3" },
		]);
		const refs = await credentialRefsForPlan(ctx, PLAN);
		// A plain object would answer to "constructor"/"__proto__" lookups; the
		// consumer indexes this by an id read out of the plan.
		expect(Object.getPrototypeOf(refs)).toBeNull();
	});
});
