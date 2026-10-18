import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 *  PR3 — rule creation is validated AT THE DOOR: the preset must
 * be a usable watch template (core's one-input rule), so the sweep never
 * discovers an unusable rule at fire time.
 */

const ruleFindMany = vi.fn();
const ruleCreate = vi.fn();
const groupBy = vi.fn();
const presetFindUnique = vi.fn();
const credentialFindUnique = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			watchRule: { findMany: ruleFindMany, create: ruleCreate },
			watchedObject: { groupBy },
			preset: { findUnique: presetFindUnique },
			credential: { findUnique: credentialFindUnique },
		},
	}),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GET, POST } from "./route";

const PRESET_ID = "00000000-0000-4000-8000-0000000000e1";
const CRED_ID = "00000000-0000-4000-8000-0000000000e2";

const VALID_PLAN = JSON.parse(
	readFileSync(
		join(
			__dirname,
			"../../../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-dash-hls-streamcondition-on-aws.plan.json",
		),
		"utf8",
	),
);

const body = (over: Record<string, unknown> = {}) => ({
	name: "mezz-drop",
	credentialId: CRED_ID,
	bucket: "hot",
	prefix: "in/",
	presetId: PRESET_ID,
	outputPrefixTemplate: "watch/{basename}",
	...over,
});

const post = (payload: unknown) =>
	new Request("http://test/api/watch-rules", {
		method: "POST",
		body: JSON.stringify(payload),
	});

beforeEach(() => {
	vi.clearAllMocks();
	presetFindUnique.mockResolvedValue({ kind: "FULL_PLAN", body: VALID_PLAN });
	// The HEALTHY default: a real provider that matches the fixture's S3 input.
	// Returning no provider would leave every test in this file exercising the
	// "caller could not resolve one" arm, where the compatibility check is
	// skipped by design — the arm would then be the silent default rather than
	// the deliberate case it is meant to be.
	credentialFindUnique.mockResolvedValue({ id: CRED_ID, provider: "AWS_S3" });
	ruleCreate.mockImplementation(async ({ data }) => ({ id: "r-1", ...data }));
});

