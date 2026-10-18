import { describe, expect, it, vi } from "vitest";
import { buildPlan } from "../wizard/build-plan";
import { planToWizardState } from "../wizard/plan-to-wizard";
import { DELIVERY_SPECS } from "./delivery-presets";
import { encodingPlanSchema } from "./schema";
import { submitEncodingJob } from "./submit";

/**
 * : a plan may COMMIT to a delivery spec, and the commitment is
 * enforced at the SUBMIT BOUNDARY — not in validatePlan, which the wizard
 * runs live on every keystroke (review-210 I3). Every submitter shares this
 * pipeline, so one test here covers the API route, the watch sweep and the
 * preset-driven paths.
 */
const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000aa";

function makeDeps(over: Record<string, unknown> = {}) {
	const created: unknown[] = [];
	const enqueued: string[] = [];
	const recordEgress = vi.fn(async (_issues?: unknown) => {});
	const deps = {
		validationOptions: {},
		recordEgress,
		loadAccountDefaults: async () => ({ defaults: {} }),
		createJob: async (data: unknown) => {
			created.push(data);
			return { id: `job-${created.length}` };
		},
		enqueue: async (jobId: string) => {
			enqueued.push(jobId);
		},
		markEnqueueFailed: async () => {},
		...over,
	};
	return { deps, created, enqueued, recordEgress };
}

