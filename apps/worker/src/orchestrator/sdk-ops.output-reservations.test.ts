import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileLiveChannel,
	liveChannelPlanSchema,
	validateLiveChannel,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

describe("Live archive output reservation wire contract", () => {
	it("reserves the primary and mirror files that the installed SDK emits", async () => {
		const plan = liveChannelPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(
						__dirname,
						"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
					),
					"utf8",
				),
			),
		);
		const origin = plan.outputs[0];
		const manifest = plan.liveManifests[0];
		if (origin?.kind !== "S3" || !manifest)
			throw new Error("Missing fixture outputs");
		plan.outputs.push(
			{ ...origin, key: "recording", bucket: "recording-storage" },
			{ ...origin, key: "mirror", bucket: "shared-storage" },
		);
		plan.deliveryMirrors = [{ outputKey: "mirror" }];
		plan.muxings.push({
			key: "archive",
			kind: "MP4",
			streamKey: "v1080",
			additionalStreamKeys: ["a128"],
			filename: manifest.manifestName,
			destination: { outputKey: "recording", path: manifest.destination.path },
		});
		expect(validateLiveChannel(plan).map((issue) => issue.code)).toContain(
			"LIVE_OUTPUT_NAMESPACE_COLLISION",
		);
		const calls: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				calls.push(JSON.parse(init.body as string));
				return new Response(
					JSON.stringify({ data: { result: { id: "created" } } }),
					{ status: 201, headers: { "content-type": "application/json" } },
				);
			}),
		);
		const operations = compileLiveChannel(plan);
		const operation = operations.find(
			(entry) => entry.step === "muxing:archive",
		);
		if (!operation) throw new Error("Missing archive operation");
		const ids = new Map(
			operations.map((entry, index) => [entry.step, `resource-${index}`]),
		);
		const sdk = createBitmovinSdkOps(
			{
				apiKey: "synthetic-only",
				tenantOrgId: null,
				bitmovinAccountId: "synthetic-account",
			},
			async () => {},
		);
		const resolveCredential = vi.fn();
		await executeStep(operation, {
			sdk,
			ids,
			resolveCredential,
			poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			filename: manifest.manifestName,
			outputs: [
				{
					outputId: ids.get("output:recording"),
					outputPath: manifest.destination.path,
				},
				{
					outputId: ids.get("output:mirror"),
					outputPath: manifest.destination.path,
				},
			],
		});
		expect(resolveCredential).not.toHaveBeenCalled();
	});
});
