import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({
	allowed: true,
	tenant: { effectiveUserId: "00000000-0000-4000-8000-000000000099" },
	check: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: async () => ({ tenant: access.tenant }),
}));
vi.mock("@/lib/server/aisa-live-access", () => ({
	aisaLiveAccessAllowed: (tenant: unknown) => {
		access.check(tenant);
		return access.allowed;
	},
}));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NOT_FOUND");
	},
}));

vi.mock("@/lib/i18n/metadata", () => ({ localizedTitle: () => () => ({}) }));

import { ChannelsClient } from "./channels-client";
import { LiveWizard } from "./new/live-wizard";
import NewLiveChannelPage from "./new/page";
import LiveChannelsPage from "./page";

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
	access.allowed = true;
	access.check.mockClear();
});

describe("one Live Encoding entry", () => {
	it.each([
		"true",
		"false",
	])("keeps the channel history as the sole list surface (preview %s)", (enabled) => {
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", enabled);
		expect(LiveChannelsPage().type).toBe(ChannelsClient);
	});

	it("exposes the AISA option inside the existing form without replacing it", async () => {
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
		const page = await NewLiveChannelPage({
			searchParams: Promise.resolve({ from: "retained" }),
		});
		expect(page.type).toBe(LiveWizard);
		expect(page.props).toMatchObject({
			duplicateFrom: "retained",
			aisaPreviewEnabled: true,
			aisaFeatureUserId: access.tenant.effectiveUserId,
		});
		expect(access.check).toHaveBeenCalledWith(access.tenant);
	});

	it("opens the same form for an existing AISA creation bookmark", async () => {
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
		const page = await NewLiveChannelPage({
			searchParams: Promise.resolve({ mode: "aisa-preview" }),
		});
		expect(page.type).toBe(LiveWizard);
		expect(page.props).toMatchObject({
			aisaPreviewEnabled: true,
			initialAisaEnabled: true,
		});
	});

	it.each([
		"other administrator",
		"operator",
		"viewer",
	])("does not expose the option or creation bookmark for a denied %s", async () => {
		access.allowed = false;
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
		const page = await NewLiveChannelPage({
			searchParams: Promise.resolve({}),
		});
		expect(page.props.aisaPreviewEnabled).toBe(false);
		expect(page.props.aisaFeatureUserId).toBeUndefined();
		await expect(
			NewLiveChannelPage({
				searchParams: Promise.resolve({ mode: "aisa-preview" }),
			}),
		).rejects.toThrow("NOT_FOUND");
	});
});
