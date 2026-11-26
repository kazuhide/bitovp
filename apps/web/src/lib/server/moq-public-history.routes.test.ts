import { MOQ_TASK_HISTORY_ERROR } from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	channel: vi.fn(),
	channels: vi.fn(),
	runs: vi.fn(),
	errors: vi.fn(),
	alerts: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		tenant: {
			role: "VIEWER",
			organizationId: "00000000-0000-4000-8000-000000000001",
			isImpersonating: false,
		},
		prisma: {
			liveChannel: { findUnique: mocks.channel, findMany: mocks.channels },
			liveChannelRun: { findMany: mocks.runs },
			alertEvent: { groupBy: mocks.alerts },
			$queryRaw: mocks.errors,
		},
	}),
}));
vi.mock("@/lib/server/latest-runs", () => ({
	latestRunsFor: async () => new Map(),
}));
vi.mock("@/lib/server/live-heartbeat-reception", () => ({
	readHeartbeatReception: async () => null,
}));
vi.mock("@/lib/server/playback-links", () => ({
	playbackLinksForLivePlan: async () => [],
}));

import { GET as detail } from "@/app/api/live-channels/[id]/route";
import { GET as history } from "@/app/api/live-channels/[id]/runs/route";
import { GET as list } from "@/app/api/live-channels/route";

const CHANNEL = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-000000000003";
const OTHER = "00000000-0000-4000-8000-000000000004";
const SECRET =
	"authToken=private-publisher-secret moqt://private-relay.example";
const ordinaryError = "ordinary Live provider detail";
const graph = () => [
	{
		step: "output:moq",
		kind: "CREATE_OUTPUT_MOQ",
		status: "DONE",
		payload: {},
		refs: {},
	},
	{
		step: "await:live",
		kind: "AWAIT_LIVE_RUNNING",
		status: "FAILED",
		payload: {},
		refs: {},
		response: { status: "ERROR", progress: 0, messages: [SECRET] },
		error: SECRET,
	},
];
const storedRun = () => ({
	id: RUN,
	seq: 1,
	status: "ERROR",
	error: SECRET,
	stepLog: graph(),
	liveToVod: null,
});
const storedChannel = () => ({
	id: CHANNEL,
	name: "Retained MoQ run",
	origin: "USER",
	status: "ERROR",
	error: SECRET,
	plan: {},
	stepLog: graph(),
	liveToVod: null,
	schedules: [],
	feederSessions: [],
	runs: [storedRun()],
});
function selected(
	row: Record<string, unknown>,
	select: Record<string, unknown>,
) {
	return Object.fromEntries(
		Object.keys(select)
			.filter((key) => key in row)
			.map((key) => [key, row[key]]),
	);
}
const params = () => ({ params: Promise.resolve({ id: CHANNEL }) });

beforeEach(() => {
	vi.resetAllMocks();
	mocks.channel.mockResolvedValue(storedChannel());
	mocks.alerts.mockResolvedValue([]);
	mocks.channels.mockImplementation(({ select }) =>
		[
			storedChannel(),
			{ ...storedChannel(), id: OTHER, error: ordinaryError, stepLog: [] },
		].map((row) => selected(row, select)),
	);
	mocks.runs.mockImplementation(({ select }) =>
		[
			storedRun(),
			{ ...storedRun(), id: OTHER, error: ordinaryError, stepLog: [] },
		].map((row) => selected(row, select)),
	);
	mocks.errors.mockImplementation(
		(strings: TemplateStringsArray, summary: string, ids: string[]) => {
			const sql = strings.join("?");
			const id = sql.includes('FROM "LiveChannelRun"') ? RUN : CHANNEL;
			expect(sql).toContain('WHEN "stepLog" @>');
			expect(sql).toContain("ELSE error");
			expect(sql).toContain("WHERE id = ANY(?::uuid[])");
			expect(summary).toBe(MOQ_TASK_HISTORY_ERROR);
			expect(ids).toEqual([id, OTHER]);
			return [
				{ id, error: summary },
				{ id: OTHER, error: ordinaryError },
			];
		},
	);
});

