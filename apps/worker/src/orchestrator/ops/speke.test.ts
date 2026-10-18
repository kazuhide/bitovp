import type { CompiledOperation } from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorContext } from "../executor";
import { fakeSdk } from "../fake-sdk";
import type { OpsContext } from "./context";
import { createDrmOps } from "./drm";
import { executeDrmStep } from "./exec-drm";

const provider = {
	url: "https://keys.example.com/secret-endpoint",
	username: "secret-user",
	password: "secret-password",
	apiKey: "secret-api-key",
};
function setup(window = false) {
	const snapshots: unknown[] = [];
	const create = vi.fn().mockResolvedValue({ id: "drm-new", provider });
	const list = vi.fn().mockResolvedValue({ items: [] });
	const customdata = vi.fn();
	const adopt = vi.fn().mockResolvedValue(undefined);
	const context = {
		options: {
			stamp: {
				jobId: "job",
				currentStep: () => "drm:keys",
				adoptWindow: () => window,
			},
		},
		id: (value: { id: string }) => value.id,
		muxings: () => ({
			fmp4: {
				drm: { speke: { create, list, customdata: { get: customdata } } },
			},
		}),
		audited: async (
			_method: string,
			_path: string,
			request: unknown,
			fn: () => Promise<unknown>,
			response: (v: unknown) => unknown,
		) => {
			snapshots.push(request);
			const value = await fn();
			snapshots.push(response(value));
			return value;
		},
		stampAuditAdopt: () => adopt,
	} as unknown as OpsContext;
	return {
		...createDrmOps(context),
		snapshots,
		create,
		list,
		customdata,
		adopt,
	};
}
afterEach(() => vi.unstubAllEnvs());
describe("SPEKE worker", () => {
	it("sends typed SPEKE auth but captures only public data", async () => {
		const sdk = setup();
		await sdk.createSpekeDrm("enc", "mux", {
			muxingKind: "FMP4",
			provider,
			systemIds: ["edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"],
			contentId: "movie",
		});
		expect(sdk.create.mock.calls[0]?.[2]).toMatchObject({
			provider,
			contentId: "movie",
		});
		for (const secret of Object.values(provider))
			expect(JSON.stringify(sdk.snapshots)).not.toContain(secret);
		expect(sdk.snapshots).toContainEqual({ id: "drm-new" });
	});
	it("does not propagate provider authentication echoed in an error", async () => {
		const sdk = setup();
		sdk.create.mockRejectedValue({
			httpStatusCode: 400,
			errorCode: 1001,
			requestId: "request-safe",
			shortMessage: `Failed ${provider.url} ${provider.password}`,
			message: JSON.stringify(provider),
		});
		await expect(
			sdk.createSpekeDrm("enc", "mux", {
				muxingKind: "FMP4",
				provider,
				systemIds: ["edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"],
			}),
		).rejects.toMatchObject({
			httpStatusCode: 400,
			errorCode: 1001,
			requestId: "request-safe",
			shortMessage: "SPEKE key provider creation failed",
		});
	});
	it("adopts a same-job lost creation rather than retrieving another set of keys", async () => {
		const sdk = setup(true);
		sdk.list.mockResolvedValue({ items: [{ id: "drm-lost", provider }] });
		sdk.customdata.mockResolvedValue({
			customData: { bitovp: { job: "job", step: "drm:keys" } },
		});
		expect(
			await sdk.createSpekeDrm("enc", "mux", {
				muxingKind: "FMP4",
				provider,
				systemIds: ["edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"],
			}),
		).toBe("drm-lost");
		expect(sdk.create).not.toHaveBeenCalled();
		expect(sdk.list).toHaveBeenCalledWith("enc", "mux", {
			limit: 100,
			offset: 0,
		});
		expect(sdk.adopt).toHaveBeenCalledWith("drm-lost", "pre");
	});
	it("resolves encrypted credentials only at execution; blocks invalid credentials and egress", async () => {
		vi.stubEnv("SECRET_EGRESS_ALLOWED_HOSTS", "keys.example.com");
		const sdk = fakeSdk();
		const ctx = {
			sdk,
			ids: new Map([
				["encoding", "enc"],
				["mux", "mux"],
				["output", "out"],
			]),
			resolveCredential: vi.fn().mockResolvedValue({
				provider: "DRM_SPEKE",
				config: {},
				secret: provider,
			}),
		} as unknown as ExecutorContext;
		const op: CompiledOperation = {
			step: "drm:keys",
			kind: "CREATE_DRM_SPEKE",
			payload: {
				muxingKind: "FMP4",
				credentialId: "credential",
				systemIds: ["edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"],
				outputPath: "output/",
			},
			refs: { encodingId: "encoding", muxingId: "mux", outputId: "output" },
		};
		const ec = { ctx, request: op.payload, startedDuringCrashWindow: vi.fn() };
		const result = await executeDrmStep(op, ec);
		expect(sdk.createSpekeDrm).toHaveBeenCalledWith(
			"enc",
			"mux",
			expect.objectContaining({ provider }),
		);
		for (const secret of Object.values(provider))
			expect(JSON.stringify(result)).not.toContain(secret);
		vi.stubEnv("SECRET_EGRESS_ALLOWED_HOSTS", "other.example.com");
		vi.mocked(sdk.createSpekeDrm).mockClear();
		await expect(executeDrmStep(op, ec)).rejects.toThrow(
			/not in SECRET_EGRESS/,
		);
		expect(sdk.createSpekeDrm).not.toHaveBeenCalled();
		vi.mocked(ctx.resolveCredential).mockResolvedValue({
			provider: "DRM_CENC",
			config: {},
			secret: { key: "key" },
		});
		await expect(executeDrmStep(op, ec)).rejects.toThrow(/DRM_SPEKE/);
	});
});
