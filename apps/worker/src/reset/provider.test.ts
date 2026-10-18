import type { SecretCipher } from "@bitovp/core";
import { expect, it, vi } from "vitest";
import type { BitmovinApi } from "../bitmovin/sdk-ctor";
import { resetCleanupProvider } from "./provider";

async function fixture() {
	const hooks = {
		listByEncodingId: vi.fn().mockResolvedValue({ items: [] }),
		deleteByEncodingIdAndWebhookId: vi.fn(),
	};
	const keys = {
		list: vi.fn().mockResolvedValue({ items: [] }),
		delete: vi.fn(),
	};
	const encodings = {
		get: vi.fn().mockResolvedValue({
			id: "encoding",
			type: undefined as string | undefined,
		}),
		list: vi.fn().mockResolvedValue({ items: [] }),
		status: vi.fn().mockResolvedValue({ status: "FINISHED" }),
		stop: vi.fn(),
		live: { stop: vi.fn() },
	};
	const api = {
		encoding: { encodings, live: { streamKeys: keys } },
		notifications: {
			webhooks: { encoding: { encodings: { finished: hooks } } },
		},
	} as unknown as BitmovinApi;
	const cipher = {
		decrypt: vi.fn().mockResolvedValue("secret"),
	} as unknown as SecretCipher;
	const provider = await resetCleanupProvider(
		cipher,
		() => api,
	)({ id: "account", encryptedApiKey: "encrypted", tenantOrgId: null });
	const hook = {
		id: "hook",
		scope: "j",
		encodingId: "encoding",
		accountId: "account",
		kind: "finished",
		providerWebhookId: null,
		url: null,
		tokenHash: null,
		configuration: {},
		status: "FAILED",
		claimedUntil: null,
	};
	return { provider, encodings, hooks, keys, hook };
}
it("stops live and VOD resources through their distinct provider endpoints", async () => {
	const f = await fixture();
	f.encodings.get.mockResolvedValue({ id: "encoding", type: "LIVE" });
	await f.provider.stop("encoding");
	expect(f.encodings.live.stop).toHaveBeenCalledWith("encoding");
	expect(f.encodings.stop).not.toHaveBeenCalled();
	f.encodings.get.mockResolvedValue({ id: "encoding", type: "VOD" });
	await f.provider.stop("encoding");
	expect(f.encodings.stop).toHaveBeenCalledWith("encoding");
	f.encodings.get.mockResolvedValue({ id: "encoding" });
	await expect(f.provider.stop("encoding")).rejects.toThrow("type unavailable");
	expect(f.encodings.stop).toHaveBeenCalledTimes(1);
	expect(f.encodings.live.stop).toHaveBeenCalledTimes(1);
});
it("clears historical unknown hooks only after an empty list and terminal parent", async () => {
	const f = await fixture();
	await expect(f.provider.removeWebhook(f.hook)).resolves.toBe(true);
	f.encodings.status.mockResolvedValue({ status: "RUNNING" });
	await expect(f.provider.removeWebhook(f.hook)).resolves.toBe(false);
});
it("retains an in-flight create despite an empty list", async () => {
	const f = await fixture();
	await expect(
		f.provider.removeWebhook({
			...f.hook,
			claimedUntil: new Date().toISOString(),
		}),
	).resolves.toBe(false);
});
it("deletes only the exact owned URL and not neighboring hooks", async () => {
	const f = await fixture();
	f.hooks.listByEncodingId.mockResolvedValue({
		items: [
			{ id: "ours", url: "https://receiver/ours" },
			{ id: "theirs", url: "https://receiver/theirs" },
		],
	});
	await expect(
		f.provider.removeWebhook({ ...f.hook, url: "https://receiver/ours" }),
	).resolves.toBe(true);
	expect(f.hooks.deleteByEncodingIdAndWebhookId.mock.calls).toEqual([
		["encoding", "ours"],
	]);
});
it("does not accept unauthenticated or nonspecific 404 as resource absence", async () => {
	const f = await fixture();
	f.encodings.status.mockRejectedValue({ httpStatusCode: 404 });
	await expect(f.provider.status("encoding")).rejects.toEqual({
		httpStatusCode: 404,
	});
	f.encodings.status.mockRejectedValue({
		httpStatusCode: 404,
		errorCode: 1001,
	});
	f.encodings.get.mockRejectedValue({ httpStatusCode: 404, errorCode: 1001 });
	f.encodings.list.mockRejectedValue({ httpStatusCode: 401 });
	await expect(f.provider.status("encoding")).rejects.toEqual({
		httpStatusCode: 401,
	});
});
it("releases only temporary keys assigned to the selected encoding", async () => {
	const f = await fixture();
	f.keys.list.mockResolvedValue({
		items: [
			{ id: "ours", assignedEncodingId: "encoding" },
			{ id: "theirs", assignedEncodingId: "other" },
		],
	});
	await f.provider.releaseTemporaryKeys("encoding");
	expect(f.keys.list).toHaveBeenCalledWith({
		type: "TEMPORARY",
		offset: 0,
		limit: 100,
	});
	expect(f.keys.delete.mock.calls).toEqual([["ours"]]);
});
