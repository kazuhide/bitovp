import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	DELETE as removeVod,
	POST as verifyVodRemoval,
	GET as vod,
} from "@/app/api/encoding-jobs/[id]/resources/route";
import { GET as live } from "@/app/api/live-channels/[id]/runs/[runId]/resources/route";
import { auditedOperationCases } from "../../../../../../scripts/api-coverage-test-cases";
import encodingChildren from "./__fixtures__/encoding-children.json";
import { resourceFixture } from "./__fixtures__/journal";
import manifestChildren from "./__fixtures__/manifest-children.json";
import children from "./__fixtures__/muxing-children.json";
import parentContracts from "./__fixtures__/sdk-contracts.json";
import streamChildren from "./__fixtures__/stream-children.json";

const { job, run, access } = vi.hoisted(() => ({
	job: vi.fn(),
	run: vi.fn(),
	access: vi.fn(),
}));
vi.mock("../context", () => ({
	getServerContext: async () => ({
		tenant: { role: "OPERATOR", isImpersonating: false },
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
function parentContract(kind: string) {
	if (kind === "CREATE_ENCODING")
		return {
			kind,
			parents: {},
			detail: "/encoding/encodings/{encoding_id}",
		};
	const parent = parentContracts.find((x) => x.kind === kind);
	if (!parent) throw new Error("Missing recorded resource fixture");
	return parent;
}
function seed(kind: string, parentPath?: string) {
	const parent = parentContract(kind);
	const f = resourceFixture(
		{ ...parent, detail: parentPath ?? parent.detail },
		account,
		version,
	);
	const row = {
		plan: {},
		status: "FINISHED",
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
	data: "PRIVATE_TEST_VALUE",
	license: "PRIVATE_TEST_VALUE",
	filename: "PRIVATE_TEST_VALUE",
	description: "PRIVATE_TEST_VALUE",
	input: { inputPath: "PRIVATE_TEST_VALUE" },
	type: "WIDEVINE",
};

type RelatedCase = {
	kind: string;
	collection: string;
	parentPath?: string;
	list: string;
	get?: string;
	model?: object;
	fields?: Partial<Record<string, string | boolean | number>>;
};
const newChildren: RelatedCase[] = [
	...encodingChildren,
	...manifestChildren,
	...streamChildren,
];

it.each(
	auditedOperationCases(
		import.meta.url,
		"recorded-child-reads",
		newChildren,
		(spec) => {
			const prefix = spec.parentPath ?? parentContract(spec.kind).detail;
			return [spec.list, spec.get].flatMap((path) =>
				path ? [`GET ${prefix}/${path}`] : [],
			);
		},
	),
)("inspects the documented child transport for $kind $collection", async (spec) => {
	const parent = seed(spec.kind, spec.parentPath);
	const list = `${parent.expected}/${spec.list}`;
	const detail =
		spec.get && `${parent.expected}/${spec.get.replace(/\{[^}]+\}/g, childId)}`;
	const expected = { id: childId, ...spec.fields };
	const item = {
		...model,
		name: undefined,
		type: undefined,
		...spec.fields,
		...spec.model,
	};
	const paths: string[] = [];
	transport.mockImplementation(async (url: string, init: RequestInit) => {
		const address = new URL(url);
		paths.push(address.pathname);
		expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(upstream);
		expect(init.method?.toUpperCase()).toBe("GET");
		if (address.pathname === list) {
			expect(address.searchParams.get("offset")).toBe("25");
			expect(address.searchParams.get("limit")).toBe("25");
			return result({ items: [item], offset: 25, totalCount: 26 });
		}
		if (address.pathname === detail) return result(item);
		throw new Error("Unexpected provider path");
	});
	const index = await (
		await ask(new Request("http://fixture.invalid/resources"))
	).json();
	expect(index.resources.at(-1)?.childCollections).toContainEqual(
		expect.objectContaining({ key: spec.collection, hasDetail: !!spec.get }),
	);
	expect(transport).not.toHaveBeenCalled();
	const page = await ask(req("children", spec.collection, undefined, 25));
	expect(page.status).toBe(200);
	expect(await page.json()).toEqual({
		items: [expected],
		total: 26,
		available: 26,
		offset: 25,
	});
	if (detail) {
		const response = await ask(
			req("childDetail", spec.collection, childId, 25),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ fields: expected });
	}
	expect(paths).toEqual(detail ? [list, list, detail] : [list]);
});

it("reads the recorded encoding root without making it removable", async () => {
	const parent = seed("CREATE_ENCODING");
	const index = await (
		await ask(new Request("http://fixture.invalid/resources"))
	).json();
	expect(index.canRemove).toBe(true);
	expect(index.resources).toMatchObject([{ id: parent.id, readOnly: true }]);
	for (const [method, handler] of [
		["DELETE", removeVod],
		["POST", verifyVodRemoval],
	] as const) {
		const response = await handler(
			new Request("http://fixture.invalid/resources", {
				method,
				body: JSON.stringify({
					step: "selected",
					attempt: 0,
					confirmResourceId: parent.id,
				}),
			}),
			{ params: Promise.resolve({ id: jobId }) },
		);
		expect(response.status).toBe(409);
	}
	expect(access).not.toHaveBeenCalled();
	expect(transport).not.toHaveBeenCalled();
	transport.mockImplementationOnce(async (url: string, init: RequestInit) => {
		expect(new URL(url).pathname).toBe(parent.expected);
		expect(init.method?.toUpperCase()).toBe("GET");
		expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(upstream);
		return result({ ...model, id: parent.id, type: "VOD", status: "FINISHED" });
	});
	const response = await ask(
		new Request("http://fixture.invalid/resources?step=selected&attempt=0"),
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		fields: {
			id: parent.id,
			name: model.name,
			type: "VOD",
			status: "FINISHED",
		},
	});
});

it("does not read a child detail when unseen rows invalidate the provider list", async () => {
	seed("CREATE_MUXING_FMP4");
	const rows = Array.from({ length: 26 }, () => ({
		...model,
		id: randomUUID(),
	}));
	rows[0] = model;
	transport.mockResolvedValueOnce(result({ items: rows, totalCount: 26 }));
	expect((await ask(req("childDetail", "drm", childId, 25))).status).toBe(409);
	rows[25] = model;
	transport.mockResolvedValueOnce(
		result({
			items: [{ ...model, id: "../not-an-id" }, ...rows.slice(1)],
			totalCount: 26,
		}),
	);
	expect((await ask(req("childDetail", "drm", childId, 25))).status).toBe(502);
	transport.mockResolvedValueOnce(result({ items: rows, totalCount: 26 }));
	expect((await ask(req("childDetail", "drm", childId, 25))).status).toBe(502);
	expect(transport).toHaveBeenCalledTimes(3);
});

it("omits numeric and enum fields with invalid provider values", async () => {
	seed("CREATE_STREAM");
	transport.mockResolvedValueOnce(
		result({
			items: [
				{
					...model,
					width: "PRIVATE_TEST_VALUE",
					aspectMode: "PRIVATE_TEST_VALUE",
				},
			],
			totalCount: 1,
		}),
	);
	const response = await ask(req("children", "bif"));
	expect(response.status).toBe(200);
	const data = await response.json();
	expect(data).toMatchObject({ items: [{ id: childId }] });
	expect(JSON.stringify(data)).not.toContain("PRIVATE_TEST_VALUE");
});

it.each([
	["CREATE_ENCODING", "muxings"],
	["CREATE_STREAM", "bif"],
	["CREATE_DASH_ADAPTATION_SET_VIDEO", "representations"],
])("refuses invalid recorded IDs before reading %s children", async (kind, collection) => {
	const f = seed(kind);
	const first = f.steps[0];
	if (!first?.resourceId) throw new Error("Fixture is missing a resource ID");
	const previous = first.resourceId;
	const invalid = "invalid/resource-id";
	first.resourceId = invalid;
	for (const step of f.steps) {
		const request = step.request;
		if (!request || typeof request !== "object" || !("refs" in request))
			continue;
		const refs = request.refs;
		if (!refs || typeof refs !== "object" || Array.isArray(refs)) continue;
		for (const [key, value] of Object.entries(refs)) {
			if (value === previous) Object.assign(refs, { [key]: invalid });
		}
	}
	const response = await ask(req("children", collection));
	expect(response.status).toBe(404);
	expect(access).not.toHaveBeenCalled();
	expect(transport).not.toHaveBeenCalled();
});

it("uses HLS custom-tag fields on list and detail", async () => {
	seed("CREATE_HLS_STREAM_INFO");
	const tag = {
		id: childId,
		positionMode: "FRAME",
		data: "PRIVATE_TEST_VALUE",
	};
	const page = { items: [tag], totalCount: 1, offset: 0 };
	transport
		.mockResolvedValueOnce(result(page))
		.mockResolvedValueOnce(result(page))
		.mockResolvedValueOnce(result(tag));
	const list = await ask(req("children", "customTags"));
	const detail = await ask(req("childDetail", "customTags", childId));
	expect(list.status).toBe(200);
	expect(detail.status).toBe(200);
	expect(await list.json()).toEqual({
		items: [{ id: childId }],
		total: 1,
		available: 1,
		offset: 0,
	});
	expect(await detail.json()).toEqual({ fields: { id: childId } });
});

it("omits free-form provider fields from generic HDR10+ stream inspection", async () => {
	seed("CREATE_ENCODING");
	const stream = {
		id: childId,
		type: "HDR10_PLUS",
		name: "PRIVATE_TEST_VALUE",
		description: "PRIVATE_TEST_VALUE",
		videoInputPath: "PRIVATE_TEST_VALUE",
		metadataInputPath: "PRIVATE_TEST_VALUE",
		customData: { secret: "PRIVATE_TEST_VALUE" },
	};
	const page = { items: [stream], totalCount: 1, offset: 0 };
	transport
		.mockResolvedValueOnce(result(page))
		.mockResolvedValueOnce(result(page))
		.mockResolvedValueOnce(result(stream));
	const list = await ask(req("children", "inputStreams"));
	const detail = await ask(req("childDetail", "inputStreams", childId));
	const fields = { id: childId, type: "HDR10_PLUS" };
	expect(list.status).toBe(200);
	expect(detail.status).toBe(200);
	expect(await list.json()).toMatchObject({ items: [fields] });
	expect((await detail.json()).fields).toEqual(fields);
});

it.each([
	["muxings.mp3", "MP3", "FMP4"],
	["sidecars.webvtt", "WEB_VTT", "UNSUPPORTED_TYPE"],
])("checks the %s discriminator before SDK mapping", async (collection, type, wrong) => {
	seed("CREATE_ENCODING");
	const item = { id: childId };
	const valid = { items: [item], totalCount: 1 };
	const invalid = { id: childId, type: wrong };
	transport.mockResolvedValueOnce(result({ items: [invalid], totalCount: 1 }));
	expect((await ask(req("childDetail", collection, childId))).status).toBe(502);
	expect(transport).toHaveBeenCalledTimes(1);
	transport
		.mockResolvedValueOnce(result(valid))
		.mockResolvedValueOnce(result(invalid));
	expect((await ask(req("childDetail", collection, childId))).status).toBe(502);
	expect(transport).toHaveBeenCalledTimes(3);
	transport
		.mockResolvedValueOnce(result(valid))
		.mockResolvedValueOnce(result(item));
	const compatible = await ask(req("childDetail", collection, childId));
	expect(compatible.status).toBe(200);
	expect(await compatible.json()).toEqual({ fields: { id: childId, type } });
});

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
