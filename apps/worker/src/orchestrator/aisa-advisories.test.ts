import { compilePlan, encodingPlanSchema } from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../../packages/core/src/plan/__fixtures__/ai-scene-analysis-pertitle.plan.json";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

it("serializes requested advisory topics through the compiled start and installed SDK without network access", async () => {
	const bodies: Record<string, unknown>[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url, init) => {
			if (String(url).endsWith("/start"))
				bodies.push(JSON.parse(init?.body ?? "{}"));
			return new Response(
				JSON.stringify({ data: { result: { id: "enc", status: "CREATED" } } }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}),
	);
	const plan = encodingPlanSchema.parse({
		...fixture,
		aiSceneAnalysis: {
			...fixture.aiSceneAnalysis,
			regulatoryAdvisories: { topics: ["TOBACCO"] },
		},
	});
	const start = compilePlan(plan).find((op) => op.kind === "START_ENCODING");
	if (!start) throw new Error("Missing compiled start");
	const ids = new Map(
		Object.values(start.refs).flatMap((key) =>
			typeof key === "string"
				? [[key, key.startsWith("output:") ? "out" : "enc"] as [string, string]]
				: [],
		),
	);
	const sdk = createBitmovinSdkOps(
		{ apiKey: "synthetic-only" },
		async () => {},
	);
	await executeStep(start, {
		sdk,
		ids,
		resolveCredential: vi.fn(),
		poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
	});
	expect(bodies).toHaveLength(1);
	expect(bodies[0]).toHaveProperty(
		"aiSceneAnalysis.features.regulatoryAdvisories",
		{ topics: ["TOBACCO"] },
	);
});
