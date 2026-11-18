import { createHash } from "node:crypto";
import type { StepLogEntry } from "@bitovp/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	context: vi.fn(),
	run: vi.fn(),
	provenance: vi.fn(),
	credential: vi.fn(),
	settings: vi.fn(),
	audit: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({ getServerContext: mocks.context }));
vi.mock("@/lib/server/player-config", () => ({
	readPlayerSettings: mocks.settings,
}));
vi.mock("@/lib/server/audit", () => ({ writeAuditLog: mocks.audit }));

import { GET } from "./route";

const ORG = "00000000-0000-4000-8000-000000000001";
const CHANNEL = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-000000000003";
const ENCODING = "00000000-0000-4000-8000-000000000004";
const OUTPUT = "00000000-0000-4000-8000-000000000005";
const CREDENTIAL = "00000000-0000-4000-8000-000000000006";
const ACCOUNT = "00000000-0000-4000-8000-000000000007";
const OTHER = "00000000-0000-4000-8000-000000000008";
const RUN_NAMESPACE = `run-namespace-bitovp-${RUN}`;
const playbackUrl =
	"https://subscribe.example/moq/subscriber-token?auth=subscribe-secret";
const cloudflareUrl = (operations: string[]) => {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const header = encode({
		alg: "EdDSA",
		typ: "JWT",
		kid: "not-for-browser-metadata",
	});
	const claims = encode({
		iss: "cloudflare",
		aud: "moq.cloudflare.com",
		sub: "0123456789abcdef0123456789abcdef",
		exp: 1_893_456_000,
		operations,
		jti: "not-for-browser-metadata",
	});
	return `https://draft-18.cloudflare.mediaoverquic.com/${header}.${claims}.${Buffer.alloc(64, 1).toString("base64url")}`;
};
const outputPayload = () => ({
	credentialId: CREDENTIAL,
	name: "output",
	trackNamespace: [RUN_NAMESPACE],
	draftVersion: "DRAFT_18",
});
const outputStep = (): StepLogEntry => ({
	step: "output:moq",
	kind: "CREATE_OUTPUT_MOQ",
	status: "DONE",
	payload: outputPayload(),
	refs: {},
	resourceId: OUTPUT,
	startedAt: "2026-11-17T00:00:02.000Z",
	finishedAt: "2026-11-17T00:00:04.000Z",
});
const log = (): StepLogEntry[] => [
	outputStep(),
	{
		step: "encoding:main",
		kind: "CREATE_ENCODING",
		status: "DONE",
		payload: {},
		refs: {},
		resourceId: ENCODING,
	},
	{
		step: "muxing:video",
		kind: "CREATE_MUXING_FMP4",
		status: "DONE",
		payload: {},
		refs: { encodingId: "encoding:main", outputId: "output:moq" },
		resourceId: OTHER,
	},
];
const run = () => ({
	id: RUN,
	liveChannelId: CHANNEL,
	organizationId: ORG,
	status: "RUNNING",
	endedAt: null,
	cancelRequested: false,
	bitmovinEncodingId: ENCODING,
	stepLog: log(),
});
const secret = () => ({
	relayUrl: "moqt://publisher.example:443",
	authToken: "publish-secret",
	authTokenType: 1,
	playbackUrl,
});
const credential = () => ({
	id: CREDENTIAL,
	provider: "MOQ",
	updatedAt: new Date("2026-11-17T00:00:00.000Z"),
	secret: JSON.stringify(secret()),
});
const encodingAudit = () => ({
	organizationId: ORG,
	bitmovinAccountId: ACCOUNT,
	at: new Date("2026-11-17T00:00:05.000Z"),
	request: {},
	response: { id: ENCODING },
});
const outputAudit = () => ({
	organizationId: ORG,
	bitmovinAccountId: ACCOUNT,
	at: new Date("2026-11-17T00:00:04.000Z"),
	request: {
		name: "output",
		trackNamespace: [RUN_NAMESPACE],
		draftVersion: "DRAFT_18",
		authTokenProvided: true,
	},
	response: { id: OUTPUT },
});
let encodingAudits: ReturnType<typeof encodingAudit>[];
let outputAudits: ReturnType<typeof outputAudit>[];
const request = (query = "") =>
	new Request(
		`http://test/api/live-channels/${CHANNEL}/runs/${RUN}/moq-playback${query}`,
	);
const params = () => ({ params: Promise.resolve({ id: CHANNEL, runId: RUN }) });

