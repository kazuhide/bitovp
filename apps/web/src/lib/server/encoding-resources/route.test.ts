import { randomUUID } from "node:crypto";
import type { StepLogEntry } from "@bitovp/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET as vod } from "@/app/api/encoding-jobs/[id]/resources/route";
import { GET as live } from "@/app/api/live-channels/[id]/runs/[runId]/resources/route";
import { resourceFixture } from "./__fixtures__/journal";
import contracts from "./__fixtures__/sdk-contracts.json";
import { parseResourceLog, selectResource } from "./selection";

const jobId = randomUUID(),
	channelId = randomUUID(),
	runId = randomUUID(),
	accountId = randomUUID(),
	version = randomUUID(),
	upstream = randomUUID();
const { job, run, access } = vi.hoisted(() => ({
	job: vi.fn(),
	run: vi.fn(),
	access: vi.fn(),
}));
vi.mock("../context", () => ({
	getServerContext: async () => ({
		prisma: {
			encodingJob: { findUnique: job },
			encodingResourceRemoval: { findMany: async () => [] },
			liveChannelRun: { findFirst: run },
		},
		bitmovinAccounts: { revealForEncoding: access },
	}),
}));
const fixture = (contract: (typeof contracts)[number]) =>
	resourceFixture(contract, accountId, version);
function seeded(steps: StepLogEntry[]) {
	job.mockResolvedValue({
		id: jobId,
		status: "FINISHED",
		plan: {},
		createdAt: new Date(),
		stepLog: steps,
		bitmovinAccountId: accountId,
	});
	run.mockResolvedValue({
		id: runId,
		status: "STOPPED",
		stepLog: steps,
		liveChannel: {
			plan: {},
			bitmovinAccountId: accountId,
			createdAt: new Date(),
		},
	});
}
const transport = vi.fn();
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", transport);
	access.mockResolvedValue({
		resourceScopeVersion: version,
		resourceScopeSince: new Date(0),
		tenantOrgId: upstream,
		apiKey: "fixture-key",
	});
});
afterEach(() => vi.unstubAllGlobals());
const read = (query: string) =>
	vod(new Request(`http://fixture.invalid/resources?${query}`), {
		params: Promise.resolve({ id: jobId }),
	});
it.each(
	contracts,
)("reaches the official typed transport for $kind and projects public fields", async (contract) => {
	const { steps, id, expected } = fixture(contract);
	seeded(steps);
	const item = {
		id,
		name: "recorded",
		password: "fixture-secret",
		apiKey: "fixture-secret",
		host: "fixture-private",
	};
	let expectedPath = expected;
	transport.mockImplementation(async (url: URL | string, init: RequestInit) => {
		const address = new URL(url);
		expect(address.pathname).toBe(expectedPath);
		expect(init.method?.toUpperCase()).toBe("GET");
		expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(upstream);
		const isPage = address.searchParams.has("limit");
		if (isPage) {
			expect(address.searchParams.get("limit")).toBe("25");
			expect(address.searchParams.get("offset")).toBe("0");
		}
		return Response.json({
			status: "SUCCESS",
			data: {
				result: isPage ? { items: [item], offset: 0, totalCount: 1 } : item,
			},
		});
	});
	const index = await (await read("")).json();
	expect(index.resources).toEqual(
		expect.arrayContaining([expect.objectContaining({ step: "selected", id })]),
	);
	expect(transport).not.toHaveBeenCalled();
	const res = await read("step=selected&attempt=0");
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(JSON.parse(body).fields.id).toBe(id);
	expect(body).not.toMatch(/fixture-secret|fixture-private/);
	if (contract.collection) {
		expectedPath = expected.substring(0, expected.lastIndexOf("/"));
		const page = await (
			await read("step=selected&attempt=0&view=siblings")
		).json();
		expect(page.items).toEqual([expect.objectContaining({ id })]);
		expect(page.total).toBe(1);
		expect(JSON.stringify(page)).not.toMatch(/fixture-secret|fixture-private/);
	}
	expect(transport).toHaveBeenCalledTimes(contract.collection ? 2 : 1);
});

