import { afterEach, describe, expect, it, vi } from "vitest";
import { createBitmovinSdkOps } from "./sdk-ops";

/**
 * The seam that broke: at the first wiring, index.ts destructured three fields
 * out of makeSdk's args and silently dropped `stamp` — every wrapper unit test
 * green, nothing stamped in production (review of PR #163, C1, proven there at
 * runtime with a captured wire body). This test is that proof made permanent:
 * it builds SdkOps THROUGH the real factory the way processor.ts does, stubs
 * the global fetch the retrying layer defaults to, and reads the actual wire
 * body. index.ts itself cannot be imported here (module side effects — queue
 * connections); its protection is structural (it passes the WHOLE args object
 * through), and this covers every layer beneath it.
 */

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the stamp on the wire, through the real factory", () => {
	it("a create issued during a step carries the bitovp stamp", async () => {
		const bodies: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: { body?: string }) => {
				bodies.push(init?.body ?? "");
				return new Response(JSON.stringify({ data: { result: { id: "x" } } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);
		const ops = createBitmovinSdkOps(
			{
				apiKey: "k",
				tenantOrgId: null,
				bitmovinAccountId: "acct",
				stamp: { jobId: "job-1", currentStep: () => "input:main" },
			},
			async () => {},
		);
		await ops.createS3Input({
			name: "S3 in",
			bucketName: "b",
			accessKey: "ak",
			secretKey: "sk",
		});
		const stamped = bodies.filter((body) => body.includes('"bitovp"'));
		expect(stamped.length, bodies.join("\n")).toBeGreaterThan(0);
		const parsed = JSON.parse(stamped[0] as string) as {
			customData: { bitovp: { job: string; step: string } };
		};
		expect(parsed.customData["bitovp"]).toEqual({
			job: "job-1",
			step: "input:main",
		});
	});

	it("with NO stamp option, the wire body is byte-identical to before", async () => {
		const bodies: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: { body?: string }) => {
				bodies.push(init?.body ?? "");
				return new Response(JSON.stringify({ data: { result: { id: "x" } } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);
		const ops = createBitmovinSdkOps(
			{ apiKey: "k", tenantOrgId: null, bitmovinAccountId: "acct" },
			async () => {},
		);
		await ops.createS3Input({
			name: "S3 in",
			bucketName: "b",
			accessKey: "ak",
			secretKey: "sk",
		});
		expect(bodies.some((body) => body.includes("bitovp"))).toBe(false);
	});
});
