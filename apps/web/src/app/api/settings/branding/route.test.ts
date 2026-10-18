import {
	BRANDING_REQUEST_MAX_BYTES,
	DEFAULT_BRANDING_SETTINGS,
} from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateRole } from "@/lib/auth/roles";
import { viewAsMayRead } from "@/lib/auth/view-as";

const { context, audit } = vi.hoisted(() => ({
	context: vi.fn(),
	audit: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({ getServerContext: context }));
vi.mock("@/lib/server/audit", () => ({ writeAuditLog: audit }));

import { GET, PATCH } from "./route";

const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVZkAAAAASUVORK5CYII=";
const rows = new Map<string, unknown>();
let org = "a";
const upsert = vi.fn(async ({ update }: { update: { value: unknown } }) => {
	rows.set(org, update.value);
});
const findUnique = vi.fn(async () => ({ value: rows.get(org) }));
const request = (body: unknown, headers: Record<string, string> = {}) =>
	new Request("http://localhost/api/settings/branding", {
		method: "PATCH",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
beforeEach(() => {
	rows.clear();
	org = "a";
	rows.set("a", { displayName: "Studio", iconDataUrl: PNG });
	context
		.mockReset()
		.mockResolvedValue({ prisma: { appSetting: { findUnique, upsert } } });
	findUnique.mockClear();
	upsert.mockClear();
	audit.mockReset();
});
describe("organization branding API", () => {
	it("reads one tenant row without public caching and isolates organization switches", async () => {
		const response = await GET();
		expect(response.headers.get("cache-control")).toContain("no-store");
		expect(await response.json()).toEqual({
			displayName: "Studio",
			iconDataUrl: PNG,
		});
		org = "b";
		expect(await (await GET()).json()).toEqual(DEFAULT_BRANDING_SETTINGS);
		await PATCH(request({ displayName: "Other" }));
		org = "a";
		expect(await (await GET()).json()).toEqual({
			displayName: "Studio",
			iconDataUrl: PNG,
		});
	});
	it("merges name-only edits, removes the icon, and restores defaults explicitly", async () => {
		expect(
			await (await PATCH(request({ displayName: "  New  " }))).json(),
		).toEqual({ displayName: "New", iconDataUrl: PNG });
		expect(await (await PATCH(request({ iconDataUrl: null }))).json()).toEqual({
			displayName: "New",
			iconDataUrl: null,
		});
		expect(
			await (await PATCH(request(DEFAULT_BRANDING_SETTINGS))).json(),
		).toEqual(DEFAULT_BRANDING_SETTINGS);
	});
	it("accepts valid icon and never places its bytes in the audit", async () => {
		await PATCH(request({ iconDataUrl: PNG }));
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				response: { displayName: "Studio", hasIcon: true, iconBytes: 68 },
			}),
			expect.any(Request),
		);
		expect(JSON.stringify(audit.mock.calls[0]?.[1])).not.toContain("base64");
	});
	it("degrades malformed stored rows, but database failure is an error and cannot overwrite", async () => {
		rows.set("a", 42);
		expect(await (await GET()).json()).toEqual(DEFAULT_BRANDING_SETTINGS);
		findUnique.mockRejectedValueOnce(new Error("offline"));
		expect((await GET()).status).toBe(500);
		findUnique.mockRejectedValueOnce(new Error("offline"));
		expect((await PATCH(request({ displayName: "New" }))).status).toBe(500);
		expect(upsert).not.toHaveBeenCalled();
	});
	it.each([
		{ displayName: " " },
		{ displayName: "x".repeat(65) },
		{ iconDataUrl: "https://evil/image.png" },
		{ iconDataUrl: "data:image/svg+xml;base64,PHN2Zz4=" },
		{ unexpected: true },
	])("rejects malformed values before writes", async (body) => {
		expect((await PATCH(request(body))).status).toBe(400);
		expect(upsert).not.toHaveBeenCalled();
	});
	it("bounds both announced and chunked request bodies before JSON parsing", async () => {
		expect(
			(
				await PATCH(
					request(
						{},
						{ "content-length": String(BRANDING_REQUEST_MAX_BYTES + 1) },
					),
				)
			).status,
		).toBe(413);
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(BRANDING_REQUEST_MAX_BYTES));
				controller.enqueue(new Uint8Array(1));
				controller.close();
			},
		});
		const req = new Request("http://localhost/api/settings/branding", {
			method: "PATCH",
			body: stream,
			duplex: "half",
		} as RequestInit);
		expect((await PATCH(req)).status).toBe(413);
		expect(upsert).not.toHaveBeenCalled();
	});
	it("rejects invalid JSON", async () => {
		expect(
			(await PATCH(new Request("http://test", { method: "PATCH", body: "{" })))
				.status,
		).toBe(400);
	});
	it("reads at VIEWER, writes at ADMIN, and permits only target-scoped view-as reads", () => {
		for (const role of ["VIEWER", "OPERATOR", "ADMIN"] as const) {
			expect(evaluateRole(role, "/api/settings/branding", "GET").allowed).toBe(
				true,
			);
			expect(
				evaluateRole(role, "/api/settings/branding", "PATCH").allowed,
			).toBe(role === "ADMIN");
		}
		expect(viewAsMayRead("/api/settings/branding", "GET")).toBe(true);
		expect(viewAsMayRead("/api/settings/branding", "PATCH")).toBe(false);
		expect(viewAsMayRead("/settings/branding", "GET")).toBe(false);
	});
});
