import { afterEach, expect, it, vi } from "vitest";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());
it("sends the publishing point to the SDK but excludes it from audit snapshots", async () => {
	const fetch = vi.fn(
		async (_url: string | URL, _init?: RequestInit) =>
			new Response(
				JSON.stringify({
					status: "SUCCESS",
					data: { result: { id: "00000000-0000-4000-8000-000000000003" } },
				}),
				{ status: 201, headers: { "content-type": "application/json" } },
			),
	);
	vi.stubGlobal("fetch", fetch);
	const record = vi.fn(async () => {});
	const sdk = createBitmovinSdkOps({ apiKey: "test-key" }, record);
	await sdk.createLiveMediaIngestOutput({
		name: "Origin",
		publishingPoint: "https://origin.example/live/channel.isml?token=secret",
		scte35Passthrough: true,
	});
	expect(fetch).toHaveBeenCalledOnce();
	const init = fetch.mock.calls[0]?.[1] as RequestInit;
	expect(JSON.parse(String(init.body))).toMatchObject({
		publishingPoint: "https://origin.example/live/channel.isml?token=secret",
		scte35Passthrough: true,
	});
	expect(JSON.stringify(record.mock.calls)).not.toContain("token=secret");
});

it("redacts provider error prose that echoes the encrypted publishing point", async () => {
	const secret = "https://origin.example/live.isml?token=private";
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						status: "ERROR",
						data: { code: 1001, message: `Failed ${secret}` },
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		),
	);
	const record = vi.fn(async () => {});
	const sdk = createBitmovinSdkOps({ apiKey: "test-key" }, record);
	await expect(
		sdk.createLiveMediaIngestOutput({
			name: "Origin",
			publishingPoint: secret,
		}),
	).rejects.toThrow("Live Media Ingest output creation failed");
	expect(JSON.stringify(record.mock.calls)).not.toContain("token=private");
});