describe("POST /api/watch-rules", () => {
	it("creates a rule with defaults applied", async () => {
		const res = await POST(post(body()));
		expect(res.status).toBe(201);
		expect(ruleCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				name: "mezz-drop",
				pollIntervalSec: 120,
				stabilityChecks: 2,
				maxConcurrentJobs: 3,
				enabled: true,
			}),
		});
	});

	it("refuses a credential whose provider cannot back the template's input", async () => {
		// The fixture's sole input is S3, so an Azure credential cannot back it.
		// Before this check the rule saved happily, claimed objects, and failed
		// on every one of them in the worker's credential mapping — with the
		// reason invisible at folder-configuration time.
		credentialFindUnique.mockResolvedValue({
			id: CRED_ID,
			provider: "AZURE_BLOB",
		});
		const res = await POST(post(body()));
		expect(res.status).toBe(422);
		expect(JSON.stringify(await res.json())).toContain("CREDENTIAL_PROVIDER");
		expect(ruleCreate).not.toHaveBeenCalled();
	});

	it("refuses a template whose input kind substitution cannot target", async () => {
		presetFindUnique.mockResolvedValue({
			kind: "FULL_PLAN",
			body: {
				...VALID_PLAN,
				inputs: [
					{
						key:
							(VALID_PLAN as { inputs: { key: string }[] }).inputs[0]?.key ??
							"in",
						kind: "AZURE",
						credentialId: CRED_ID,
						container: "c",
						name: "azure in",
					},
				],
			},
		});
		credentialFindUnique.mockResolvedValue({
			id: CRED_ID,
			provider: "AZURE_BLOB",
		});
		const res = await POST(post(body()));
		expect(res.status).toBe(422);
		expect(JSON.stringify(await res.json())).toContain("INPUT_KIND");
		expect(ruleCreate).not.toHaveBeenCalled();
	});

	it("still creates when the credential DOES back the input kind", async () => {
		// The accept arm, so the two refusals above cannot be satisfied by a
		// guard that refuses everything — the failure mode this file already
		// caught once (review-299 F2 pinned the WIRING, not just the rule).
		credentialFindUnique.mockResolvedValue({ id: CRED_ID, provider: "AWS_S3" });
		expect((await POST(post(body()))).status).toBe(201);
		expect(ruleCreate).toHaveBeenCalled();
	});

	it("refuses an uppercase/spacey name (it becomes a label and a path token)", async () => {
		expect((await POST(post(body({ name: "Mezz Drop" })))).status).toBe(400);
		expect(ruleCreate).not.toHaveBeenCalled();
	});

	it("refuses a rule whose preset writes into the folder it watches", async () => {
		/**
		 * The guard's WIRING, which was pinned by nothing (review-299 F2):
		 * deleting the `watchSelfIntersectionIssues` call from this route left
		 * all 27 tests here green. The core rule was well tested; the route that
		 * has to call it was not, which is the same shape as the corpus
		 * verifier's unpinned call site one PR earlier.
		 *
		 * The plan's outputs are pointed at the watched bucket, and the template
		 * renders under the watched prefix — the unbounded, billable re-encode
		 * loop of F63-RUN-002.
		 */
		const looping = structuredClone(VALID_PLAN) as {
			outputs: Record<string, unknown>[];
		};
		for (const output of looping.outputs) {
			output.credentialId = CRED_ID;
			output.bucket = "hot";
		}
		presetFindUnique.mockResolvedValue({
			kind: "FULL_PLAN",
			body: looping,
		});
		const res = await POST(
			post(body({ prefix: "in/", outputPrefixTemplate: "in/out/{basename}" })),
		);
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			details: { issues: [{ code: "SELF_INTERSECTION" }] },
		});
		expect(ruleCreate).not.toHaveBeenCalled();
	});

	it("still creates the rule when the outputs are somewhere else", async () => {
		// The arm that keeps the pin above honest: the 422 must come from the
		// OVERLAP, not from the fixture being unusable as a template.
		const elsewhere = structuredClone(VALID_PLAN) as {
			outputs: Record<string, unknown>[];
		};
		for (const output of elsewhere.outputs) {
			output.credentialId = CRED_ID;
			output.bucket = "delivery";
		}
		presetFindUnique.mockResolvedValue({ kind: "FULL_PLAN", body: elsewhere });
		const res = await POST(
			post(body({ prefix: "in/", outputPrefixTemplate: "in/out/{basename}" })),
		);
		expect(res.status).toBe(201);
		expect(ruleCreate).toHaveBeenCalled();
	});

	it("refuses a preset that is not FULL_PLAN", async () => {
		presetFindUnique.mockResolvedValue({ kind: "LADDER", body: {} });
		const res = await POST(post(body()));
		expect(res.status).toBe(422);
		expect(ruleCreate).not.toHaveBeenCalled();
	});

	it("refuses a preset that cannot serve as a watch TEMPLATE, naming why", async () => {
		presetFindUnique.mockResolvedValue({
			kind: "FULL_PLAN",
			body: {
				...VALID_PLAN,
				inputs: [
					...VALID_PLAN.inputs,
					{ ...VALID_PLAN.inputs[0], key: "second" },
				],
			},
		});
		const res = await POST(post(body()));
		expect(res.status).toBe(422);
		const payload = (await res.json()) as {
			details: { issues: { code: string }[] };
		};
		expect(payload.details.issues[0]).toMatchObject({ code: "INPUT_COUNT" });
	});

	it("refuses a missing credential", async () => {
		credentialFindUnique.mockResolvedValue(null);
		expect((await POST(post(body()))).status).toBe(422);
	});

	it("maps the unique-name P2002 to a 409", async () => {
		const err = new Error("unique") as Error & { code: string };
		err.code = "P2002";
		ruleCreate.mockRejectedValue(err);
		expect((await POST(post(body()))).status).toBe(409);
	});
});

describe("GET /api/watch-rules", () => {
	it("merges per-state object counts onto each rule", async () => {
		ruleFindMany.mockResolvedValue([
			{
				id: "r-1",
				name: "a",
				credential: { label: "cred" },
				preset: { name: "p" },
			},
		]);
		groupBy.mockResolvedValue([
			{ watchRuleId: "r-1", state: "SUBMITTED", _count: { _all: 3 } },
			{ watchRuleId: "r-1", state: "ERROR", _count: { _all: 1 } },
		]);
		const res = await GET();
		const rows = (await res.json()) as {
			objectCounts: Record<string, number>;
			credentialLabel: string;
		}[];
		expect(rows[0]?.objectCounts).toEqual({ SUBMITTED: 3, ERROR: 1 });
		expect(rows[0]?.credentialLabel).toBe("cred");
	});
});
