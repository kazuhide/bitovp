import { describe, expect, it, vi } from "vitest";
import { type ExecutorContext, executeStep } from "../executor";
import { fakeSdk } from "../fake-sdk";
import type { OpsContext } from "./context";
import { createMediaFilter } from "./media-filters";
import { signWatermarkImage } from "./watermark-image";

const input = {
	key: "main",
	kind: "S3",
	credentialId: "00000000-0000-4000-8000-000000000001",
	bucket: "images",
};
const resolve = vi.fn(async () => ({
	provider: "AWS_S3",
	config: { region: "ap-northeast-1" },
	secret: { accessKeyId: "EXAMPLE", secretAccessKey: "EXAMPLE_SECRET" },
}));
describe("P1 media filter execution", () => {
	it("signs a storage reference at runtime and retains neither URL nor credentials in step snapshots", async () => {
		const sdk = fakeSdk();
		const ctx: ExecutorContext = {
			sdk,
			ids: new Map(),
			resolveCredential: resolve,
			poll: { intervalMs: 1, timeoutMs: 1, sleep: async () => {} },
		};
		const result = await executeStep(
			{
				kind: "CREATE_FILTER_WATERMARK",
				step: "filter:v:image",
				refs: {},
				payload: {
					inputKey: "main",
					imagePath: "logo.png",
					imageInput: input,
					left: 0,
					top: 0,
				},
			},
			ctx,
		);
		const call = vi.mocked(sdk.createMediaFilter).mock.calls[0];
		if (!call) throw new Error("SDK filter was not called");
		const [, payload] = call;
		expect(payload).toMatchObject({ left: 0, top: 0 });
		expect(payload).not.toHaveProperty("inputKey");
		const url = new URL(String(payload.image));
		expect(url.hostname).toContain("ap-northeast-1");
		expect(url.searchParams.get("X-Amz-Expires")).toBe("604800");
		expect(JSON.stringify(result)).not.toContain("X-Amz");
		expect(JSON.stringify(result)).not.toContain("EXAMPLE_SECRET");
	});
	it.each([
		["DENOISE_HQDN3D", "denoiseHqdn3d", { lumaSpatial: 4, chromaTmp: 0 }],
		[
			"UNSHARP",
			"unsharp",
			{ lumaMatrixHorizontalSize: 5, lumaEffectStrength: 0.5 },
		],
		["CROP", "crop", { left: 4, unit: "PIXELS" }],
		["ROTATE", "rotate", { rotation: 90 }],
		[
			"TEXT",
			"text",
			{ text: "hello", x: "10", y: "20", font: "DEJAVUSANS", box: false },
		],
		["AUDIO_VOLUME", "audioVolume", { volume: -6, unit: "DB", format: "FLT" }],
		[
			"EBU_R128_SINGLE_PASS",
			"ebuR128SinglePass",
			{ integratedLoudness: -23, maximumTruePeakLevel: -1 },
		],
	] as const)("constructs the SDK %s model without inventing unset parameters", async (kind, endpoint, params) => {
		const create = vi.fn(async () => ({ id: "id" }));
		const audited = vi.fn(async (_method, _path, _request, fn) => fn());
		const ctx = {
			api: { encoding: { filters: { [endpoint]: { create } } } },
			audited,
			id: (r: { id: string }) => r.id,
		} as unknown as OpsContext;
		await createMediaFilter(ctx, kind, params);
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ ...params, type: kind }),
		);
		expect(audited.mock.calls[0]?.[2]).toEqual(params);
	});
	it("redacts image URL even when the SDK echoes it in success or an error", async () => {
		const image = "https://private.example/logo?X-Amz-Signature=SECRET";
		const create = vi.fn(async () => ({ id: "image", image }));
		const snapshots: unknown[] = [];
		const ctx = {
			api: { encoding: { filters: { watermark: { create } } } },
			id: (r: { id: string }) => r.id,
			audited: async (
				_m: string,
				_p: string,
				request: unknown,
				fn: () => Promise<unknown>,
				response: (r: unknown) => unknown,
			) => {
				snapshots.push(request);
				const r = await fn();
				snapshots.push(response(r));
				return r;
			},
		} as unknown as OpsContext;
		await createMediaFilter(ctx, "WATERMARK", { image });
		expect(JSON.stringify(snapshots)).not.toContain("SECRET");
		create.mockRejectedValueOnce(new Error(image));
		await expect(
			createMediaFilter(ctx, "WATERMARK", { image }),
		).rejects.toThrow("Watermark filter creation failed");
	});
	it("rejects unsupported and mismatched storage credentials", async () => {
		await expect(
			signWatermarkImage(
				{
					...input,
					kind: "HTTPS",
					credentialId: undefined,
					bucket: undefined,
					host: "example.com",
				},
				"logo.png",
				resolve,
			),
		).rejects.toThrow();
		await expect(
			signWatermarkImage(input, "logo.png", async () => ({
				provider: "GCS_HMAC",
				config: {},
				secret: {},
			})),
		).rejects.toThrow("does not match");
	});
});
