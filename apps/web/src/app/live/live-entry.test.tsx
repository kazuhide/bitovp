import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/metadata", () => ({ localizedTitle: () => () => ({}) }));

import { ChannelsClient } from "./channels-client";
import { LiveWizard } from "./new/live-wizard";
import NewLiveChannelPage from "./new/page";
import LiveChannelsPage from "./page";

afterEach(() => vi.unstubAllEnvs());

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
		});
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
});
