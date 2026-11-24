import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rejectAisaGraphMutation } from "./live-channel-mutation-guard";

const ownerId = "11111111-1111-4111-8111-111111111111";
const owner = {
	actorUserId: ownerId,
	effectiveUserId: ownerId,
	actor: `user:${ownerId}`,
	role: "ADMIN",
	actorRole: "ADMIN",
	isImpersonating: false,
};
beforeEach(() => {
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW_USER_ID", ownerId);
});
afterEach(() => vi.unstubAllEnvs());

describe("standard Live graph mutations", () => {
	it("rejects imported AISA history even when it has no editable plan", async () => {
		const response = rejectAisaGraphMutation(
			{
				origin: "AISA_IMPORTED",
				plan: null,
			},
			owner,
		);
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
			const response = rejectAisaGraphMutation(
				{
					origin: "MANAGED",
					plan: { start: { aiSceneAnalysisLive } },
				},
				owner,
			);
			expect(response?.status).toBe(409);
			expect(await response?.json()).toMatchObject({
				details: { code: "AISA_ACTION_UNSUPPORTED" },
			});
		}
	});
	it("keeps ordinary and legacy normal Live plans available", () => {
		expect(
			rejectAisaGraphMutation(
				{ origin: "MANAGED", plan: { start: {} } },
				undefined,
			),
		).toBeNull();
		expect(rejectAisaGraphMutation({ plan: {} }, undefined)).toBeNull();
	});
});
