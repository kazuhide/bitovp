import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	context: vi.fn(),
	capabilities: vi.fn(),
	catalog: vi.fn(),
	campaigns: vi.fn(),
	create: vi.fn(),
	enqueue: vi.fn(),
	results: vi.fn(),
	select: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({ getServerContext: fake.context }));
vi.mock("@/lib/server/encoding-experiments", () => ({
	EncodingExperimentError: class extends Error {
		constructor(
			readonly status: number,
			readonly code: string,
			message: string,
		) {
			super(message);
		}
	},
	getExperimentCapabilities: fake.capabilities,
	getExperimentCatalog: fake.catalog,
	listExperimentCampaigns: fake.campaigns,
	createExperimentCampaign: fake.create,
	enqueueExperimentTrials: fake.enqueue,
	listExperimentResults: fake.results,
	selectExperimentQuality: fake.select,
}));

import { EncodingExperimentError } from "@/lib/server/encoding-experiments";
import { GET as results } from "./campaigns/[id]/results/route";
import { POST as select } from "./campaigns/[id]/select/route";
import { POST as enqueue } from "./campaigns/[id]/trials/route";
import { POST as create, GET as list } from "./campaigns/route";
import { GET as capabilities } from "./capabilities/route";
import { GET as catalog } from "./catalog/route";

const id = "11111111-1111-4111-8111-111111111111";
const organizationId = "00000000-0000-4000-8000-000000000001";
const route = (paramsId = id) => ({
	params: Promise.resolve({ id: paramsId }),
});
const prisma = {};
const experimentRoutes = "http://localhost/api/encoding-experiments/v1";
function request(path: string, init?: RequestInit) {
	return new Request(experimentRoutes + path, init);
}
function tenant(overrides: Record<string, unknown> = {}) {
	fake.context.mockResolvedValue({
		prisma,
		tenant: {
			organizationId,
			actor: "session",
			role: "OPERATOR",
			isImpersonating: false,
			...overrides,
		},
	});
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.resetAllMocks();
	vi.stubEnv("AUTH_MODE", "password");
	vi.stubEnv(
		"AUTH_SESSION_SECRET",
		"demo_session_secret_value_that_is_long_enough",
	);
	vi.stubEnv(
		"AUTH_PASSWORD_HASH",
		"scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=",
	);
	tenant();
	fake.capabilities.mockResolvedValue({ schemaVersion: 1, available: false });
	fake.campaigns.mockResolvedValue({ items: [], nextCursor: null });
	fake.create.mockResolvedValue({ id, state: "RUNNING", sealed: false });
	fake.enqueue.mockResolvedValue({ items: [], nextCursor: null });
	fake.results.mockResolvedValue({
		items: [],
		nextCursor: null,
		snapshot: "snapshot",
	});
});

it("requires authentication even for capabilities when auth is disabled", async () => {
	vi.stubEnv("AUTH_MODE", "none");
	const response = await capabilities(request("/capabilities"));
	expect(response.status).toBe(403);
	expect(fake.capabilities).not.toHaveBeenCalled();
});

it("rejects forged scope headers and admits a verified scoped token", async () => {
	tenant({ actor: "token:ordinary", tokenRoleKnown: true });
	const headers = {
		authorization: "Bearer bo_example",
		"x-bitovp-token-scope": "encoding-experiments",
	};
	expect(
		(await capabilities(request("/capabilities", { headers }))).status,
	).toBe(403);
	expect(fake.capabilities).not.toHaveBeenCalled();

	tenant({
		actor: "token:experiments",
		tokenRoleKnown: true,
		tokenScope: "encoding-experiments",
	});
	expect(
		(await capabilities(request("/capabilities", { headers }))).status,
	).toBe(200);
	expect(fake.capabilities).toHaveBeenCalledOnce();
});

it("makes the full parameter inventory available to an experiment viewer", async () => {
	tenant({
		actor: "token:experiment-viewer",
		tokenRoleKnown: true,
		tokenScope: "encoding-experiments",
		role: "VIEWER",
	});
	fake.catalog.mockResolvedValueOnce({ schemaVersion: 1, fields: [] });
	const response = await catalog(request("/catalog"));
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ schemaVersion: 1, fields: [] });
});