describe("retained MoQ Task privacy on ordinary public reads", () => {
	it("projects channel and current-run Task history without mutating stored rows", async () => {
		const stored = storedChannel();
		const before = JSON.stringify(stored);
		mocks.channel.mockResolvedValue(stored);
		const response = await detail(new Request("http://test/detail"), params());
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(JSON.stringify(data)).not.toContain("private-publisher-secret");
		expect(JSON.stringify(data)).not.toContain("private-relay.example");
		expect(data.status).toBe("ERROR");
		expect(data.currentRun.status).toBe("ERROR");
		expect(data.stepLog[1].response).toEqual({ status: "ERROR", progress: 0 });
		expect(data.currentRun.stepLog[1].response).toEqual({
			status: "ERROR",
			progress: 0,
		});
		expect(data.error).toBeTruthy();
		expect(JSON.stringify(stored)).toBe(before);
	});
	it("keeps a non-MoQ detail's existing error and Task message unchanged", async () => {
		const row = storedChannel();
		Object.assign(row, {
			error: ordinaryError,
			stepLog: graph()
				.slice(1)
				.map((entry) => ({
					...entry,
					error: ordinaryError,
					response: { status: "ERROR", messages: [ordinaryError] },
				})),
			runs: [],
		});
		mocks.channel.mockResolvedValue(row);
		const response = await detail(new Request("http://test/detail"), params());
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.error).toBe(ordinaryError);
		expect(data.stepLog[0].response.messages).toEqual([ordinaryError]);
	});
	it("projects signed warnings in both retained ordinary Live logs for a Viewer", async () => {
		const row = storedChannel();
		const warning = "Read https://storage.invalid/source?sig=fixture-data-key";
		const stepLog = graph()
			.slice(1)
			.map((entry) => ({
				...entry,
				error: warning,
				kind: "SLATE_FAILED",
				payload: {
					providerMessages: [
						{ type: "ERROR", text: warning },
						{ type: "WARNING", text: ordinaryError },
					],
				},
				response: {
					messages: [warning, ordinaryError],
					outputs: ["scene@take", "scene?2"],
				},
			}));
		Object.assign(row, {
			error: warning,
			stepLog,
			runs: [{ ...storedRun(), error: warning, stepLog }],
		});
		mocks.channel.mockResolvedValue(row);
		const response = await detail(new Request("http://test/detail"), params());
		expect(response.status).toBe(200);
		const data = await response.json();
		for (const item of [data, data.currentRun]) {
			expect(item.error).toBe("[withheld]");
			expect(item.stepLog[0].payload.providerMessages).toEqual([
				{ type: "ERROR", text: "[withheld]" },
				{ type: "WARNING", text: ordinaryError },
			]);
			expect(item.stepLog[0].response).toEqual({
				messages: ["[withheld]", ordinaryError],
				outputs: ["scene@take", "scene?2"],
			});
		}
		expect(JSON.stringify(data)).not.toContain("fixture-data-key");
		expect(stepLog[0]?.response.messages[0]).toBe(warning);
	});
	it.each([
		"channel",
		"run",
	] as const)("protects an existing signed ordinary %s list error", async (kind) => {
		const isChannel = kind === "channel";
		const id = isChannel ? CHANNEL : RUN;
		const signed =
			"Could not read https://storage.invalid/object?sig=fixture-data";
		(isChannel ? mocks.channels : mocks.runs).mockImplementationOnce(
			({ select }) => [
				selected(
					{
						...(isChannel ? storedChannel() : storedRun()),
						error: signed,
						stepLog: [],
					},
					select,
				),
			],
		);
		mocks.errors.mockResolvedValueOnce([{ id, error: signed }]);
		const response = isChannel
			? await list(new Request("http://test/list"))
			: await history(new Request("http://test/history"), params());
		expect(response.status).toBe(200);
		const data = await response.json();
		expect((isChannel ? data.items : data.runs)[0].error).toBe("[withheld]");
		expect(JSON.stringify(data)).not.toContain("fixture-data");
	});
	it("masks only MoQ error rows in the lean channel list", async () => {
		const response = await list(new Request("http://test/api/live-channels"));
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(JSON.stringify(data)).not.toContain("private-publisher-secret");
		expect(data.items[0].error).toBeTruthy();
		expect(data.items[1].error).toBe(ordinaryError);
		expect(
			data.items.every(
				(row: object) => !("stepLog" in row) && !("plan" in row),
			),
		).toBe(true);
	});
	it("masks only MoQ errors in the bounded run history without adding step logs", async () => {
		const response = await history(
			new Request("http://test/history"),
			params(),
		);
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(JSON.stringify(data)).not.toContain("private-publisher-secret");
		expect(data.runs[0].error).toBeTruthy();
		expect(data.runs[1].error).toBe(ordinaryError);
		expect(data.runs.every((row: object) => !("stepLog" in row))).toBe(true);
	});

	it.each([
		"channel",
		"run",
	] as const)("withholds a captured %s error when the stored row disappears during the read", async (kind) => {
		const channel = kind === "channel";
		const read = channel ? mocks.channels : mocks.runs;
		read.mockImplementationOnce(({ select }) => [
			selected(channel ? storedChannel() : storedRun(), select),
		]);
		mocks.errors.mockResolvedValueOnce([]);
		const response = channel
			? await list(new Request("http://test/api/live-channels"))
			: await history(new Request("http://test/history"), params());
		expect(response.status).toBe(200);
		const data = await response.json();
		const [row] = channel ? data.items : data.runs;
		expect(row.status).toBe("ERROR");
		expect(row.error).toBe("Live encoding error details unavailable");
		expect(JSON.stringify(data)).not.toContain("private-publisher-secret");
	});

	it("uses only the current row's public text when delivery changes after the page read", async () => {
		mocks.errors.mockResolvedValueOnce([{ id: CHANNEL, error: ordinaryError }]);
		const response = await list(new Request("http://test/api/live-channels"));
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.items[0].error).toBe(ordinaryError);
		expect(JSON.stringify(data)).not.toContain("private-publisher-secret");
	});
});
