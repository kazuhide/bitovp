import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";

const state = vi.hoisted(() => ({
	context: {} as ServerContext,
	availability: vi.fn(),
}));
vi.mock("./context", () => ({ getServerContext: async () => state.context }));
vi.mock("./local-semantic-readiness", () => ({
	readWorkerClipAvailability: state.availability,
}));

import { editingEligibility } from "./library-editing-media";

function fixture() {
	const analyses = [
		{
			id: "11111111-1111-4111-8111-111111111111",
			locale: "ja",
			providerVersion: "1.3.0",
			createdAt: new Date("2026-11-02T00:00:00Z"),
		},
		{
			id: "22222222-2222-4222-8222-222222222222",
			locale: "ja",
			providerVersion: "1.2.0",
			createdAt: new Date("2026-11-01T00:00:00Z"),
		},
	];
	const findMany = vi.fn().mockResolvedValue(analyses);
	state.context = {
		tenant: { organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
		prisma: {
			librarySource: {
				findUnique: async () => ({
					jobId: null,
					snapshot: {
						schemaVersion: 1,
						kind: "VOD_JOB",
						name: "Interview",
						identity: "UNVERIFIED",
						planHash: "a".repeat(64),
						inputs: [],
						fileOutputs: [],
						playbackLinks: [],
						qcVerdict: null,
						qcOverriddenAt: null,
					},
				}),
			},
			libraryMediaVersion: { findMany: async () => [] },
			sceneAnalysisRevision: { findMany },
		},
	} as unknown as ServerContext;
	return { findMany };
}
beforeEach(() => {
	state.availability.mockReset().mockResolvedValue(false);
	vi.stubEnv("BITOVP_STORY_ENABLED", undefined);
	vi.stubEnv("BITOVP_STORY_MODEL_ID", undefined);
	vi.stubEnv("BITOVP_STORY_CONFIG_ID", undefined);
	for (const name of [
		"ENABLED",
		"GATEWAY_URL",
		"GATEWAY_TOKEN",
		"CA_FILE",
		"PROFILE",
		"CONFIG_ID",
	])
		vi.stubEnv(`BITOVP_LOCAL_SEMANTIC_${name}`, undefined);
});

it.each([
	true,
	false,
])("publishes local capabilities only with verified worker GPU availability %s", async (available) => {
	fixture();
	state.availability.mockResolvedValue(available);
	const settings = {
		ENABLED: "1",
		GATEWAY_URL: "https://192.168.68.62:11437",
		GATEWAY_TOKEN: "private-example-token-".repeat(3),
		CA_FILE: "/run/bitovp-local-semantic/gateway-ca.pem",
		PROFILE: "nvidia",
		CONFIG_ID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
	};
	for (const [key, value] of Object.entries(settings))
		vi.stubEnv(`BITOVP_LOCAL_SEMANTIC_${key}`, value);
	const view = await editingEligibility("33333333-3333-4333-8333-333333333333");
	expect(view.localStoryAvailable).toBe(available);
	expect(view.captionTranslationAvailable).toBe(available);
	expect(view.storyAvailable).toBe(false);
	expect(JSON.stringify(view)).not.toMatch(
		/private-example-token|192\.168|gateway-ca|nvidia|dddddddd/,
	);
});

it("does not advertise a local engine for incomplete server settings", async () => {
	fixture();
	vi.stubEnv("BITOVP_LOCAL_SEMANTIC_ENABLED", "1");
	const view = await editingEligibility("33333333-3333-4333-8333-333333333333");
	expect(view.localStoryAvailable).toBe(false);
	expect(view.captionTranslationAvailable).toBe(false);
	expect(view.storyAvailable).toBe(false);
});
afterEach(() => vi.unstubAllEnvs());
it("distinguishes same-language analysis revisions by capture date, version and identity", async () => {
	const { findMany } = fixture();
	const view = await editingEligibility("33333333-3333-4333-8333-333333333333");
	expect(view.analyses[0]?.title).toContain("1.3.0");
	expect(view.analyses[0]?.title).toContain("2026-11-02");
	expect(view.analyses[0]?.title).toContain("11111111");
	expect(view.analyses[1]?.title).toContain("1.2.0");
	expect(view.analyses[0]?.title).not.toBe(view.analyses[1]?.title);
	expect(findMany).toHaveBeenCalledWith(
		expect.objectContaining({
			select: expect.objectContaining({
				providerVersion: true,
				createdAt: true,
			}),
		}),
	);
});
it.each([
	false,
	true,
])("withdraws STORY capability even with configured status %s", async (configured) => {
	fixture();
	if (configured) {
		vi.stubEnv("BITOVP_STORY_ENABLED", "1");
		vi.stubEnv("BITOVP_STORY_MODEL_ID", "gpt-6.1-sol");
		vi.stubEnv(
			"BITOVP_STORY_CONFIG_ID",
			"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
		);
	}
	const view = await editingEligibility("33333333-3333-4333-8333-333333333333");
	expect(view.storyAvailable).toBe(false);
	expect(view).not.toHaveProperty("storyModel");
	expect(JSON.stringify(view)).not.toMatch(
		/gpt-6\.1-sol|dddddddd-dddd-4ddd-8ddd-dddddddddddd/,
	);
});
