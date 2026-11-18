import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	context: vi.fn(),
	run: vi.fn(),
	notFound: vi.fn(() => {
		throw new Error("NOT_FOUND");
	}),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/server/context", () => ({ getServerContext: mocks.context }));

import Page from "./page";

const CHANNEL = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const ORG = "organization-a";
const params = () => ({ params: Promise.resolve({ id: CHANNEL, runId: RUN }) });
beforeEach(() => {
	vi.resetAllMocks();
	mocks.notFound.mockImplementation(() => {
		throw new Error("NOT_FOUND");
	});
	mocks.context.mockResolvedValue({
		tenant: { role: "OPERATOR", organizationId: ORG },
		prisma: { liveChannelRun: { findFirst: mocks.run } },
	});
	mocks.run.mockResolvedValue({
		id: RUN,
		liveChannelId: CHANNEL,
		organizationId: ORG,
	});
});
describe("standalone run-bound MoQ page", () => {
	it("passes IDs only to the shared player and binds its run lookup to channel and tenant", async () => {
		const result = await Page(params());
		expect(result.props).toEqual({ channelId: CHANNEL, runId: RUN });
		expect(mocks.run).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: RUN, liveChannelId: CHANNEL } }),
		);
	});
	it("refuses VIEWER before reading a run", async () => {
		mocks.context.mockResolvedValue({
			tenant: { role: "VIEWER", organizationId: ORG },
			prisma: { liveChannelRun: { findFirst: mocks.run } },
		});
		await expect(Page(params())).rejects.toThrow("NOT_FOUND");
		expect(mocks.run).not.toHaveBeenCalled();
	});
	it.each([
		null,
		{ id: RUN, liveChannelId: CHANNEL, organizationId: "other-org" },
		{ id: RUN, liveChannelId: "other-channel", organizationId: ORG },
	])("refuses missing and mismatched runs", async (run) => {
		mocks.run.mockResolvedValue(run);
		await expect(Page(params())).rejects.toThrow("NOT_FOUND");
	});
	it("does not accept arbitrary playback query parameters", async () => {
		await expect(
			Page({
				...params(),
				searchParams: Promise.resolve({ url: "https://private.example/token" }),
			}),
		).rejects.toThrow("NOT_FOUND");
		expect(mocks.context).not.toHaveBeenCalled();
	});
});
