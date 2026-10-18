import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/metadata", () => ({ localizedTitle: () => () => ({}) }));

import NewLiveChannelPage from "../../live/new/page";
import NewVodJobPage from "./page";

describe("new wizard server pages", () => {
	it("passes only form state to VOD and Live clients", async () => {
		const vod = await NewVodJobPage({
			searchParams: Promise.resolve({ preset: "retained" }),
		});
		const live = await NewLiveChannelPage({
			searchParams: Promise.resolve({ from: "retained-run" }),
		});
		expect(vod.props).toMatchObject({
			presetName: "retained",
		});
		expect(live.props).toMatchObject({
			duplicateFrom: "retained-run",
		});
		expect(vod.props).not.toHaveProperty("deploymentProfile");
		expect(live.props).not.toHaveProperty("deploymentProfile");
	});

	it("passes only copy state to the copy client", async () => {
		const copied = await NewVodJobPage({
			searchParams: Promise.resolve({ from: "source-job" }),
		});
		expect(copied.props).toEqual({
			source: "source-job",
			conflictingSource: false,
		});
	});
});