it("projects an HDR10+ track without exposing its media, sidecar, or free-form provider fields", async () => {
	const contract = contracts.find(
		(c) => c.kind === "CREATE_HDR10_PLUS_INPUT_STREAM",
	);
	if (!contract) throw new Error("Missing HDR10+ fixture");
	const { steps, id, expected } = fixture(contract);
	seeded(steps);
	const privateFields = {
		inputId: "private-input",
		videoInputPath: "s3://private-picture",
		metadataInputPath: "private-metadata.json",
		customData: { liveToken: "private-token" },
		name: "private-name",
		description: "private-description",
		metadata: { source: "private-content" },
	};
	const createdAt = "2026-11-25T12:13:14.000Z";
	const item = {
		...privateFields,
		id,
		createdAt,
		selectionMode: "VIDEO_RELATIVE",
		position: 0,
	};
	const selectedPath = expected.slice(0, expected.lastIndexOf("/"));
	const siblingId = randomUUID();
	transport.mockImplementation(async (url: URL | string, init: RequestInit) => {
		const address = new URL(url);
		expect(init.method).toBe("GET");
		expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(upstream);
		if (address.pathname === expected) {
			return Response.json({ status: "SUCCESS", data: { result: item } });
		}
		expect(address.pathname).toBe(selectedPath);
		expect(Object.fromEntries(address.searchParams)).toEqual({
			offset: "1",
			limit: "25",
		});
		return Response.json({
			status: "SUCCESS",
			data: {
				result: {
					items: [
						{
							...item,
							id: siblingId,
							selectionMode: "private-token",
							position: 99,
						},
					],
					offset: 1,
					totalCount: 2,
				},
			},
		});
	});
	const res = await read("step=selected&attempt=0");
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({
		fields: { id, createdAt, selectionMode: "VIDEO_RELATIVE", position: 0 },
	});
	const page = await read("step=selected&attempt=0&view=siblings&offset=1");
	expect(page.status).toBe(200);
	expect(await page.json()).toEqual({
		offset: 1,
		total: 2,
		items: [{ id: siblingId, createdAt }],
	});
	expect(transport).toHaveBeenCalledTimes(2);
});

it("refuses an HDR10+ read outside the recorded encoding and account scope", async () => {
	const contract = contracts.find(
		(c) => c.kind === "CREATE_HDR10_PLUS_INPUT_STREAM",
	);
	if (!contract) throw new Error("Missing HDR10+ fixture");
	const { steps } = fixture(contract),
		[parent, track] = steps;
	if (!parent || !track) throw new Error("Missing recorded encoding and track");
	const attempt = "step=selected&attempt=0";
	parent.resourceAccount = { id: accountId, version: randomUUID() };
	seeded(steps);
	expect((await read(attempt)).status).toBe(409);
	expect((await read(`${attempt}&view=siblings`)).status).toBe(409);
	parent.resourceAccount = { id: accountId, version };
	track.request = { refs: { encodingId: randomUUID() } };
	expect((await read(attempt)).status).toBe(404);
	expect(transport).not.toHaveBeenCalled();
});