beforeEach(() => {
	vi.resetAllMocks();
	mocks.context.mockResolvedValue({
		tenant: { role: "OPERATOR", organizationId: ORG },
		prisma: {
			liveChannelRun: { findFirst: mocks.run },
			auditLog: { findMany: mocks.provenance },
		},
		credentials: { revealVersioned: mocks.credential },
	});
	mocks.run.mockResolvedValue(run());
	encodingAudits = [encodingAudit()];
	outputAudits = [outputAudit()];
	mocks.provenance.mockImplementation(({ where }) =>
		where.path === "/encoding/encodings" ? encodingAudits : outputAudits,
	);
	mocks.credential.mockResolvedValue(credential());
	mocks.settings.mockResolvedValue({
		provider: "native",
		playerLicenseKey: "tenant-player-key",
		analyticsLicenseKey: "analytics-secret",
	});
});
afterEach(() => vi.restoreAllMocks());

describe("run-bound MoQ playback descriptor", () => {
	it("returns only a subscribe capability and this tenant's Player key using stored run provenance", async () => {
		const response = await GET(request(), params());
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toEqual({
			runId: RUN,
			encodingId: ENCODING,
			resource: {
				type: "moq",
				url: playbackUrl,
				metadata: {
					namespace: RUN_NAMESPACE,
					catalogTrackName: "catalog",
					draftVersion: 18,
					mediaTypes: ["audio", "video"],
				},
			},
			playerLicenseKey: "tenant-player-key",
			analytics: {
				licenseKey: "analytics-secret",
				licenseKeySha256: createHash("sha256")
					.update("analytics-secret")
					.digest("hex"),
				videoId: `bitovp-moq:${ENCODING}:${RUN}`,
				collectorVersion: "2.62.0",
				latencyField: "customData1",
			},
		});
		expect(mocks.run).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { liveChannelId: CHANNEL },
				orderBy: { seq: "desc" },
			}),
		);
		expect(mocks.credential).toHaveBeenCalledExactlyOnceWith(CREDENTIAL);
		expect(mocks.settings).toHaveBeenCalledWith(
			expect.objectContaining({ liveChannelRun: expect.anything() }),
		);
		const audit = JSON.stringify(mocks.audit.mock.calls);
		for (const value of [
			playbackUrl,
			"publisher.example",
			"publish-secret",
			"subscriber-token",
			"subscribe-secret",
			"tenant-player-key",
			"analytics-secret",
		])
			expect(audit).not.toContain(value);
	});

	it("refuses a viewer before reading runs or credentials", async () => {
		const ctx = await mocks.context();
		ctx.tenant.role = "VIEWER";
		const response = await GET(request(), params());
		expect(response.status).toBe(403);
		expect(mocks.run).not.toHaveBeenCalled();
		expect(mocks.credential).not.toHaveBeenCalled();
	});

	it.each([
		"ADMIN",
		"OPERATOR",
	])("refuses subscriber capabilities during owner view-as even for target role %s", async (role) => {
		const ctx = await mocks.context();
		ctx.tenant = { ...ctx.tenant, role, isImpersonating: true };
		for (const method of ["GET", "HEAD"]) {
			const response = await GET(
				new Request(request().url, { method }),
				params(),
			);
			expect(response.status).toBe(403);
			expect(await response.text()).not.toContain("subscribe-secret");
		}
		expect(mocks.run).not.toHaveBeenCalled();
		expect(mocks.provenance).not.toHaveBeenCalled();
		expect(mocks.credential).not.toHaveBeenCalled();
		expect(mocks.settings).not.toHaveBeenCalled();
	});

	it("preserves a bound draft 16 source independently of the current channel plan", async () => {
		const value = run();
		value.stepLog = value.stepLog.map((entry) =>
			entry.kind === "CREATE_OUTPUT_MOQ"
				? {
						...entry,
						payload: { ...outputPayload(), draftVersion: "DRAFT_16" },
					}
				: entry,
		);
		mocks.run.mockResolvedValue(value);
		const proof = outputAudit();
		proof.request.draftVersion = "DRAFT_16";
		outputAudits = [proof];
		const response = await GET(request(), params());
		expect(response.status).toBe(200);
		expect((await response.json()).resource.metadata.draftVersion).toBe(16);
	});

	it.each([
		"?url=https://attacker.example",
		"?draftVersion=23",
	])("accepts no caller-selected source parameters: %s", async (query) => {
		expect((await GET(request(query), params())).status).toBe(400);
		expect(mocks.context).not.toHaveBeenCalled();
	});

	it("rejects invalid route ids before touching the database", async () => {
		expect(
			(
				await GET(request(), {
					params: Promise.resolve({ id: "invalid", runId: RUN }),
				})
			).status,
		).toBe(400);
		expect(mocks.context).not.toHaveBeenCalled();
	});

	it.each([
		null,
		{ ...run(), liveChannelId: OTHER },
		{ ...run(), organizationId: OTHER },
	])("does not reveal a run outside the requested channel/tenant", async (value) => {
		mocks.run.mockResolvedValue(value);
		expect((await GET(request(), params())).status).toBe(404);
		expect(mocks.credential).not.toHaveBeenCalled();
	});

	it("refuses an encoding pointer that conflicts with the stored create step", async () => {
		mocks.run.mockResolvedValue({ ...run(), bitmovinEncodingId: OTHER });
		expect((await GET(request(), params())).status).toBe(409);
		expect(mocks.credential).not.toHaveBeenCalled();
	});

	it("looks up the latest airing before revealing the previous run's capability", async () => {
		mocks.run.mockImplementation(({ orderBy }) =>
			orderBy ? { ...run(), id: OTHER } : run(),
		);
		expect((await GET(request(), params())).status).toBe(404);
		expect(mocks.provenance).not.toHaveBeenCalled();
		expect(mocks.credential).not.toHaveBeenCalled();
	});

	it.each([
		{ status: "STOPPED", endedAt: new Date() },
		{ status: "RUNNING", endedAt: new Date() },
		{ status: "STOPPING" },
		{ cancelRequested: true },
	])("refuses an inactive or cancelling airing before reading credentials (%j)", async (patch) => {
		mocks.run.mockResolvedValue({ ...run(), ...patch });
		expect((await GET(request(), params())).status).toBe(409);
		expect(mocks.provenance).not.toHaveBeenCalled();
		expect(mocks.credential).not.toHaveBeenCalled();
	});

	it.each([
		"legacy-namespace",
		`run-namespace-bitovp-${OTHER}`,
	])("refuses a namespace without this airing's binding even with matching CREATE evidence (%s)", async (namespace) => {
		const value = run();
		const output = value.stepLog[0];
		if (!output) throw new Error("Missing output step fixture");
		output.payload = { ...outputPayload(), trackNamespace: [namespace] };
		mocks.run.mockResolvedValue(value);
		const audit = outputAudit();
		audit.request.trackNamespace = [namespace];
		outputAudits = [audit];
		expect((await GET(request(), params())).status).toBe(409);
		expect(mocks.credential).not.toHaveBeenCalled();
	});

	it.each([
		"missing",
		"multiple",
		"non-moq",
		"tuple",
		"draft",
		"muxing-ref",
	])("refuses unsupported or ambiguous stored delivery: %s", async (kind) => {
		const value = run();
		if (kind === "missing") value.stepLog = [];
		if (kind === "multiple")
			value.stepLog.push({ ...outputStep(), step: "output:second" });
		value.stepLog = value.stepLog.map((entry) => {
			if (entry.step === "output:moq") {
				if (kind === "non-moq") return { ...entry, kind: "CREATE_OUTPUT_S3" };
				if (kind === "tuple")
					return {
						...entry,
						payload: { ...outputPayload(), trackNamespace: ["a", "b"] },
					};
				if (kind === "draft")
					return {
						...entry,
						payload: { ...outputPayload(), draftVersion: "DRAFT_23" },
					};
			}
			if (kind === "muxing-ref" && entry.step === "muxing:video")
				return {
					...entry,
					refs: { encodingId: "encoding:main", outputId: "output:other" },
				};
			return entry;
		});
		mocks.run.mockResolvedValue(value);
		expect((await GET(request(), params())).status).toBe(409);
		expect(mocks.credential).not.toHaveBeenCalled();
	});

	it.each([
		"encoding-missing",
		"output-missing",
		"encoding-duplicate",
		"output-duplicate",
		"account-conflict",
		"namespace-conflict",
		"draft-conflict",
		"output-id",
		"tenant-conflict",
	])("requires original matching Encoding and Output CREATE audits: %s", async (kind) => {
		const proof = outputAudit();
		outputAudits = [proof];
		if (kind === "encoding-missing") encodingAudits = [];
		if (kind === "output-missing") outputAudits = [];
		if (kind === "encoding-duplicate") encodingAudits.push(encodingAudit());
		if (kind === "output-duplicate") outputAudits.push(outputAudit());
		if (kind === "account-conflict") proof.bitmovinAccountId = OTHER;
		if (kind === "namespace-conflict") proof.request.trackNamespace = ["other"];
		if (kind === "draft-conflict") proof.request.draftVersion = "DRAFT_16";
		if (kind === "output-id") proof.response.id = OTHER;
		if (kind === "tenant-conflict") proof.organizationId = OTHER;
		expect((await GET(request(), params())).status).toBe(409);
		expect(mocks.credential).not.toHaveBeenCalled();
	});

	it.each([
		"changed",
		"same-boundary",
		"wrong-provider",
		"wrong-id",
	])("refuses a credential that no longer binds the output: %s", async (kind) => {
		const value = credential();
		if (kind === "changed")
			value.updatedAt = new Date("2026-11-17T00:00:03.000Z");
		if (kind === "same-boundary")
			value.updatedAt = new Date("2026-11-17T00:00:02.000Z");
		if (kind === "wrong-provider") value.provider = "AWS_S3";
		if (kind === "wrong-id") value.id = OTHER;
		mocks.credential.mockResolvedValue(value);
		expect((await GET(request(), params())).status).toBe(409);
	});

	it("requires an explicitly configured playback URL instead of deriving it from the publisher", async () => {
		const { playbackUrl: ignored, ...publisherOnly } = secret();
		mocks.credential.mockResolvedValue({
			...credential(),
			secret: JSON.stringify(publisherOnly),
		});
		const response = await GET(request(), params());
		expect(response.status).toBe(503);
		expect(
			JSON.stringify([await response.json(), mocks.audit.mock.calls]),
		).not.toContain("publish-secret");
	});

	it.each([
		"https://relay.example/publish-secret",
		"https://relay.example/subscriber=preview;publisher=publish-secret",
		"https://relay.example/preview?authorization=subscriber%253Bpublish%252Dsecret%253Blive",
	])("withholds the playback capability and audit data when the URL includes publishing material (%#)", async (url) => {
		mocks.credential.mockResolvedValue({
			...credential(),
			secret: JSON.stringify({ ...secret(), playbackUrl: url }),
		});
		const response = await GET(request(), params());
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.details).toEqual({
			code: "MOQ_PLAYBACK_SUBSCRIBE_TOKEN_REQUIRED",
		});
		const exposed = JSON.stringify([body, mocks.audit.mock.calls]);
		expect(exposed).not.toContain("publish-secret");
		expect(exposed).not.toContain(url);
	});

	it("includes only configured Cloudflare relay metadata from the bound subscribe token", async () => {
		const url = cloudflareUrl(["subscribe"]);
		mocks.credential.mockResolvedValue({
			...credential(),
			secret: JSON.stringify({ ...secret(), playbackUrl: url }),
		});
		const response = await GET(request(), params());
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.relay).toEqual({
			provider: "cloudflare",
			endpointOrigin: "https://draft-18.cloudflare.mediaoverquic.com",
			configuredRelayId: "0123456789abcdef0123456789abcdef",
			tokenExpiresAt: "2030-01-01T00:00:00.000Z",
			tokenOperations: ["subscribe"],
			metadataSource: "unverified-token-claims",
		});
		expect(body.resource.url).toBe(url);
		expect(JSON.stringify(body.relay)).not.toContain(
			"not-for-browser-metadata",
		);
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(url);
	});

	it.each([
		cloudflareUrl(["publish", "subscribe"]),
		"https://draft-18.cloudflare.mediaoverquic.com/not-a-jwt",
	])("refuses an invalid or publish-capable known Cloudflare token", async (url) => {
		mocks.credential.mockResolvedValue({
			...credential(),
			secret: JSON.stringify({ ...secret(), playbackUrl: url }),
		});
		const response = await GET(request(), params());
		expect(response.status).toBe(409);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(
			JSON.stringify([await response.json(), mocks.audit.mock.calls]),
		).not.toContain(url);
		expect(mocks.settings).not.toHaveBeenCalled();
	});

	it("requires this tenant's Player license independently of native preview selection", async () => {
		mocks.settings.mockResolvedValue({
			provider: "native",
			playerLicenseKey: "",
			analyticsLicenseKey: "analytics-secret",
		});
		expect((await GET(request(), params())).status).toBe(503);
	});

	it("returns generic failures without logging raw secret-bearing exceptions", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		mocks.credential.mockRejectedValue(
			new Error("https://relay.example/private-token"),
		);
		const response = await GET(request(), params());
		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(
			JSON.stringify([await response.json(), mocks.audit.mock.calls]),
		).not.toContain("private-token");
		expect(consoleError).not.toHaveBeenCalled();
	});
});
