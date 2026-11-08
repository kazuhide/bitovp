import { describe, expect, it } from "vitest";
import { rejectAisaGraphMutation } from "./live-channel-mutation-guard";

describe("standard Live graph mutations", () => {
	it("rejects imported AISA history even when it has no editable plan", async () => {
		const response = rejectAisaGraphMutation({
			origin: "AISA_IMPORTED",
			plan: null,
		});
		expect(response?.status).toBe(409);
		expect(await response?.json()).toMatchObject({
			details: { code: "AISA_IMPORTED_READ_ONLY" },
		});
	});
	it("rejects managed AISA plans and malformed AISA settings before a provider call", async () => {
		for (const aiSceneAnalysisLive of [
			{ preset: "AISA_PREVIEW_MANAGED" },
			null,
		]) {
			const response = rejectAisaGraphMutation({
				origin: "MANAGED",
				plan: { start: { aiSceneAnalysisLive } },
			});
			expect(response?.status).toBe(409);
			expect(await response?.json()).toMatchObject({
				details: { code: "AISA_ACTION_UNSUPPORTED" },
			});
		}
	});
	it("keeps ordinary and legacy normal Live plans available", () => {
		expect(
			rejectAisaGraphMutation({ origin: "MANAGED", plan: { start: {} } }),
		).toBeNull();
		expect(rejectAisaGraphMutation({ plan: {} })).toBeNull();
	});
});
