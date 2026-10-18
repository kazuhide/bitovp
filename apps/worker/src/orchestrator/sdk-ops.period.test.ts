import { readFileSync } from "node:fs";
import {
	type CompiledOperation,
	compileLiveChannel,
	compilePlan,
	encodingPlanSchema,
	liveChannelPlanSchema,
} from "@bitovp/core";
import type { AuditEntry } from "@bitovp/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

function setup() {
	const audits: Array<Omit<AuditEntry, "actor"> & { actor?: string | null }> =
		[];
	const bodies: unknown[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			expect(new URL(url).pathname).toBe(
				"/v1/encoding/manifests/dash/manifest-id/periods",
			);
			expect(init.method).toBe("POST");
			bodies.push(JSON.parse(init.body as string));
			return new Response(
				JSON.stringify({ data: { result: { id: "period-id" } } }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}),
	);
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", tenantOrgId: null, bitmovinAccountId: "account" },
		async (entry) => {
			audits.push(entry);
		},
	);
	return { sdk, audits, bodies };
}

describe("first Live DASH Period start projection", () => {
	it("preserves compiler zero through executor, real SDK wire and audit", async () => {
		const plan = liveChannelPlanSchema.parse(
			JSON.parse(
				readFileSync(
					new URL(
						"../../../../packages/core/src/live/__fixtures__/live-akamai-msl5.plan.json",
						import.meta.url,
					),
					"utf8",
				),
			),
		);
		const op = compileLiveChannel(plan).find(
			(op) => op.kind === "CREATE_DASH_PERIOD",
		);
		if (!op) throw new Error("Live fixture must compile a DASH Period");
		expect(op.payload).toEqual({ start: 0 });
		const { sdk, audits, bodies } = setup();
		const result = await executeStep(op, {
			sdk,
			ids: new Map([[op.refs.manifestId as string, "manifest-id"]]),
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
		});
		expect(bodies).toEqual([{ start: 0 }]);
		expect(audits.at(-1)?.request).toEqual({ start: 0 });
		expect(result.request).toEqual({
			start: 0,
			refs: { manifestId: "manifest-id" },
		});
	});
	it.each([
		{},
		{ start: 0 },
		{ start: 12.5 },
	])("preserves stored step payload %j on redelivery without new defaults", async (payload) => {
		const old: CompiledOperation = JSON.parse(
			JSON.stringify({
				step: "period",
				kind: "CREATE_DASH_PERIOD",
				payload,
				refs: { manifestId: "manifest" },
			}),
		);
		const before = JSON.stringify(old);
		const { sdk, audits, bodies } = setup();
		const result = await executeStep(
			old,
			{
				sdk,
				ids: new Map([["manifest", "manifest-id"]]),
				resolveCredential: vi.fn(),
				poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
			},
			{ wasRunning: true },
		);
		expect(bodies).toEqual([payload]);
		expect(audits.at(-1)?.request).toEqual(payload);
		expect(result.request).toEqual({
			...payload,
			refs: { manifestId: "manifest-id" },
		});
		expect(JSON.stringify(old)).toBe(before);
	});
	it("keeps the optional facade argument absent as an empty legacy/VOD body", async () => {
		const { sdk, audits, bodies } = setup();
		await sdk.createDashPeriod("manifest-id");
		await sdk.createDashPeriod("manifest-id", undefined);
		expect(bodies).toEqual([{}, {}]);
		expect(audits.at(-1)?.request).toEqual({});
	});
	it("leaves a newly compiled VOD Period body empty through the same SDK", async () => {
		const plan = encodingPlanSchema.parse(
			JSON.parse(
				readFileSync(
					new URL(
						"../../../../packages/core/src/plan/__fixtures__/dash-template-and-timeline-on-aws.plan.json",
						import.meta.url,
					),
					"utf8",
				),
			),
		);
		const op = compilePlan(plan).find((op) => op.kind === "CREATE_DASH_PERIOD");
		if (!op) throw new Error("VOD fixture must compile a DASH Period");
		expect(op.payload).toEqual({});
		const { sdk, audits, bodies } = setup();
		await executeStep(op, {
			sdk,
			ids: new Map([[op.refs.manifestId as string, "manifest-id"]]),
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
		});
		expect(bodies).toEqual([{}]);
		expect(audits.at(-1)?.request).toEqual({});
	});
});
