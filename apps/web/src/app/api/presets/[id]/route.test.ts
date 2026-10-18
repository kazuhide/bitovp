import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema } from "@bitovp/core";
import { samplePresetPlan } from "@bitovp/core/presets";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const deleteMany = vi.fn();
const updateMany = vi.fn();
/** Watch rules templated on this preset. */
const watchRuleFindMany = vi.fn(async () => [] as unknown[]);

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			preset: { findFirst, deleteMany, updateMany },
			watchRule: { findMany: watchRuleFindMany },
		},
	}),
}));

import { DB_NULL } from "@bitovp/db";
import { DELETE, GET, PATCH } from "./route";

const ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";

beforeEach(() => {
	vi.clearAllMocks();
	watchRuleFindMany.mockResolvedValue([]);
});

function withId(id: string) {
	return { params: Promise.resolve({ id }) };
}

describe("GET /api/presets/[id]", () => {
	it("returns the full preset including the plan body", async () => {
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		findFirst.mockResolvedValueOnce({
			id: ID,
			kind: "FULL_PLAN",
			name: "mine",
			description: null,
			body,
			createdAt: "2026-06-19",
			updatedAt: "2026-06-19",
		});
		const res = await GET(new Request("http://test"), withId(ID));
		expect(res.status).toBe(200);
		expect(findFirst).toHaveBeenCalledWith({
			where: { id: ID, kind: { in: ["FULL_PLAN", "LIVE_PLAN"] } },
		});
		const json = (await res.json()) as Record<string, unknown>;
		// Full body is intentionally returned (secret-free plan JSON), so the
		// wizard can load it. The body carries credentialId refs, never keys.
		expect((json.body as Record<string, unknown>).planVersion).toBe(1);
		expect(JSON.stringify(json)).not.toMatch(/accessKey|secretKey|apiKey/i);
	});

	it("400s a non-UUID id before touching the DB", async () => {
		const res = await GET(new Request("http://test"), withId("not-a-uuid"));
		expect(res.status).toBe(400);
		expect(findFirst).not.toHaveBeenCalled();
	});

	it("404s an unknown / non-plan id", async () => {
		findFirst.mockResolvedValueOnce(null);
		const res = await GET(new Request("http://test"), withId(ID));
		expect(res.status).toBe(404);
	});
});

describe("DELETE /api/presets/[id]", () => {
	it("deletes a plan preset and 204s", async () => {
		deleteMany.mockResolvedValueOnce({ count: 1 });
		const res = await DELETE(new Request("http://test"), withId(ID));
		expect(res.status).toBe(204);
		expect(deleteMany).toHaveBeenCalledWith({
			where: { id: ID, kind: { in: ["FULL_PLAN", "LIVE_PLAN"] } },
		});
	});

	it("400s a non-UUID id before touching the DB", async () => {
		const res = await DELETE(new Request("http://test"), withId("nope"));
		expect(res.status).toBe(400);
		expect(deleteMany).not.toHaveBeenCalled();
	});
});

