import { describe, expect, it } from "vitest";
import { streamedRequest } from "@/__tests__/request-body-stream";
import { readBoundedBody, readBoundedJson } from "./request-body";
import {
	declaredBodyTooLarge,
	publicRequestBodyPolicy,
} from "./request-body-limits";

const encoder = new TextEncoder();
const requestFor = (chunks: Uint8Array[], options = {}) =>
	streamedRequest("http://test/api/auth/login", chunks, options);

describe("bounded request bytes", () => {
	it.each([
		undefined,
		"0",
		"1",
		"invalid",
		"-1",
		"1e9",
	])("stops on actual bytes with content-length %s", async (contentLength) => {
		const { request, reads } = requestFor(
			[new Uint8Array(4), new Uint8Array(1), encoder.encode("sentinel")],
			{ contentLength },
		);
		expect(await readBoundedBody(request, 4)).toBeNull();
		expect(reads).toEqual({ pulls: 2, cancellations: 1 });
		expect(request.body?.locked).toBe(false);
	});
	it("rejects a huge first chunk without reading another chunk", async () => {
		const { request, reads } = requestFor([
			new Uint8Array(1_000_000),
			encoder.encode("sentinel"),
		]);
		expect(await readBoundedBody(request, 4)).toBeNull();
		expect(reads).toEqual({ pulls: 1, cancellations: 1 });
	});
	it.each([
		() => Promise.reject(new Error("cancel failed")),
		() => new Promise<void>(() => {}),
	])("does not wait for cancellation", async (cancel) => {
		const { request, reads } = requestFor([new Uint8Array(5)], { cancel });
		expect(await readBoundedBody(request, 4)).toBeNull();
		expect(reads.cancellations).toBe(1);
		expect(request.body?.locked).toBe(false);
	});
	it("rejects a decimal declared oversize without pulling", async () => {
		const { request, reads } = requestFor([encoder.encode("unread")], {
			contentLength: "9999999999999999999999999",
		});
		expect(await readBoundedBody(request, 4)).toBeNull();
		expect(reads).toEqual({ pulls: 0, cancellations: 1 });
	});
	it("accepts exact bytes, including UTF-8 split inside a code point", async () => {
		const bytes = encoder.encode("界");
		const { request, reads } = requestFor([
			bytes.subarray(0, 1),
			bytes.subarray(1),
		]);
		expect(Array.from((await readBoundedBody(request, 3)) ?? [])).toEqual(
			Array.from(bytes),
		);
		expect(reads).toEqual({ pulls: 3, cancellations: 0 });
		expect(request.body?.locked).toBe(false);
	});
	it("returns empty bytes for a bodyless request", async () => {
		expect(await readBoundedBody(new Request("http://test"), 4)).toEqual(
			new Uint8Array(0),
		);
	});
	it("separates oversized JSON from malformed and unreadable small JSON", async () => {
		expect(
			await readBoundedJson(requestFor([encoder.encode("!!!!")]).request, 3),
		).toEqual({ tooLarge: true });
		expect(
			await readBoundedJson(requestFor([encoder.encode("!")]).request, 3),
		).toEqual({ tooLarge: false, value: null });
		const request = requestFor([encoder.encode("{}")]).request;
		await request.text();
		expect(await readBoundedJson(request, 3)).toEqual({
			tooLarge: false,
			value: null,
		});
	});
});

describe("public body policies", () => {
	it.each([
		["/_next/data/current-build/api/auth/login.json", 4096],
		["/_next/data/current-build/index/api/auth/login.json", 4096],
		["/_next/data/current-build/api/%61uth/login.json", 4096],
		["/_next/data/unknown-build/api%2fauth%2flogin.json", 4096],
		["/_next/data/current-build/api/auth/setup.json?q=1", 8192],
		["/_next/data/current-build/api/webhooks/bitmovin/j/token.json", 1_000_000],
	] as const)("protects the data alias %s", (path, limit) => {
		expect(publicRequestBodyPolicy("POST", path)?.limit).toBe(limit);
	});
	it.each([
		"/%5fnext/data/current-build/api/auth/login.json",
		"/_next/data/current-build/api/auth/login%2ejson",
		"/_next/data/current-build/api/auth/login.json/extra",
		"/_next/data/current-build/index/index/api/auth/login.json",
		"/_next/data/current-build/index/api/webhooks/bitmovin/[scope]/token.json",
		"/_next/data/current-build/api/encoding-jobs.json",
		"/_next/data/current-build/api/live-channels.json",
	])("does not unwrap an unrelated or differently encoded data path %s", (path) => {
		expect(publicRequestBodyPolicy("POST", path)).toBeNull();
	});
	it.each([
		"/api/auth/login",
		"/api/auth/login/?q=1",
		"/api/other/../auth/login",
		"/api/%61uth/login",
		"/api%2fauth%2flogin",
		"//api//auth/login",
		"/api\\auth\\login",
	])("protects the login route alias %s", (path) => {
		expect(publicRequestBodyPolicy("POST", path)?.limit).toBe(4096);
	});
	it("protects setup and scoped webhook routes, including encoded token bytes", () => {
		expect(publicRequestBodyPolicy("POST", "/api/auth/setup")?.limit).toBe(
			8192,
		);
		expect(
			publicRequestBodyPolicy("POST", "/api/webhooks/bitmovin/j/token%2fvalue")
				?.limit,
		).toBe(1_000_000);
	});
	it.each([
		"/api/auth/login/extra",
		"/api/auth/login-extra",
		"/api/encoding-jobs",
		"/api/live-channels",
		"/api/webhooks/bitmovin",
		"/api/webhooks/bitmovin/j/token/extra",
		"/api/auth/login.rsc",
		"/api/auth/%invalid",
	])("leaves unrelated path %s unchanged", (path) => {
		expect(publicRequestBodyPolicy("POST", path)).toBeNull();
	});
	it("does not limit other methods or trust malformed lengths", () => {
		expect(publicRequestBodyPolicy("GET", "/api/auth/login")).toBeNull();
		expect(declaredBodyTooLarge("1e9", 4)).toBe(false);
		expect(declaredBodyTooLarge("-100", 4)).toBe(false);
		expect(declaredBodyTooLarge("4", 4)).toBe(false);
		expect(declaredBodyTooLarge("0005", 4)).toBe(true);
	});
});
