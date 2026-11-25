import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET as vod } from "@/app/api/encoding-jobs/[id]/resources/route";
import { GET as live } from "@/app/api/live-channels/[id]/runs/[runId]/resources/route";
import { resourceFixture } from "./__fixtures__/journal";
import children from "./__fixtures__/muxing-children.json";
import parentContracts from "./__fixtures__/sdk-contracts.json";

const { job, run, access } = vi.hoisted(() => ({
	job: vi.fn(),
	run: vi.fn(),
	access: vi.fn(),
}));
vi.mock("../context", () => ({
	getServerContext: async () => ({
		prisma: {
			encodingJob: { findUnique: job },
			liveChannelRun: { findFirst: run },
			encodingResourceRemoval: { findMany: async () => [] },
		},
		bitmovinAccounts: { revealForEncoding: access },
	}),
}));
const transport = vi.fn();
const jobId = randomUUID(),
	channelId = randomUUID(),
	runId = randomUUID(),
	upstream = randomUUID(),
	account = randomUUID(),
	version = randomUUID(),
	childId = randomUUID();
const req = (view: string, collection: string, id?: string, offset = 0) => {
	const q = new URLSearchParams({
		step: "selected",
		attempt: "0",
		collection,
		view,
		offset: String(offset),
	});
	if (id) q.set("childId", id);
	return new Request(`http://fixture.invalid/resources?${q}`);
};
const ask = (req: Request, viaLive = false) =>
	viaLive
		? live(req, { params: Promise.resolve({ id: channelId, runId }) })
		: vod(req, { params: Promise.resolve({ id: jobId }) });
function seed(kind: string) {
	const parent = parentContracts.find((x) => x.kind === kind);
	if (!parent) throw new Error("Missing official muxing fixture");
	const f = resourceFixture(parent, account, version);
	const row = {
		plan: {},
		stepLog: f.steps,
		bitmovinAccountId: account,
		createdAt: new Date(100),
	};
	job.mockResolvedValue(row);
	run.mockResolvedValue({ ...row, liveChannel: row });
	return f;
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", transport);
	access.mockResolvedValue({
		apiKey: "fixture",
		resourceScopeVersion: version,
		resourceScopeSince: new Date(0),
		tenantOrgId: upstream,
	});
});
afterEach(() => vi.unstubAllGlobals());
const result = (value: unknown) =>
	Response.json({ status: "SUCCESS", data: { result: value } });