describe("PATCH /api/presets/[id]", () => {
	const WHEN = "2026-08-17T02:00:00.000Z";

	function patchRequest(body: unknown) {
		return new Request("http://test", {
			method: "PATCH",
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
		});
	}

	function plan() {
		const p = samplePresetPlan("fixed-bitrate-hls-on-aws");
		if (!p) {
			throw new Error("fixture missing");
		}
		return p;
	}

	/** Recursively reverse object key order — same structure, different order. */
	function reorderKeys(v: unknown): unknown {
		if (Array.isArray(v)) {
			return v.map(reorderKeys);
		}
		if (v && typeof v === "object") {
			const out: Record<string, unknown> = {};
			for (const k of Object.keys(v).reverse()) {
				out[k] = reorderKeys((v as Record<string, unknown>)[k]);
			}
			return out;
		}
		return v;
	}

	/** First updateMany call's argument, typed; throws if never called. */
	function updateManyArg() {
		const call = updateMany.mock.calls[0];
		if (!call) {
			throw new Error("updateMany was not called");
		}
		return call[0] as {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		};
	}

	it("400s a non-UUID id before touching the DB", async () => {
		const res = await PATCH(
			patchRequest({ name: "x", expectedUpdatedAt: WHEN }),
			withId("nope"),
		);
		expect(res.status).toBe(400);
		expect(findFirst).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
	});

	// PR4 note: the ROW's kind now picks the schema (LIVE_PLAN rows parse a
	// live plan), so the row READ precedes body validation. The protected
	// property is unchanged and asserted throughout: no WRITE before
	// validation — updateMany never fires on a refused request.
	it("400s a PATCH with nothing to update (only the CAS token)", async () => {
		findFirst.mockResolvedValueOnce({ body: plan(), kind: "FULL_PLAN" });
		const res = await PATCH(
			patchRequest({ expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).toBe(400);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("400s a missing expectedUpdatedAt — CAS is not optional", async () => {
		findFirst.mockResolvedValueOnce({ body: plan(), kind: "FULL_PLAN" });
		const res = await PATCH(patchRequest({ name: "renamed" }), withId(ID));
		expect(res.status).toBe(400);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("refuses an edit that would make a watch rule watch its own outputs", async () => {
		/**
		 * The bypass the rule-side check cannot see.
		 * A watch rule is validated when the RULE is saved; this route can move
		 * the ground under it afterwards. Editing the preset so its outputs land
		 * in the bucket+prefix that rule watches turns every encode's output
		 * into the next encode's input — an unbounded, billable loop reached
		 * without touching the rule at all.
		 */
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		findFirst.mockResolvedValueOnce({ body, kind: "FULL_PLAN" });
		const edited = encodingPlanSchema.parse(
			samplePresetPlan("fixed-bitrate-hls-on-aws"),
		);
		const CRED = "00000000-0000-4000-8000-0000000000cd";
		const outputs = edited.outputs as Record<string, unknown>[];
		for (const output of outputs) {
			output.credentialId = CRED;
			output.bucket = "customer-hot-folder";
		}
		watchRuleFindMany.mockResolvedValueOnce([
			{
				name: "mezzanine-drop",
				credentialId: CRED,
				bucket: "customer-hot-folder",
				prefix: "drops",
				outputPrefixTemplate: "drops/out/{basename}-{uuid}",
			},
		] as unknown[]);
		const res = await PATCH(
			patchRequest({ plan: edited, expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).toBe(422);
		// No WRITE on a refused request — the same property every other refusal
		// in this file asserts.
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("allows the same edit when no watch rule uses the preset", async () => {
		// The arm that keeps the pin above honest: the refusal must come from
		// the OVERLAP, not from the edit being rejected for some other reason.
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		findFirst.mockResolvedValueOnce({ body, kind: "FULL_PLAN" });
		const edited = encodingPlanSchema.parse(
			samplePresetPlan("fixed-bitrate-hls-on-aws"),
		);
		const outputs = edited.outputs as Record<string, unknown>[];
		for (const output of outputs) {
			output.credentialId = "00000000-0000-4000-8000-0000000000cd";
			output.bucket = "customer-hot-folder";
		}
		watchRuleFindMany.mockResolvedValueOnce([]);
		updateMany.mockResolvedValueOnce({ count: 1 });
		findFirst.mockResolvedValueOnce({ id: ID, kind: "FULL_PLAN" });
		const res = await PATCH(
			patchRequest({ plan: edited, expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).not.toBe(422);
		expect(updateMany).toHaveBeenCalled();
	});

	it("refuses an edit that leaves a watch rule unable to instantiate the preset", async () => {
		/**
		 * the same bypass found for
		 * self-intersection: the rule-save check is only as good as the preset
		 * it validated. Swapping the template's input to a kind substitution
		 * cannot target — or one this rule's credential cannot back — reaches
		 * the identical broken state without touching the rule.
		 */
		const CRED = "00000000-0000-4000-8000-0000000000cd";
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		findFirst.mockResolvedValueOnce({ body, kind: "FULL_PLAN" });
		const edited = encodingPlanSchema.parse(
			samplePresetPlan("fixed-bitrate-hls-on-aws"),
		) as unknown as Record<string, unknown>;
		const first = (edited.inputs as { key: string }[])[0];
		edited.inputs = [
			{
				key: first?.key ?? "in",
				kind: "AZURE",
				credentialId: CRED,
				container: "c",
				name: "azure in",
			},
		];
		watchRuleFindMany.mockResolvedValueOnce([
			{
				name: "mezzanine-drop",
				credentialId: CRED,
				bucket: "elsewhere",
				prefix: "drops",
				outputPrefixTemplate: "out/{basename}-{uuid}",
				credential: { provider: "AWS_S3" },
			},
		] as unknown[]);
		const res = await PATCH(
			patchRequest({ plan: edited, expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).toBe(422);
		expect(JSON.stringify(await res.json())).toContain("INPUT_KIND");
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("refuses a SECOND input too — the bypass was half-open", async () => {
		/**
		 * Review of the first cut (rev308) proved this by running the route: the
		 * preset-side filter admitted only INPUT_KIND and CREDENTIAL_PROVIDER,
		 * so INPUT_COUNT and NO_INGEST — equally create-time checks, equally
		 * voidable by editing the preset afterwards — went through with 200 and
		 * the preset was written. The rule then claimed objects and failed on
		 * every one with INPUT_COUNT, which is the operator-invisible state
		 *  exists to remove.
		 */
		const CRED = "00000000-0000-4000-8000-0000000000cd";
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		findFirst.mockResolvedValueOnce({ body, kind: "FULL_PLAN" });
		const edited = encodingPlanSchema.parse(
			samplePresetPlan("fixed-bitrate-hls-on-aws"),
		) as unknown as Record<string, unknown>;
		const inputs = edited.inputs as Record<string, unknown>[];
		const first = inputs[0] as Record<string, unknown>;
		inputs.push({ ...first, key: `${String(first.key)}-2` });
		watchRuleFindMany.mockResolvedValueOnce([
			{
				name: "mezzanine-drop",
				credentialId: CRED,
				bucket: "elsewhere",
				prefix: "drops",
				outputPrefixTemplate: "out/{basename}-{uuid}",
				credential: { provider: "AWS_S3" },
			},
		] as unknown[]);
		const res = await PATCH(
			patchRequest({ plan: edited, expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).toBe(422);
		expect(JSON.stringify(await res.json())).toContain("INPUT_COUNT");
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("allows that same input swap when NO watch rule uses the preset", async () => {
		// Keeps the arm above honest: the refusal must come from the rule's
		// dependency, not from the edit being invalid on its own.
		const CRED = "00000000-0000-4000-8000-0000000000cd";
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		findFirst.mockResolvedValueOnce({ body, kind: "FULL_PLAN" });
		const edited = encodingPlanSchema.parse(
			samplePresetPlan("fixed-bitrate-hls-on-aws"),
		) as unknown as Record<string, unknown>;
		const first = (edited.inputs as { key: string }[])[0];
		edited.inputs = [
			{
				key: first?.key ?? "in",
				kind: "AZURE",
				credentialId: CRED,
				container: "c",
				name: "azure in",
			},
		];
		watchRuleFindMany.mockResolvedValueOnce([]);
		updateMany.mockResolvedValueOnce({ count: 1 });
		findFirst.mockResolvedValueOnce({ id: ID, kind: "FULL_PLAN" });
		const res = await PATCH(
			patchRequest({ plan: edited, expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).not.toBe(422);
	});

	it("refuses a constraint-invalid plan before any WRITE (PRESET-SAVE rule)", async () => {
		// Duplicate input keys → PLAN_DUPLICATE_KEY, same fixture shape as the
		// POST test: schema-parseable, validatePlan-invalid.
		findFirst.mockResolvedValueOnce({ body: plan(), kind: "FULL_PLAN" });
		const dup = plan();
		const inputs = dup.inputs as Record<string, unknown>[];
		dup.inputs = [inputs[0], { ...inputs[0] }];
		const res = await PATCH(
			patchRequest({ plan: dup, expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/validation/i);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("a LIVE row's plan runs the LIVE validator too (review-109pr1 L2 — an isLive→false mutation SURVIVED the old suite)", async () => {
		const live = JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../../../../packages/core/src/live/__fixtures__/live-zixi.plan.json",
				),
				"utf8",
			),
		) as { renditions: Record<string, unknown>[] };
		const dup = structuredClone(live);
		dup.renditions = [dup.renditions[0], { ...dup.renditions[0] }] as Record<
			string,
			unknown
		>[];
		findFirst.mockResolvedValueOnce({ body: live, kind: "LIVE_PLAN" });
		const res = await PATCH(
			patchRequest({ plan: dup, expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/validation/i);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("a LIVE_PLAN row parses the plan as a LIVE plan (per-kind schema)", async () => {
		// A VOD EncodingPlan body sent to a LIVE row must be refused at the
		// schema boundary — the kinds are not interchangeable.
		findFirst.mockResolvedValueOnce({
			body: { planVersion: 1 },
			kind: "LIVE_PLAN",
		});
		const res = await PATCH(
			patchRequest({ plan: plan(), expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).toBe(400);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("404s an unknown / non-plan id", async () => {
		findFirst.mockResolvedValueOnce(null);
		const res = await PATCH(
			patchRequest({ name: "renamed", expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).toBe(404);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("409s a lost race — the row exists but updatedAt moved (CAS)", async () => {
		findFirst.mockResolvedValueOnce({ body: plan(), kind: "FULL_PLAN" });
		updateMany.mockResolvedValueOnce({ count: 0 });
		const res = await PATCH(
			patchRequest({ name: "renamed", expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/modified/i);
		// review-109pr1: this test's NAME says CAS, so it must pin the CAS —
		// count:0 alone would pass even with updatedAt stripped from the
		// where (the mock doesn't interpret it). The where assertion is the
		// actual guard, here where the name promises it.
		expect(updateManyArg().where).toMatchObject({
			updatedAt: new Date(WHEN),
		});
	});

	it("metadata-only PATCH updates without bumping revision", async () => {
		findFirst
			.mockResolvedValueOnce({ body: plan(), kind: "FULL_PLAN" })
			.mockResolvedValueOnce({ id: ID, revision: 1 });
		updateMany.mockResolvedValueOnce({ count: 1 });
		const res = await PATCH(
			patchRequest({
				name: "renamed",
				description: "new words",
				expectedUpdatedAt: WHEN,
			}),
			withId(ID),
		);
		expect(res.status).toBe(200);
		const call = updateManyArg();
		expect(call.where).toEqual({
			id: ID,
			kind: "FULL_PLAN",
			updatedAt: new Date(WHEN),
		});
		expect(call.data.name).toBe("renamed");
		expect(call.data.description).toBe("new words");
		expect(call.data).not.toHaveProperty("revision");
		expect(call.data).not.toHaveProperty("body");
	});

	it("a CHANGED body bumps revision via increment", async () => {
		const stored = plan();
		const edited = plan();
		(edited as Record<string, unknown>).name = "different plan name";
		findFirst
			.mockResolvedValueOnce({ body: stored })
			.mockResolvedValueOnce({ id: ID, revision: 2 });
		updateMany.mockResolvedValueOnce({ count: 1 });
		const res = await PATCH(
			patchRequest({ plan: edited, expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).toBe(200);
		const call = updateManyArg();
		expect(call.data.revision).toEqual({ increment: 1 });
		expect(call.data.body).toBeDefined();
	});

	it("an IDENTICAL body — even key-order permuted, as jsonb returns it — does not bump", async () => {
		// The stored body round-tripped through jsonb (key order normalized);
		// the client resubmits the same plan in authored order. Equality must
		// be structural or every no-op save would bump revision. The stored
		// side is the SCHEMA OUTPUT (POST/PATCH persist parsed.data.plan, so
		// defaults are materialized) — parse before permuting, or the raw
		// fixture's absent defaults would make every comparison unequal.
		const stored = reorderKeys(encodingPlanSchema.parse(plan()));
		findFirst
			.mockResolvedValueOnce({ body: stored, kind: "FULL_PLAN" })
			.mockResolvedValueOnce({ id: ID, revision: 1 });
		updateMany.mockResolvedValueOnce({ count: 1 });
		const res = await PATCH(
			patchRequest({ plan: plan(), expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).toBe(200);
		const call = updateManyArg();
		expect(call.data).not.toHaveProperty("revision");
		// The body IS still written (the write is honest; only the bump is
		// conditional).
		expect(call.data.body).toBeDefined();
	});

	it("launchDefaults: null clears via DB_NULL; an object passes through", async () => {
		findFirst
			.mockResolvedValueOnce({ body: plan(), kind: "FULL_PLAN" })
			.mockResolvedValueOnce({ id: ID, revision: 1 });
		updateMany.mockResolvedValueOnce({ count: 1 });
		let res = await PATCH(
			patchRequest({ launchDefaults: null, expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).toBe(200);
		expect(updateManyArg().data.launchDefaults).toBe(DB_NULL);
		expect(updateManyArg().data).not.toHaveProperty("revision");

		vi.clearAllMocks();
		findFirst
			.mockResolvedValueOnce({ body: plan(), kind: "FULL_PLAN" })
			.mockResolvedValueOnce({ id: ID, revision: 1 });
		updateMany.mockResolvedValueOnce({ count: 1 });
		res = await PATCH(
			patchRequest({
				launchDefaults: { outputPrefixTemplate: "{template}/{date}-{uuid}" },
				expectedUpdatedAt: WHEN,
			}),
			withId(ID),
		);
		expect(res.status).toBe(200);
		expect(updateManyArg().data.launchDefaults).toEqual({
			outputPrefixTemplate: "{template}/{date}-{uuid}",
		});
	});

	it("409s a rename onto a taken name (P2002)", async () => {
		findFirst.mockResolvedValueOnce({ body: plan(), kind: "FULL_PLAN" });
		updateMany.mockRejectedValueOnce(
			Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
		);
		const res = await PATCH(
			patchRequest({ name: "taken", expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/exists/i);
	});

	it("success returns the re-read row (fresh updatedAt for the next CAS)", async () => {
		const after = {
			id: ID,
			kind: "FULL_PLAN",
			name: "renamed",
			revision: 1,
			updatedAt: "2026-08-17T02:00:01.000Z",
		};
		findFirst
			.mockResolvedValueOnce({ body: plan(), kind: "FULL_PLAN" })
			.mockResolvedValueOnce(after);
		updateMany.mockResolvedValueOnce({ count: 1 });
		const res = await PATCH(
			patchRequest({ name: "renamed", expectedUpdatedAt: WHEN }),
			withId(ID),
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as Record<string, unknown>;
		expect(json.updatedAt).toBe("2026-08-17T02:00:01.000Z");
		expect(JSON.stringify(json)).not.toMatch(/accessKey|secretKey|apiKey/i);
	});
});