it("permits viewer reads and keeps writes behind the operator floor", async () => {
	tenant({
		actor: "token:experiments",
		tokenRoleKnown: true,
		tokenScope: "encoding-experiments",
		role: "VIEWER",
	});
	const response = await list(request("/campaigns?cursor=page-1"));
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("private, no-store");
	expect(fake.campaigns).toHaveBeenCalledWith(
		{ organizationId, prisma },
		"page-1",
	);
	expect(
		(await create(request("/campaigns", { method: "POST", body: "{}" })))
			.status,
	).toBe(403);
	expect(fake.create).not.toHaveBeenCalled();
});

it("rejects view-as writes even with an operator role", async () => {
	tenant({ isImpersonating: true });
	expect(
		(await create(request("/campaigns", { method: "POST", body: "{}" })))
			.status,
	).toBe(403);
	expect(fake.create).not.toHaveBeenCalled();
});

it("validates campaign IDs before DB access and supplies the resolved organization", async () => {
	const cursor = `${id}:1:1`;
	const path = `/campaigns/${id}/results?cursor=${encodeURIComponent(cursor)}`;
	expect((await results(request(path), route("not-a-uuid"))).status).toBe(422);
	expect(fake.results).not.toHaveBeenCalled();
	const res = await results(request(path), route());
	expect(res.status).toBe(200);
	expect(fake.results).toHaveBeenCalledWith(
		{ organizationId, prisma },
		id,
		cursor,
	);
	expect(await res.json()).toEqual({
		items: [],
		nextCursor: null,
		snapshot: "snapshot",
	});
});

it("protects a batch with its header idempotency key and bounds body bytes", async () => {
	const path = `/campaigns/${id}/trials`;
	const headers = { "Idempotency-Key": "batch-34" };
	expect(
		(
			await enqueue(
				request(path, { method: "POST", headers, body: " ".repeat(300000) }),
				route(),
			)
		).status,
	).toBe(413);
	expect(fake.enqueue).not.toHaveBeenCalled();
	const body = { schemaVersion: 1, trials: [{}] };
	const res = await enqueue(
		request(path, { method: "POST", headers, body: JSON.stringify(body) }),
		route(),
	);
	expect(res.status).toBe(202);
	expect(fake.enqueue).toHaveBeenCalledWith(
		{ organizationId, prisma },
		id,
		body,
		"batch-34",
	);
});

it("runs the quality selector only for an operator in the resolved tenant", async () => {
	const path = `/campaigns/${id}/select`;
	const input = {
		schemaVersion: 1,
		sourceId: "sample",
		constraints: { bitrateLimitBps: 1_500_000 },
	};
	tenant({ role: "VIEWER" });
	const submit = () =>
		select(
			request(path, { method: "POST", body: JSON.stringify(input) }),
			route(),
		);
	expect((await submit()).status).toBe(403);
	expect(fake.select).not.toHaveBeenCalled();
	tenant();
	fake.select.mockResolvedValueOnce({ status: "selected", trialId: "best" });
	const response = await submit();
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		status: "selected",
		trialId: "best",
	});
	expect(fake.select).toHaveBeenCalledWith(
		{ organizationId, prisma },
		id,
		input,
	);
});

it("passes typed conflicts through a stable public error", async () => {
	fake.create.mockRejectedValueOnce(
		new EncodingExperimentError(
			409,
			"CAPABILITY_CHANGED",
			"Worker configuration changed",
		),
	);
	const res = await create(
		request("/campaigns", { method: "POST", body: "{}" }),
	);
	expect(res.status).toBe(409);
	expect(await res.json()).toMatchObject({
		error: "Worker configuration changed",
		details: { code: "CAPABILITY_CHANGED" },
	});
});

it("uses the requested software backend and rejects ambiguous discovery", async () => {
	await catalog(request("/catalog?backend=software"));
	expect(fake.catalog).toHaveBeenCalledWith("software");
	await capabilities(request("/capabilities"));
	expect(fake.capabilities).toHaveBeenCalledWith("nvenc");
	expect(
		(
			await capabilities(
				request("/capabilities?backend=nvenc&backend=software"),
			)
		).status,
	).toBe(422);
});
