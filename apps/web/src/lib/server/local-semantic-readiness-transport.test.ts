import { EventEmitter } from "node:events";
import type { LocalSemanticConfiguration } from "@bitovp/core";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), request: vi.fn() }));
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		default: { ...actual, readFile: mocks.readFile },
		readFile: mocks.readFile,
	};
});
vi.mock("node:https", async (original) => {
	const actual = await original<typeof import("node:https")>();
	return {
		...actual,
		default: { ...actual, request: mocks.request },
		request: mocks.request,
	};
});

import { readLocalSemanticMetadata } from "./local-semantic-readiness";

const config: LocalSemanticConfiguration = {
	url: "https://fixture.invalid:11437/",
	token: "private-fixture-token-".repeat(3),
	caFile: "/fixture/private.pem",
	profile: "nvidia",
	configId: "11111111-1111-4111-8111-111111111111",
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.readFile.mockResolvedValue(Buffer.from("fixture CA"));
});
function reply(statusCode: number, chunks: Buffer[]) {
	const res = Object.assign(new EventEmitter(), {
		statusCode,
		destroy: vi.fn(),
	});
	mocks.request.mockImplementation((_url, _options, receive) => {
		const req = Object.assign(new EventEmitter(), {
			end: () =>
				queueMicrotask(() => {
					receive(res);
					if (!res.destroy.mock.calls.length) {
						for (const chunk of chunks) res.emit("data", chunk);
						res.emit("end");
					}
				}),
		});
		return req;
	});
	return res;
}
it("pins TLS and the configured authorization, issuing a GET with a deadline", async () => {
	reply(200, [Buffer.from('{"ready":true}')]);
	await expect(
		readLocalSemanticMetadata(config, "/readiness/nvidia"),
	).resolves.toEqual({ ready: true });
	const [url, options] = mocks.request.mock.calls[0] ?? [];
	expect(String(url)).toBe("https://fixture.invalid:11437/readiness/nvidia");
	expect(options).toMatchObject({
		method: "GET",
		rejectUnauthorized: true,
		agent: false,
		headers: { authorization: `Bearer ${config.token}` },
	});
	expect(options.signal).toBeInstanceOf(AbortSignal);
});
it.each([
	301, 302, 500,
])("does not follow HTTP %s or expose its response body", async (status) => {
	reply(status, [Buffer.from(config.token)]);
	await expect(
		readLocalSemanticMetadata(config, "/health"),
	).rejects.toMatchObject({
		code: "CONNECTION_FAILED",
		message: "CONNECTION_FAILED",
	});
	expect(mocks.request).toHaveBeenCalledTimes(1);
});
it.each([
	401, 403,
])("reports a fixed authentication failure for %s", async (status) => {
	reply(status, []);
	await expect(
		readLocalSemanticMetadata(config, "/health"),
	).rejects.toMatchObject({ code: "AUTH_FAILED" });
});
it.each([
	{ chunks: [Buffer.alloc(16_385, 32)] },
	{ chunks: [Buffer.from("not json")] },
])("rejects oversized or malformed metadata", async ({ chunks }) => {
	reply(200, chunks);
	await expect(
		readLocalSemanticMetadata(config, "/health"),
	).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
it("accepts valid JSON at the exact byte limit", async () => {
	reply(200, [Buffer.from(`{}${" ".repeat(16_382)}`)]);
	await expect(readLocalSemanticMetadata(config, "/health")).resolves.toEqual(
		{},
	);
});
it("does not connect if its trusted CA cannot be read", async () => {
	mocks.readFile.mockRejectedValue(new Error(config.caFile));
	await expect(
		readLocalSemanticMetadata(config, "/health"),
	).rejects.toMatchObject({ code: "TLS_FAILED", message: "TLS_FAILED" });
	expect(mocks.request).not.toHaveBeenCalled();
});
it.each([
	["CERT_HAS_EXPIRED", "TLS_FAILED"],
	["ECONNREFUSED", "CONNECTION_FAILED"],
])("sanitizes %s without leaking its message", async (code, expected) => {
	mocks.request.mockImplementation(() => {
		const req = Object.assign(new EventEmitter(), {
			end: () =>
				queueMicrotask(() =>
					req.emit("error", Object.assign(new Error(config.token), { code })),
				),
		});
		return req;
	});
	await expect(
		readLocalSemanticMetadata(config, "/health"),
	).rejects.toMatchObject({ code: expected, message: expected });
});
