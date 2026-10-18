import { readFileSync } from "node:fs";
import { join } from "node:path";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { ChannelDetail } from "./channel-detail";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		ApiError: actual.ApiError,
		apiFetch: (...args: unknown[]) => apiFetch(...args),
	};
});
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
afterEach(() => apiFetch.mockReset());

/**
 *  (review-331): the "unconfirmed push" notice, at the page that
 * renders it. The first cut was tested only at the FeederPanel prop boundary;
 * this page's derivation was a boolean, so `undefined` never arrived and both
 * "no heartbeat" and "stale heartbeat" collapsed into the pre-existing "the
 * encoder has not bound any input" banner — a stronger, wrong claim.
 */
const ID = "00000000-0000-4000-8000-0000000000d3";
const PLAN = JSON.parse(
	readFileSync(
		join(
			import.meta.dirname,
			"../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
		),
		"utf8",
	),
) as Record<string, unknown>;

function heartbeat(ageMs: number, status: string) {
	return {
		at: new Date(Date.now() - ageMs).toISOString(),
		raw: {
			ingest: { status, healthy: status === "CONNECTED", streams: [] },
			events: [],
		},
		deltas: {},
	};
}

function mockPage(lastHeartbeat: unknown) {
	apiFetch.mockImplementation(async (url: string) => {
		if (url === `/api/live-channels/${ID}`) {
			return {
				id: ID,
				name: "tri-state",
				status: "RUNNING",
				plan: PLAN,
				stepLog: [],
				streamKey: "k",
				encoderIp: "203.0.113.9",
				programStartAt: null,
				programEndAt: null,
				lastHeartbeat,
				liveToVod: null,
				playbackLinks: [],
				maxRunMinutes: null,
				bitmovinEncodingId: null,
				bitmovinAccountId: null,
				createdAt: "2026-08-28T00:00:00.000Z",
				updatedAt: "2026-08-28T00:00:00.000Z",
				currentRun: null,
			};
		}
		if (url === "/api/credentials") {
			return [];
		}
		if (url.includes("/alerts")) {
			return { open: [], history: [] };
		}
		if (url.includes("/schedules")) {
			return [];
		}
		if (url.includes("/feeder")) {
			return {
				items: [
					{
						id: "fs-1",
						status: "PUSHING",
						protocol: "RTMP",
						sourceBucket: "in",
						sourceKey: "loop.mp4",
						startedAt: "2026-08-28T00:54:00.000Z",
						stoppedAt: null,
						error: null,
						loopBoundaries: [],
						logTail: [],
						createdAt: "2026-08-28T00:53:00.000Z",
					},
				],
			};
		}
		if (url.includes("/runs")) {
			return { runs: [] };
		}
		return [];
	});
}

const UNCONFIRMED = /no recent heartbeat to confirm/;
const NOT_BOUND = /encoder has not bound any input/;

describe("ChannelDetail — a PUSHING feeder and what the page KNOWS about ingest", () => {
	it("no heartbeat at all: unconfirmed, not 'not bound'", async () => {
		mockPage(null);
		renderWithQuery(<ChannelDetail id={ID} />);
		expect(await screen.findByText(UNCONFIRMED)).toBeInTheDocument();
		expect(screen.queryByText(NOT_BOUND)).toBeNull();
	});

	it("a STALE heartbeat: unconfirmed too — a frozen CONNECTED cannot vouch", async () => {
		mockPage(heartbeat(10 * 60_000, "CONNECTED"));
		renderWithQuery(<ChannelDetail id={ID} />);
		expect(await screen.findByText(UNCONFIRMED)).toBeInTheDocument();
		expect(screen.queryByText(NOT_BOUND)).toBeNull();
	});

	it("a FRESH sample that says not connected: 'not bound', not unconfirmed", async () => {
		mockPage(heartbeat(1_000, "WAITING_FOR_FIRST_CONNECT"));
		renderWithQuery(<ChannelDetail id={ID} />);
		expect(await screen.findByText(NOT_BOUND)).toBeInTheDocument();
		expect(screen.queryByText(UNCONFIRMED)).toBeNull();
	});

	it("a FRESH CONNECTED sample: neither notice", async () => {
		mockPage(heartbeat(1_000, "CONNECTED"));
		renderWithQuery(<ChannelDetail id={ID} />);
		expect(await screen.findByText("PUSHING")).toBeInTheDocument();
		expect(screen.queryByText(UNCONFIRMED)).toBeNull();
		expect(screen.queryByText(NOT_BOUND)).toBeNull();
	});
});