it("rejects a swapped parent, stale attempt, changed account or a foreign execution before using the provider", async () => {
	const sample = contracts.find(
		(c) => c.kind === "CREATE_DASH_REPRESENTATION_FMP4",
	);
	if (!sample) throw new Error("Missing fixture");
	const { steps } = fixture(sample),
		target = steps.at(-1);
	if (!target) throw new Error("Missing step");
	seeded(steps);
	expect((await read("step=selected&attempt=2")).status).toBe(409);
	access.mockResolvedValueOnce({
		resourceScopeVersion: randomUUID(),
		resourceScopeSince: new Date(),
	});
	expect((await read("step=selected&attempt=0")).status).toBe(409);
	target.request = { refs: { manifestId: randomUUID() } };
	expect((await read("step=selected&attempt=0")).status).toBe(404);
	run.mockResolvedValue(null);
	expect(
		(
			await live(new Request("http://fixture.invalid/resources"), {
				params: Promise.resolve({ id: channelId, runId }),
			})
		).status,
	).toBe(404);
	expect(run).toHaveBeenCalledWith(
		expect.objectContaining({ where: { id: runId, liveChannelId: channelId } }),
	);
	expect(transport).not.toHaveBeenCalled();
});
it("does not present an incomplete collection as an empty provider page", async () => {
	const sample = contracts.find((c) => c.kind === "CREATE_STREAM");
	if (!sample) throw new Error("Missing fixture");
	seeded(fixture(sample).steps);
	transport.mockResolvedValue(
		Response.json({ status: "SUCCESS", data: { result: { totalCount: 0 } } }),
	);
	expect((await read("step=selected&attempt=0&view=siblings")).status).toBe(
		502,
	);
});
it("excludes adopted inputs, default manifests and DRM-specific representations from the custom resource families", () => {
	for (const [kind, payload, refs] of [
		["CREATE_INPUT_RTMP", {}, {}],
		["CREATE_MANIFEST_DASH", { generationMode: "DEFAULT" }, {}],
		["CREATE_DASH_REPRESENTATION_FMP4", {}, { drmId: "other" }],
	] as const) {
		const log = parseResourceLog([
			{
				kind,
				step: "resource",
				payload,
				refs,
				status: "DONE",
				resourceId: randomUUID(),
			},
		]);
		if (!log) throw new Error("Missing fixture");
		expect(selectResource(log, "resource")).toBeUndefined();
	}
});

it("rejects a DRM step whose recorded muxing type or encoding parent disagrees with its creation path", async () => {
	const contract = contracts.find(
		(c) => c.kind === "CREATE_DRM_CENC" && c.muxingKind === "FMP4",
	);
	if (!contract) throw new Error("Missing DRM fixture");
	for (const changed of ["kind", "encoding"]) {
		const f = fixture(contract);
		const parent = f.steps.find((s) => s.kind === "CREATE_MUXING_FMP4");
		if (!parent) throw new Error("Missing muxing");
		if (changed === "kind") parent.kind = "CREATE_MUXING_WEBM";
		else parent.refs.encodingId = randomUUID();
		seeded(f.steps);
		expect((await read("step=selected&attempt=0")).status).toBe(404);
	}
	expect(transport).not.toHaveBeenCalled();
});

it.each([
	"drmId",
	"representationId",
] as const)("refuses protected manifest history when the recorded %s belongs to another muxing", async (ref) => {
	const contract = contracts.find((c) => c.protectedVariant === "fmp4");
	if (!contract) throw new Error("Missing FMP4 protection contract");
	const f = fixture(contract),
		target = f.steps.find((s) => s.step === "selected");
	if (!target) throw new Error("Missing selected protection");
	const source = f.steps.find((s) => s.step === target.refs[ref]);
	const other = f.steps.find(
		(s) => s.kind === source?.kind && s.refs.muxingId !== source?.refs.muxingId,
	);
	if (!other?.resourceId) throw new Error("Missing independent muxing fixture");
	target.refs[ref] = other.step;
	(target.request as { refs: Record<string, string> }).refs[ref] =
		other.resourceId;
	seeded(f.steps);
	expect((await read("step=selected&attempt=0")).status).toBe(404);
	expect(transport).not.toHaveBeenCalled();
});
it("keeps clear and protected fMP4 representation endpoints distinct even under the same muxing and adaptation set", async () => {
	const contract = contracts.find((c) => c.protectedVariant === "fmp4-drm");
	if (!contract) throw new Error("Missing DRM representation contract");
	const f = fixture(contract),
		target = f.steps.find((s) => s.step === "selected");
	const representation = f.steps.find(
		(s) => s.step === target?.refs.representationId,
	);
	if (!representation) throw new Error("Missing representation fixture");
	delete representation.refs.drmId;
	delete (representation.request as { refs: Record<string, string> }).refs
		.drmId;
	seeded(f.steps);
	expect((await read("step=selected&attempt=0")).status).toBe(404);
	expect(transport).not.toHaveBeenCalled();
});
