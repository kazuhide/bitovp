import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema } from "@bitovp/core";
import { samplePresetPlan } from "@bitovp/core/presets";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const create = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { preset: { findMany, create } },
	}),
}));

import { GET, POST } from "./route";

// A known-good plan (the canonical starter fixture) → schema- and
// constraint-valid, secret-free (credentialId refs only).
const VALID_PLAN = samplePresetPlan("fixed-bitrate-hls-on-aws");

beforeEach(() => {
	vi.clearAllMocks();
});

function postRequest(body: unknown): Request {
	return new Request("http://test/api/presets", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

describe("GET /api/presets", () => {
	it("lists FULL_PLAN presets lean (no body selected)", async () => {
		findMany.mockResolvedValueOnce([
			{ id: "p1", name: "mine", description: null, createdAt: "2026-06-19" },
		]);
		const res = await GET(new Request("http://test/api/presets"));
		expect(res.status).toBe(200);
		expect(findMany).toHaveBeenCalledWith({
			where: { kind: "FULL_PLAN" },
			select: {
				id: true,
				name: true,
				description: true,
				// : the delivery-preset grouping rides the lean list.
				category: true,
				createdAt: true,
				revision: true,
				updatedAt: true,
				_count: {
					select: {
						encodingJobs: true,
						liveChannels: true,
						watchRules: true,
					},
				},
			},
			orderBy: { createdAt: "desc" },
		});
		const body = (await res.json()) as Record<string, unknown>[];
		// The list projection never carries plan bodies / credential material.
		expect(body[0]).not.toHaveProperty("body");
	});
});

describe("POST /api/presets", () => {
	it("creates a FULL_PLAN preset from a valid plan", async () => {
		create.mockResolvedValueOnce({
			id: "p1",
			name: "my-preset",
			description: "notes",
			createdAt: "2026-06-19",
		});
		const res = await POST(
			postRequest({
				name: "my-preset",
				description: "notes",
				plan: VALID_PLAN,
			}),
		);
		expect(res.status).toBe(201);
		// The route stores the schema-PARSED plan (zod fills defaults like
		// `thumbnails: []`), i.e. the canonical document — not the raw input.
		expect(create).toHaveBeenCalledWith({
			data: {
				kind: "FULL_PLAN",
				name: "my-preset",
				description: "notes",
				// : plain plan presets carry neither grouping nor spec.
				category: null,
				spec: undefined,
				body: encodingPlanSchema.parse(VALID_PLAN),
			},
			select: {
				id: true,
				name: true,
				description: true,
				category: true,
				createdAt: true,
				revision: true,
				updatedAt: true,
			},
		});
		// The created-row response is lean — no body echoed back.
		const json = (await res.json()) as Record<string, unknown>;
		expect(json).not.toHaveProperty("body");
	});

	it("400s a malformed request (missing plan)", async () => {
		const res = await POST(postRequest({ name: "no-plan" }));
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("400s a structurally-valid-but-constraint-invalid plan", async () => {
		// Duplicate input keys → PLAN_DUPLICATE_KEY (a validatePlan error the
		// schema parse alone would not catch).
		const dup = samplePresetPlan("fixed-bitrate-hls-on-aws");
		if (!dup) {
			throw new Error("fixture missing");
		}
		const inputs = dup.inputs as Record<string, unknown>[];
		dup.inputs = [inputs[0], { ...inputs[0] }];
		const res = await POST(postRequest({ name: "dup", plan: dup }));
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("409s on a duplicate preset name (Prisma P2002)", async () => {
		create.mockRejectedValueOnce(
			Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
		);
		const res = await POST(postRequest({ name: "taken", plan: VALID_PLAN }));
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/exists/i);
	});
});

describe("LIVE_PLAN templates (ledger #109 PR4)", () => {
	const LIVE_PLAN_BODY = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../packages/core/src/live/__fixtures__/live-zixi.plan.json",
			),
			"utf8",
		),
	) as Record<string, unknown>;

	it("?kind=LIVE_PLAN lists live templates; a bad kind 400s", async () => {
		findMany.mockResolvedValueOnce([]);
		let res = await GET(new Request("http://test/api/presets?kind=LIVE_PLAN"));
		expect(res.status).toBe(200);
		expect(findMany.mock.calls[0]?.[0]?.where).toEqual({ kind: "LIVE_PLAN" });

		res = await GET(new Request("http://test/api/presets?kind=LADDER"));
		expect(res.status).toBe(400);
	});

	it("POST kind=LIVE_PLAN validates the LIVE schema and stores the kind", async () => {
		create.mockResolvedValueOnce({ id: "lp1", name: "ch", createdAt: "x" });
		const res = await POST(
			postRequest({ kind: "LIVE_PLAN", name: "ch", plan: LIVE_PLAN_BODY }),
		);
		expect(res.status).toBe(201);
		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data.kind).toBe("LIVE_PLAN");
	});

	it("POST kind=LIVE_PLAN runs the LIVE validator, not just the schema (review-109pr1 L2 — this gate was unpinned and a disabling mutation SURVIVED)", async () => {
		// Duplicate rendition keys: schema-valid, validateLiveChannel-error
		// (LIVE_DUPLICATE_KEY) — the live sibling of the VOD dup-inputs test.
		const dup = structuredClone(LIVE_PLAN_BODY) as {
			renditions: Record<string, unknown>[];
		};
		dup.renditions = [dup.renditions[0], { ...dup.renditions[0] }] as Record<
			string,
			unknown
		>[];
		const res = await POST(
			postRequest({ kind: "LIVE_PLAN", name: "dup-live", plan: dup }),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/validation/i);
		expect(create).not.toHaveBeenCalled();
	});

	it("POST kind=LIVE_PLAN refuses an ENCODING plan body — kinds are not interchangeable", async () => {
		const res = await POST(
			postRequest({ kind: "LIVE_PLAN", name: "nope", plan: VALID_PLAN }),
		);
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});
});
