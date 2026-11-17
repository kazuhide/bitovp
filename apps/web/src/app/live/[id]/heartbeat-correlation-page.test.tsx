import { beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./page";

const mock = vi.hoisted(() => ({ context: vi.fn(), player: vi.fn() }));
vi.mock("@/lib/server/context", () => ({ getServerContext: mock.context }));
vi.mock("@/lib/server/player-config", () => ({
	readPlayerClientConfig: mock.player,
}));
vi.mock("@/lib/server/aisa-live-access", () => ({
	aisaLiveAccessAllowed: () => false,
}));
vi.mock("@/lib/i18n/metadata", () => ({ localizedTitle: () => () => ({}) }));
vi.mock("./channel-detail", () => ({ ChannelDetail: () => null }));
const ID = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
	vi.clearAllMocks();
	mock.context.mockResolvedValue({
		tenant: { role: "OPERATOR" },
		prisma: { liveChannelRun: { findFirst: vi.fn() } },
	});
	mock.player.mockResolvedValue(undefined);
});
describe("Live page heartbeat navigation plumbing", () => {
	it("passes dedicated run/time navigation without activating the AISA runId selector", async () => {
		const from = "2026-11-18T00:00:00.000Z",
			to = "2026-11-18T00:01:00.000Z";
		const rendered = await Page({
			params: Promise.resolve({ id: ID }),
			searchParams: Promise.resolve({
				heartbeatRunId: ID,
				heartbeatFrom: from,
				heartbeatTo: to,
			}),
		});
		expect(rendered.props.initialHeartbeatCorrelation).toEqual({
			kind: "requested",
			runId: ID,
			from,
			to,
		});
		expect(rendered.props.initialAisaRun).toBeUndefined();
	});
	it("passes an explicit invalid state for duplicate query values and none for ordinary navigation", async () => {
		const invalid = await Page({
			params: Promise.resolve({ id: ID }),
			searchParams: Promise.resolve({ heartbeatRunId: [ID, ID] }),
		});
		expect(invalid.props.initialHeartbeatCorrelation).toEqual({
			kind: "invalid",
		});
		const normal = await Page({ params: Promise.resolve({ id: ID }) });
		expect(normal.props.initialHeartbeatCorrelation).toEqual({ kind: "none" });
	});
});
