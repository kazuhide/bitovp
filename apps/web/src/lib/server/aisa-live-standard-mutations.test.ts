import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	channel: vi.fn(),
	provider: vi.fn(),
	vendor: vi.fn(),
	queue: vi.fn(),
	claim: vi.fn(),
	run: vi.fn(),
	scheduleWrite: vi.fn(),
	preflight: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			liveChannel: { findUnique: mocks.channel },
			liveChannelRun: { findFirst: mocks.run, findUnique: mocks.run },
			liveEffectClaim: { findUnique: mocks.claim },
			liveSchedule: { updateMany: mocks.scheduleWrite, findFirst: vi.fn() },
		},
	}),
}));
vi.mock("@/lib/server/bitmovin", () => ({
	bitmovinClientForAccount: mocks.provider,
	auditedBitmovinCall: mocks.vendor,
	bitmovinProxyError: () => new Response(null, { status: 502 }),
}));
vi.mock("@/lib/server/queue", () => ({
	getLiveChannelQueue: mocks.queue,
	getVmafQueue: mocks.queue,
	getSlateNormalizeQueue: mocks.queue,
}));
vi.mock("@/lib/server/slate-preflight", () => ({
	runSlatePreflight: mocks.preflight,
}));
vi.mock("@/lib/server/feature-flags", () => ({
	requireQcVmafEnabled: async () => null,
}));
vi.mock("@bitovp/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@bitovp/core")>()),
	masterKeyFromEnv: () => Buffer.alloc(32),
}));

import { POST as autoShutdown } from "@/app/api/live-channels/[id]/auto-shutdown/route";
import { POST as captureVmaf } from "@/app/api/live-channels/[id]/capture-vmaf/route";
import { POST as esam } from "@/app/api/live-channels/[id]/esam-media-point/route";
import { POST as preflight } from "@/app/api/live-channels/[id]/insertable-content/preflight/route";
import { POST as registerContent } from "@/app/api/live-channels/[id]/insertable-content/route";
import { DELETE as descheduleContent } from "@/app/api/live-channels/[id]/insertable-content/schedule/[scheduledId]/route";
import { POST as scheduleContent } from "@/app/api/live-channels/[id]/insertable-content/schedule/route";
import { POST as stopContent } from "@/app/api/live-channels/[id]/insertable-content/stop/route";
import { POST as liveToVod } from "@/app/api/live-channels/[id]/live-to-vod/route";
import { DELETE as cancelSchedule } from "@/app/api/live-channels/[id]/schedules/[scheduleId]/route";
import { POST as armSchedule } from "@/app/api/live-channels/[id]/schedules/route";

const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const accountId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const itemId = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const runId = "dddddddd-dddd-4ddd-addd-dddddddddddd";
const context = {
	params: Promise.resolve({ id, scheduledId: itemId, scheduleId: itemId }),
};
const cases = [
	{
		name: "automatic stop",
		run: autoShutdown,
		body: {
			runId,
			requestId: itemId,
			expectedRevision: null,
			configuration: { streamTimeoutMinutes: 5 },
		},
	},
	{ name: "VMAF capture", run: captureVmaf, body: {} },
	{
		name: "ESAM media point",
		run: esam,
		body: {
			bitmovinAccountId: accountId,
			mediaPoint: { signals: [{ binary: "/DAgAAAAAAAAAP/wDwAA" }] },
		},
	},
	{ name: "live-to-VOD", run: liveToVod, body: {} },
	{
		name: "schedule arm",
		run: armSchedule,
		body: {
			action: "START",
			fireAt: new Date(Date.now() + 3600_000).toISOString(),
		},
	},
	{ name: "schedule cancel", run: cancelSchedule, method: "DELETE" },
	{
		name: "content register",
		run: registerContent,
		body: {
			bitmovinAccountId: accountId,
			content: { inputs: [{ inputId: itemId, inputPath: "/clip.ts" }] },
		},
	},
	{
		name: "content preflight",
		run: preflight,
		body: {
			bitmovinAccountId: accountId,
			input: { inputId: itemId, inputPath: "/clip.ts" },
		},
	},
	{
		name: "content schedule",
		run: scheduleContent,
		body: {
			bitmovinAccountId: accountId,
			requestId: itemId,
			schedule: { contentId: itemId },
		},
	},
	{
		name: "content stop",
		run: stopContent,
		body: { bitmovinAccountId: accountId },
	},
	{ name: "content deschedule", run: descheduleContent, method: "DELETE" },
];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.provider.mockResolvedValue({ encoding: {} });
	mocks.claim.mockResolvedValue(null);
	mocks.scheduleWrite.mockResolvedValue({ count: 1 });
});

describe.each([
	{
		label: "AISA-managed",
		origin: "MANAGED",
		plan: {
			start: { aiSceneAnalysisLive: { preset: "AISA_PREVIEW_MANAGED" } },
		},
		code: "AISA_ACTION_UNSUPPORTED",
	},
	{
		label: "AISA-imported",
		origin: "AISA_IMPORTED",
		plan: null,
		code: "AISA_IMPORTED_READ_ONLY",
	},
])("$label standard graph mutation guard", (channel) => {
	it.each(
		cases,
	)("refuses $name after the tenant row read and before provider/queue effects", async (operation) => {
		mocks.channel.mockResolvedValue({
			...channel,
			id,
			status: "RUNNING",
			bitmovinAccountId: accountId,
			bitmovinEncodingId: itemId,
			liveEffectFenceVersion: 0,
		});
		const request = new Request(
			`http://test/api/live-channels/${id}/operation?bitmovinAccountId=${accountId}&contentId=${itemId}`,
			{
				method: operation.method ?? "POST",
				...("body" in operation
					? { body: JSON.stringify(operation.body) }
					: {}),
			},
		);
		const response = await operation.run(request, context);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			details: { code: channel.code },
		});
		expect(mocks.channel).toHaveBeenCalled();
		expect(mocks.provider).not.toHaveBeenCalled();
		expect(mocks.vendor).not.toHaveBeenCalled();
		expect(mocks.queue).not.toHaveBeenCalled();
		expect(mocks.scheduleWrite).not.toHaveBeenCalled();
		expect(mocks.preflight).not.toHaveBeenCalled();
	});
});