const model = {
	id: childId,
	name: "muxing child",
	key: "PRIVATE_TEST_VALUE",
	kid: "PRIVATE_TEST_VALUE",
	iv: "PRIVATE_TEST_VALUE",
	customData: { embedded: "PRIVATE_TEST_VALUE" },
	bytes: "PRIVATE_TEST_VALUE",
	text: "PRIVATE_TEST_VALUE",
	type: "WIDEVINE",
};
it.each(
	children,
)("inspects $kind $collection through its documented nested transport", async (spec) => {
	const parent = seed(spec.kind),
		paths: string[] = [];
	const list = `${parent.expected}/${spec.list}`;
	const expected = (path: string) =>
		`${parent.expected}/${path.replace(/\{[^}]+\}/g, childId)}`;
	const id3 = spec.collection.startsWith("id3");
	const item = {
		...model,
		type: id3 ? "FRAME_ID" : "WIDEVINE",
		...(id3 ? { positionMode: "TIME", time: 3 } : {}),
	};
	transport.mockImplementation(async (url: string, init: RequestInit) => {
		const address = new URL(url);
		paths.push(address.pathname);
		expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(upstream);
		expect(init.method?.toUpperCase()).toBe("GET");
		if (address.pathname === list) {
			expect(address.searchParams.get("limit")).toBe(
				spec.collection === "drm" ? null : "25",
			);
			return result({ items: [item], offset: 0, totalCount: 1 });
		}
		if (spec.get && address.pathname === expected(spec.get))
			return result(item);
		if (spec.metadata && address.pathname === expected(spec.metadata))
			return result({
				customData: { bitovp: { job: jobId }, secret: "PRIVATE_TEST_VALUE" },
			});
		throw new Error("Unexpected provider path");
	});
	const index = await (
		await ask(new Request("http://fixture.invalid/resources"))
	).json();
	expect(index.resources.at(-1).childCollections).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				key: spec.collection,
				hasDetail: !!spec.get,
				hasMetadata: !!spec.metadata,
			}),
		]),
	);
	expect(transport).not.toHaveBeenCalled();
	const page = await ask(req("children", spec.collection), id3);
	expect(page.status).toBe(200);
	const p = await page.json();
	expect(p).toMatchObject({
		items: [{ id: childId, name: "muxing child" }],
		total: 1,
	});
	expect(JSON.stringify(p)).not.toContain("PRIVATE_TEST_VALUE");
	const expectedPaths = [list];
	if (spec.get) {
		const response = await ask(
			req("childDetail", spec.collection, childId),
			true,
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.fields).toMatchObject({ id: childId });
		expect(JSON.stringify(body)).not.toContain("PRIVATE_TEST_VALUE");
		expectedPaths.push(list, expected(spec.get));
	}
	if (spec.metadata) {
		const response = await ask(req("childMetadata", spec.collection, childId));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			fields: { keyCount: 2, executionStamp: true },
		});
		expectedPaths.push(list, expected(spec.metadata));
	}
	expect(paths).toEqual(expectedPaths);
});
it("refuses cross-parent, stale-account and out-of-page child requests", async () => {
	const f = seed("CREATE_MUXING_FMP4");
	expect((await ask(req("children", "id3.frameId"))).status).toBe(400);
	expect(
		(await ask(req("childDetail", "drm.widevine", "../other"))).status,
	).toBe(400);
	access.mockResolvedValueOnce(null);
	expect((await ask(req("children", "drm.widevine"))).status).toBe(409);
	run.mockResolvedValueOnce(null);
	expect(
		(await ask(req("childDetail", "drm.widevine", childId), true)).status,
	).toBe(404);
	expect(transport).not.toHaveBeenCalled();
	transport.mockResolvedValue(
		result({ items: [], totalCount: 25, offset: 25 }),
	);
	expect(
		(await ask(req("childMetadata", "drm.widevine", childId, 25))).status,
	).toBe(409);
	expect(transport).toHaveBeenCalledTimes(1);
	expect(new URL(String(transport.mock.calls.at(0)?.[0])).pathname).toBe(
		`${f.expected}/drm/widevine`,
	);
});
it("rejects partial lists and wrong detail identity before revealing fields", async () => {
	seed("CREATE_MUXING_FMP4");
	transport.mockResolvedValueOnce(
		result({ items: [model], totalCount: 5, offset: 0 }),
	);
	expect((await ask(req("children", "drm.widevine"))).status).toBe(502);
	transport.mockResolvedValueOnce(
		result({ items: [model], totalCount: 1, offset: 0 }),
	);
	transport.mockResolvedValueOnce(result({ ...model, id: randomUUID() }));
	expect((await ask(req("childDetail", "drm.widevine", childId))).status).toBe(
		502,
	);
});

it("rejects a recorded encoding parent from a different credential generation, including a legacy child", async () => {
	const f = seed("CREATE_MUXING_FMP4");
	const parent = f.steps[0],
		child = f.steps.at(-1);
	if (!parent || !child) throw new Error("Fixture is missing its encoding");
	parent.resourceAccount = { id: account, version: randomUUID() };
	expect((await ask(req("children", "drm.widevine"))).status).toBe(409);
	delete child.resourceAccount;
	expect((await ask(req("children", "drm.widevine"))).status).toBe(409);
	expect(transport).not.toHaveBeenCalled();
});
it("returns only the available DRM prefix and pages through complete unfiltered results locally", async () => {
	seed("CREATE_MUXING_FMP4");
	const rows = Array.from({ length: 26 }, () => ({
		...model,
		id: randomUUID(),
	}));
	transport.mockResolvedValueOnce(
		result({ items: rows.slice(0, 2), totalCount: 93, offset: 0 }),
	);
	const prefix = await (await ask(req("children", "drm"))).json();
	expect(prefix).toMatchObject({
		total: 93,
		available: 2,
		items: [{ type: "WIDEVINE" }, { type: "WIDEVINE" }],
	});
	transport.mockResolvedValueOnce(result({ items: rows, totalCount: 26 }));
	const second = await (
		await ask(req("children", "drm", undefined, 25))
	).json();
	expect(second).toMatchObject({
		offset: 25,
		available: 26,
		items: [{ id: rows.at(-1)?.id }],
	});
	transport.mockResolvedValueOnce(
		result({ items: [model, model], totalCount: 2 }),
	);
	expect((await ask(req("children", "drm"))).status).toBe(502);
});
