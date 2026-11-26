import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	GET as readJob,
	DELETE as removeJob,
} from "@/app/api/encoding-jobs/[id]/resources/route";
import {
	GET as readRun,
	DELETE as removeRun,
} from "@/app/api/live-channels/[id]/runs/[runId]/resources/route";

const jobId = randomUUID(),
	runId = randomUUID(),
	channelId = randomUUID(),
	accountId = randomUUID(),
	version = randomUUID(),
	otherId = randomUUID();
const { job, run, account, transport } = vi.hoisted(() => ({
	job: vi.fn(),
	run: vi.fn(),
	account: vi.fn(),
	transport: vi.fn(),
}));
vi.mock("../../context", () => ({
	getServerContext: async () => ({
		tenant: { role: "VIEWER", isImpersonating: false },
		prisma: {
			encodingJob: { findUnique: job },
			liveChannelRun: { findFirst: run },
			encodingResourceRemoval: { findMany: async () => [] },
		},
		bitmovinAccounts: { revealForEncoding: account },
	}),
}));
beforeEach(() => {
	vi.resetAllMocks();
	vi.stubGlobal("fetch", transport);
	account.mockResolvedValue({
		apiKey: "offline-only",
		resourceScopeVersion: version,
		resourceScopeSince: new Date(0),
	});
});
afterEach(() => vi.unstubAllGlobals());

it.each([
	"VOD",
	"Live",
] as const)("uses the %s execution's exact HE-AAC configuration for viewer reads and refuses deletion", async (source) => {
	const id = randomUUID();
	const profile = source === "VOD" ? 1 : 2;
	const path = `/v1/encoding/configurations/audio/he-aac-v${profile}`;
	const step = "codec:audio";
	const receipt = {
		step,
		kind: `CREATE_CODEC_HE_AAC_V${profile}`,
		payload: {},
		refs: {},
		status: "DONE",
		attempt: 2,
		resourceId: id,
		resourceAccount: { id: accountId, version },
	};
	const execution = {
		id: source === "VOD" ? jobId : runId,
		plan: {},
		createdAt: new Date(),
		bitmovinAccountId: accountId,
		stepLog: [receipt],
	};
	job.mockResolvedValue({ ...execution, status: "FINISHED" });
	run.mockResolvedValue({
		...execution,
		status: "STOPPED",
		liveChannel: { ...execution, origin: "MANAGED", status: "STOPPED" },
	});
	const get = (query: string) => {
		const request = new Request(`http://fixture.invalid/resources?${query}`);
		return source === "VOD"
			? readJob(request, { params: Promise.resolve({ id: jobId }) })
			: readRun(request, { params: Promise.resolve({ id: channelId, runId }) });
	};
	const owner = source === "VOD" ? jobId : channelId;
	let stampOwner = owner;
	const selected = {
		id,
		name: "Programme audio",
		bitrate: 32000,
		privateData: "fixture-personal",
	};
	const pageItem = { id: otherId, name: "Another programme" };
	transport.mockImplementation(async (url: string, init: RequestInit) => {
		expect(init.method).toBe("GET");
		const u = new URL(url);
		let result: unknown;
		if (u.pathname.toLowerCase() === `${path}/${id}/customdata`) {
			result = {
				customData: {
					privateData: "fixture-personal",
					bitovp: { job: stampOwner, step: `${step}#2` },
				},
			};
		} else if (u.pathname === `${path}/${id}`) {
			result = selected;
		} else {
			expect(u.pathname).toBe(path);
			expect(u.searchParams.get("name")).toBe(selected.name);
			result = { items: [pageItem, selected], offset: 0, totalCount: 2 };
		}
		return Response.json({ status: "SUCCESS", data: { result } });
	});
	const index = await get("");
	expect(index.headers.get("Cache-Control")).toBe("private, no-store");
	expect(await index.json()).toMatchObject({
		canManage: false,
		canRemove: false,
		resources: [
			{ id, step, attempt: 2, listScope: "linked", hasCustomData: true },
		],
	});
	const base = "step=codec%3Aaudio&attempt=2";
	const detail = await get(base);
	expect(await detail.json()).toEqual({
		fields: { id, name: selected.name, bitrate: 32000 },
	});
	const list = await get(`${base}&view=siblings`);
	expect(await list.json()).toEqual({
		offset: 0,
		total: 1,
		items: [{ id, name: selected.name, bitrate: 32000 }],
	});
	expect(await (await get(`${base}&view=customData`)).json()).toEqual({
		fields: { keyCount: 2, executionStamp: true },
	});
	stampOwner = otherId;
	expect(await (await get(`${base}&view=customData`)).json()).toEqual({
		fields: { keyCount: 2, executionStamp: false },
	});
	expect(account).toHaveBeenCalledWith(accountId);
	const reads = transport.mock.calls.length;
	const request = new Request("http://fixture.invalid/resources", {
		method: "DELETE",
		body: JSON.stringify({ step, attempt: 2, confirmResourceId: id }),
	});
	const denied =
		source === "VOD"
			? await removeJob(request, { params: Promise.resolve({ id: jobId }) })
			: await removeRun(request, {
					params: Promise.resolve({ id: channelId, runId }),
				});
	expect(denied.status).toBe(403);
	expect((await get("step=codec%3Aaudio&attempt=1")).status).toBe(409);
	account.mockResolvedValueOnce(null);
	expect((await get(base)).status).toBe(409);
	job.mockResolvedValue(null);
	run.mockResolvedValue(null);
	expect((await get(base)).status).toBe(404);
	if (source === "Live")
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: runId, liveChannelId: channelId },
			}),
		);
	expect(transport).toHaveBeenCalledTimes(reads);
});
