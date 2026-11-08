import { describe, expect, it } from "vitest";
import { enableClipEditingForTests } from "@/test/clip-editing-env";
import { editingBody, editingRoute } from "./library-editing-common";

enableClipEditingForTests();

describe("bounded editing requests", () => {
	it("rejects oversized declared requests before parsing", async () => {
		const req = new Request("http://localhost/api/library/edits", {
			method: "POST",
			body: "{}",
			headers: { "Content-Length": String(512 * 1024 + 1) },
		});
		const response = await editingRoute(() => editingBody(req));
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			error: "EDIT_DOCUMENT_TOO_LARGE",
		});
	});
	it("also rejects oversized chunked requests", async () => {
		const req = new Request("http://localhost/api/library/edits", {
			method: "POST",
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(512 * 1024 + 1));
					controller.close();
				},
			}),
			duplex: "half",
		} as RequestInit);
		expect((await editingRoute(() => editingBody(req))).status).toBe(413);
	});
	it("retains malformed JSON as invalid input", async () => {
		expect(
			await editingBody(
				new Request("http://localhost", { method: "POST", body: "!" }),
			),
		).toBeNull();
	});
});
