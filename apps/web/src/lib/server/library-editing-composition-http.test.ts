import { CompositionError, ContentEditingError } from "@bitovp/core";
import { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { enableClipEditingForTests } from "@/test/clip-editing-env";
import { EditingRequestError, editingRoute } from "./library-editing-common";

enableClipEditingForTests();

afterEach(() => vi.restoreAllMocks());

describe("editing HTTP composition refusal semantics", () => {
	it("returns a known unconfirmed composition as 422 with its machine-readable code", async () => {
		const response = await editingRoute(async () => {
			throw new CompositionError("UNCONFIRMED_FRAMING");
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: "UNCONFIRMED_FRAMING",
			details: { code: "UNCONFIRMED_FRAMING" },
		});
	});
	it("keeps unknown exceptions as a sanitized 500 rather than treating every error code as a client refusal", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await editingRoute(async () => {
			throw Object.assign(new Error("fixture-private-locator"), {
				code: "UNCONFIRMED_FRAMING",
			});
		});
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal error" });
	});
	it("retains the existing V1 content-editing refusal", async () => {
		const response = await editingRoute(async () => {
			throw new ContentEditingError("UNCONFIRMED_FRAMING");
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: "UNCONFIRMED_FRAMING",
			details: { code: "UNCONFIRMED_FRAMING" },
		});
	});
	it("retains an explicit request conflict and its status", async () => {
		const response = await editingRoute(async () => {
			throw new EditingRequestError(409, "EDIT_CONFLICT");
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "EDIT_CONFLICT",
			details: { code: "EDIT_CONFLICT" },
		});
	});
	it("retains Zod validation as a 400 response", async () => {
		const response = await editingRoute(async () =>
			z.strictObject({ id: z.uuid() }).parse({}),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "Validation failed" });
	});
	it("retains both a direct response and the caller's success status", async () => {
		const direct = NextResponse.json({ ok: true }, { status: 202 });
		expect(await editingRoute(async () => direct)).toBe(direct);
		const wrapped = await editingRoute(async () => ({ ok: true }), 201);
		expect(wrapped.status).toBe(201);
		expect(await wrapped.json()).toEqual({ ok: true });
	});
});