/** Dot-path resolver mirroring the checker's (numeric segments index arrays). */
function resolve(value: unknown, path: string): unknown {
	let cursor: unknown = value;
	for (const segment of path.split(".")) {
		if (cursor === null || typeof cursor !== "object") {
			return undefined;
		}
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

/**
 * Break ONE constraint while keeping the plan schema-valid: pick a numeric
 * leaf (a string leaf is usually an enum the plan schema would reject, and a
 * plan that cannot PARSE proves nothing about the conformance check).
 */
function breakOneConstraint(spec: (typeof DELIVERY_SPECS)[number]) {
	const target = spec.constraints.find(
		(c) => typeof resolve(spec.plan, c.path) === "number",
	);
	if (!target) {
		throw new Error(`${spec.id} has no numeric constraint to break`);
	}
	const broken = structuredClone(spec.plan) as Record<string, unknown>;
	const segments = target.path.split(".");
	let cursor: Record<string, unknown> = broken;
	for (const segment of segments.slice(0, -1)) {
		cursor = cursor[segment] as Record<string, unknown>;
	}
	const leaf = segments[segments.length - 1] as string;
	const current = cursor[leaf] as number;
	cursor[leaf] =
		target.expect.gte !== undefined
			? target.expect.gte - 1
			: target.expect.lte !== undefined
				? target.expect.lte + 1
				: current + 7;
	return { broken, constraint: target };
}

const withAccount = (plan: Record<string, unknown>, delivery?: unknown) => ({
	...plan,
	bitmovin: {
		...(plan.bitmovin as Record<string, unknown>),
		accountId: ACCOUNT_ID,
	},
	...(delivery ? { delivery } : {}),
});

const spec0 = DELIVERY_SPECS[0];
if (!spec0) {
	throw new Error("no shipped delivery spec");
}

describe("delivery commitment (ledger #82)", () => {
	it("every shipped spec's own reference plan submits cleanly under its own commitment", async () => {
		expect(DELIVERY_SPECS.length).toBeGreaterThan(1);
		for (const spec of DELIVERY_SPECS) {
			const { deps, created } = makeDeps();
			const outcome = await submitEncodingJob(
				withAccount(spec.plan as Record<string, unknown>, { specId: spec.id }),
				deps as never,
			);
			expect(outcome.ok, `${spec.id} must conform to itself`).toBe(true);
			expect(created).toHaveLength(1);
		}
	});

	it("refuses a deviating commitment BEFORE any IO, naming requirement, path and actual", async () => {
		const { broken, constraint } = breakOneConstraint(spec0);
		const { deps, created, enqueued, recordEgress } = makeDeps();
		const outcome = await submitEncodingJob(
			withAccount(broken, { specId: spec0.id }),
			deps as never,
		);
		expect(outcome).toMatchObject({ ok: false, code: "DELIVERY_DEVIATION" });
		if (outcome.ok) {
			throw new Error("must refuse");
		}
		// The message is a HEADLINE; the ISSUES carry the detail the sweep joins
		// (review-210 I1 — spelling both printed every deviation twice).
		expect(outcome.message).toContain("deviation");
		const detail = (outcome.issues ?? []).map((i) => i.message).join(" | ");
		expect(detail).toContain(constraint.requirement);
		expect(detail).toContain(constraint.path);
		expect(detail).toContain(String(resolve(broken, constraint.path)));
		expect(outcome.issues?.map((i) => i.code)).toContain(
			"PLAN_DELIVERY_DEVIATION",
		);
		// Nothing persisted, nothing enqueued, no egress row.
		expect(created).toHaveLength(0);
		expect(enqueued).toEqual([]);
		expect(recordEgress).not.toHaveBeenCalled();
	});

	it("reports EVERY deviation in the message, not just the first", async () => {
		const broken = structuredClone(spec0.plan) as Record<string, unknown>;
		const numeric = spec0.constraints.filter(
			(c) => typeof resolve(spec0.plan, c.path) === "number",
		);
		expect(numeric.length).toBeGreaterThan(1);
		for (const c of numeric) {
			const segments = c.path.split(".");
			let cursor: Record<string, unknown> = broken;
			for (const segment of segments.slice(0, -1)) {
				cursor = cursor[segment] as Record<string, unknown>;
			}
			const leaf = segments[segments.length - 1] as string;
			cursor[leaf] =
				c.expect.gte !== undefined
					? c.expect.gte - 1
					: c.expect.lte !== undefined
						? c.expect.lte + 1
						: (cursor[leaf] as number) + 7;
		}
		const { deps } = makeDeps();
		const outcome = await submitEncodingJob(
			withAccount(broken, { specId: spec0.id }),
			deps as never,
		);
		if (outcome.ok) {
			throw new Error("must refuse");
		}
		expect(outcome.issues?.map((i) => i.path).sort()).toEqual(
			numeric.map((c) => c.path).sort(),
		);
	});

	it("the message carries the BOUND per operator (>= and <=), not only the requirement", async () => {
		const bounded = spec0.constraints.find(
			(c) => c.expect.gte !== undefined || c.expect.lte !== undefined,
		);
		if (!bounded) {
			throw new Error("no bounded constraint");
		}
		const write = (value: number) => {
			const plan = structuredClone(spec0.plan) as Record<string, unknown>;
			const segments = bounded.path.split(".");
			let cursor: Record<string, unknown> = plan;
			for (const segment of segments.slice(0, -1)) {
				cursor = cursor[segment] as Record<string, unknown>;
			}
			cursor[segments[segments.length - 1] as string] = value;
			return plan;
		};
		if (bounded.expect.gte !== undefined) {
			const { deps } = makeDeps();
			const outcome = await submitEncodingJob(
				withAccount(write(bounded.expect.gte - 1), { specId: spec0.id }),
				deps as never,
			);
			if (outcome.ok) {
				throw new Error("must refuse");
			}
			expect(
				(outcome.issues ?? []).map((i) => i.message).join(" | "),
			).toContain(`>= ${bounded.expect.gte}`);
		}
		if (bounded.expect.lte !== undefined) {
			const { deps } = makeDeps();
			const outcome = await submitEncodingJob(
				withAccount(write(bounded.expect.lte + 1), { specId: spec0.id }),
				deps as never,
			);
			if (outcome.ok) {
				throw new Error("must refuse");
			}
			expect(
				(outcome.issues ?? []).map((i) => i.message).join(" | "),
			).toContain(`<= ${bounded.expect.lte}`);
		}
	});

	it("WARN proceeds AND RECORDS — including for an UNKNOWN spec id", async () => {
		const { broken } = breakOneConstraint(spec0);
		for (const specId of [spec0.id, "mezz-does-not-exist"]) {
			const { deps, created, recordEgress } = makeDeps();
			const outcome = await submitEncodingJob(
				withAccount(broken, { specId, onDeviation: "WARN" }),
				deps as never,
			);
			expect(outcome.ok, `WARN must proceed for ${specId}`).toBe(true);
			expect(created).toHaveLength(1);
			// RECORDS (review-210 I2): the first cut returned silently, so a WARN
			// commitment was byte-identical to NO commitment for the unattended
			// submitter this feature exists for.
			const recorded = recordEgress.mock.calls[0]?.[0] as
				| { code: string; level: string }[]
				| undefined;
			const warnings = (recorded ?? []).filter((i) =>
				i.code.startsWith("PLAN_DELIVERY"),
			);
			expect(warnings.length, `WARN must record for ${specId}`).toBeGreaterThan(
				0,
			);
			expect(warnings.every((i) => i.level === "warning")).toBe(true);
		}
	});

	it("an unknown specId is refused by name under REFUSE, listing what IS shipped", async () => {
		const { deps } = makeDeps();
		const outcome = await submitEncodingJob(
			withAccount(spec0.plan as Record<string, unknown>, {
				specId: "mezz-does-not-exist",
			}),
			deps as never,
		);
		if (outcome.ok) {
			throw new Error("must refuse");
		}
		expect(outcome.code).toBe("DELIVERY_DEVIATION");
		expect(outcome.message).toContain("mezz-does-not-exist");
		for (const shipped of DELIVERY_SPECS) {
			expect(outcome.message).toContain(shipped.id);
		}
	});

	it("re-run does NOT re-litigate a commitment (skipDeliveryCommitment)", async () => {
		// A spec tightened after a job shipped must not make that job
		// un-re-runnable — the failure mode review-210 C1 named.
		const { broken } = breakOneConstraint(spec0);
		const { deps, created } = makeDeps({ skipDeliveryCommitment: true });
		const outcome = await submitEncodingJob(
			withAccount(broken, { specId: spec0.id }),
			deps as never,
		);
		expect(outcome.ok).toBe(true);
		expect(created).toHaveLength(1);
	});

	it("a plan with NO commitment is unaffected — proven on a plan that WOULD fail", async () => {
		const { broken } = breakOneConstraint(spec0);
		const parsed = encodingPlanSchema.parse(broken);
		expect(parsed.delivery).toBeUndefined();
		const { deps, created } = makeDeps();
		const outcome = await submitEncodingJob(withAccount(broken), deps as never);
		expect(outcome.ok).toBe(true);
		expect(created).toHaveLength(1);
	});

	it("a commitment survives the wizard round trip, so a committed plan stays form-representable", () => {
		const committed = encodingPlanSchema.parse({
			...spec0.plan,
			delivery: { specId: spec0.id, onDeviation: "WARN" },
		});
		const state = planToWizardState(committed);
		if (!state) {
			throw new Error("a committed plan must map to wizard state");
		}
		expect(buildPlan(state).delivery).toEqual({
			specId: spec0.id,
			onDeviation: "WARN",
		});
	});
});
