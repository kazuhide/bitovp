import { verificationRequestSha256 } from "@bitovp/core";
import type { AuditEntry } from "@bitovp/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import {
	createBitmovinSdkOps,
	type SdkOps,
	type SdkOpsOptions,
} from "./sdk-ops";

type Params = Parameters<SdkOps["createDefaultDashManifest"]>[0];
type Resource = {
	id: string;
	manifestName: string;
	outputs: { outputId: string; outputPath: string }[];
	customData?: Record<string, unknown>;
};
const base = (): Params => ({
	manifestName: "stream.mpd",
	name: "Default DASH",
	version: "V2",
	profile: "LIVE",
	minBufferTime: 0,
	destination: {
		outputId: "output",
		outputPath: "test/",
		acl: "PUBLIC_READ",
		mirrorOutputIds: ["mirror"],
		mirrorOutputPaths: ["/test/"],
	},
	periods: [
		{
			encodingIds: ["encoding-A", "encoding-B"],
			adaptationSets: [
				{
					type: "AND",
					conditions: [
						{
							type: "CONDITION",
							attribute: "video.codec",
							operator: "==",
							value: "H264",
						},
					],
				},
			],
		},
	],
});
function rootEncoding(): Params {
	const params = base();
	delete params.periods;
	params.encodingId = "root-encoding";
	return params;
}
const json = (result: unknown, status = 200) =>
	new Response(JSON.stringify({ data: { result } }), {
		status,
		headers: { "content-type": "application/json" },
	});
function setup({
	stamped = true,
	window = false,
	allowCreate = true,
	step = "manifest:dash",
}: {
	stamped?: boolean;
	window?: boolean;
	allowCreate?: boolean;
	step?: string;
} = {}) {
	const resources: Resource[] = [];
	const calls: { method: string; url: URL; body?: Record<string, unknown> }[] =
		[];
	let failList = false,
		failCustomData = false,
		failCreate = false,
		persistFailedCreate = true,
		recovery = window,
		createAllowed = allowCreate;
	let afterList: (() => void) | undefined;
	const audits: Array<Omit<AuditEntry, "actor"> & { actor?: string | null }> =
		[];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			const parsed = new URL(url),
				method = init.method ?? "GET",
				body = init.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ method, url: parsed, body });
			if (
				method === "GET" &&
				parsed.pathname === "/v1/encoding/manifests/dash"
			) {
				if (failList) return json({ message: "list unavailable" }, 503);
				const offset = Number(parsed.searchParams.get("offset") ?? 0),
					limit = Number(parsed.searchParams.get("limit") ?? 100);
				const result = json({ items: resources.slice(offset, offset + limit) });
				afterList?.();
				return result;
			}
			if (method === "GET" && parsed.pathname.endsWith("/customData")) {
				if (failCustomData)
					return json({ message: "custom data unavailable" }, 503);
				const id = parsed.pathname.split("/").at(-2);
				return json({
					customData: resources.find((resource) => resource.id === id)
						?.customData,
				});
			}
			if (
				method === "POST" &&
				parsed.pathname === "/v1/encoding/manifests/dash/default"
			) {
				const resource = {
					...body,
					id: `created-${resources.length + 1}`,
				} as Resource;
				if (!failCreate || persistFailedCreate) resources.push(resource);
				return failCreate
					? json({ message: "response lost after create" }, 500)
					: json(resource);
			}
			throw new Error(
				`Unexpected mock SDK request ${method} ${parsed.pathname}`,
			);
		}),
	);
	const options: SdkOpsOptions = {
		apiKey: "test-only",
		tenantOrgId: null,
		...(stamped
			? {
					stamp: {
						jobId: "job-owned",
						currentStep: () => step,
						adoptWindow: () => recovery,
						allowCreate: () => createAllowed,
					},
				}
			: {}),
	};
	const sdk = createBitmovinSdkOps(options, async (entry) => {
		audits.push(entry);
	});
	return {
		sdk,
		resources,
		calls,
		audits,
		setAfterList: (callback: () => void) => {
			afterList = callback;
		},
		setWindow: (value: boolean) => {
			recovery = value;
		},
		setAllowCreate: (value: boolean) => {
			createAllowed = value;
		},
		setFailList: () => {
			failList = true;
		},
		setFailCustomData: () => {
			failCustomData = true;
		},
		setFailCreate: (persist = true) => {
			failCreate = true;
			persistFailedCreate = persist;
		},
		posts: () => calls.filter((call) => call.method === "POST"),
	};
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
describe("owned explicit-period Default DASH adoption", () => {
	it("creates a fresh request instead of adopting an unrelated manifest at the same path", async () => {
		const t = setup();
		t.resources.push({
			id: "unrelated",
			manifestName: "stream.mpd",
			outputs: [{ outputId: "output", outputPath: "test/" }],
			customData: { bitovp: { job: "other-job", step: "manifest:dash" } },
		});
		expect(await t.sdk.createDefaultDashManifest(base())).toBe("created-2");
		expect(t.posts()).toHaveLength(1);
		expect(t.posts()[0]?.body?.periods).toEqual(base().periods);
	});
	it("stamps the complete request and adopts its own exact retry with no second POST", async () => {
		const t = setup();
		const p = base(),
			original = structuredClone(p);
		const first = await t.sdk.createDefaultDashManifest(p);
		t.setWindow(true);
		expect(await t.sdk.createDefaultDashManifest(p)).toBe(first);
		expect(t.posts()).toHaveLength(1);
		expect(p).toEqual(original);
		expect(
			t.calls
				.find((call) => call.url.pathname === "/v1/encoding/manifests/dash")
				?.url.searchParams.get("encodingId"),
		).toBe("encoding-A");
		expect(t.posts()[0]?.body?.customData).toMatchObject({
			bitovp: {
				job: "job-owned",
				step: "manifest:dash",
				manifestRequestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
		expect(
			t.calls.some((call) => call.url.pathname.endsWith("/customData")),
		).toBe(true);
		expect(
			t.audits.some(
				(entry) =>
					entry.method === "GET" &&
					(entry.response as { id?: string })?.id === first,
			),
		).toBe(true);
	});
	it.each([
		"conditions",
		"encoding IDs",
		"period order",
		"profile",
		"buffer",
		"mirror",
		"ACL",
		"namespace",
	])("refuses a same-owner retry with changed %s", async (kind) => {
		const t = setup();
		const p = base();
		if (kind === "period order")
			p.periods?.push({ encodingIds: ["encoding-C"] });
		await t.sdk.createDefaultDashManifest(p);
		const changed = structuredClone(p);
		t.setWindow(true);
		if (kind === "conditions")
			changed.periods = [
				{
					encodingIds: ["encoding-A", "encoding-B"],
					adaptationSets: [
						{
							type: "CONDITION",
							attribute: "video.codec",
							operator: "==",
							value: "VP9",
						},
					],
				},
			];
		if (kind === "encoding IDs")
			changed.periods = [{ encodingIds: ["encoding-A", "encoding-C"] }];
		if (kind === "period order") changed.periods?.reverse();
		if (kind === "profile") changed.profile = "ON_DEMAND";
		if (kind === "buffer") changed.minBufferTime = 2;
		if (kind === "mirror")
			changed.destination.mirrorOutputPaths = ["/elsewhere/"];
		if (kind === "ACL") changed.destination.acl = "PRIVATE";
		if (kind === "namespace")
			changed.namespaces = [{ prefix: "example", uri: "urn:example" }];
		await expect(t.sdk.createDefaultDashManifest(changed)).rejects.toThrow(
			/request.*(?:conflict|match)|identity/i,
		);
		expect(t.posts()).toHaveLength(1);
	});
	it("canonicalizes object keys without changing ordered period and condition arrays", async () => {
		const t = setup();
		const p = base();
		const first = await t.sdk.createDefaultDashManifest(p);
		const reordered: Params = {
			...p,
			periods: [
				{
					adaptationSets: [
						{
							conditions: [
								{
									value: "H264",
									operator: "==",
									attribute: "video.codec",
									type: "CONDITION",
								},
							],
							type: "AND",
						},
					],
					encodingIds: ["encoding-A", "encoding-B"],
				},
			],
		};
		expect(await t.sdk.createDefaultDashManifest(reordered)).toBe(first);
		expect(t.posts()).toHaveLength(1);
	});
	it("rejects duplicate owned matches rather than taking the first", async () => {
		const t = setup();
		await t.sdk.createDefaultDashManifest(base());
		const existing = t.resources[0];
		if (!existing) throw new Error("missing created resource");
		t.resources.push({ ...structuredClone(existing), id: "duplicate" });
		t.setWindow(true);
		await expect(t.sdk.createDefaultDashManifest(base())).rejects.toThrow(
			/ambiguous|duplicate/i,
		);
		expect(t.posts()).toHaveLength(1);
	});
	it("refuses a legacy ownership marker without a request hash", async () => {
		const t = setup({ window: true });
		t.resources.push({
			id: "legacy",
			manifestName: "stream.mpd",
			outputs: [{ outputId: "output", outputPath: "test/" }],
			customData: { bitovp: { job: "job-owned", step: "manifest:dash" } },
		});
		await expect(t.sdk.createDefaultDashManifest(base())).rejects.toThrow(
			/request|identity/i,
		);
		expect(t.posts()).toHaveLength(0);
	});
	it.each([
		"list",
		"customData",
		"horizon",
	])("fails closed when the %s lookup is inconclusive", async (kind) => {
		const t = setup();
		await t.sdk.createDefaultDashManifest(base());
		t.setWindow(true);
		if (kind === "list") t.setFailList();
		if (kind === "customData") t.setFailCustomData();
		if (kind === "horizon")
			for (let i = 0; i < 499; i++)
				t.resources.push({
					id: `other-${i}`,
					manifestName: "different.mpd",
					outputs: [],
				});
		await expect(t.sdk.createDefaultDashManifest(base())).rejects.toThrow(
			/lookup|scan|limit|identity/i,
		);
		expect(t.posts()).toHaveLength(1);
	});
	it("does not create into an unresolved crash window", async () => {
		const t = setup({ window: true });
		await expect(t.sdk.createDefaultDashManifest(base())).rejects.toThrow(
			/window|unresolved|identity/i,
		);
		expect(t.posts()).toHaveLength(0);
	});
	it.each([
		"parameter",
		"lifecycle",
	])("honors %s reconciliation-only authorization", async (kind) => {
		const t = setup({ allowCreate: kind !== "lifecycle" });
		const p = base();
		if (kind === "parameter") p.allowCreate = false;
		await expect(t.sdk.createDefaultDashManifest(p)).rejects.toThrow(
			/create intent|authorized|cancelled/i,
		);
		expect(t.posts()).toHaveLength(0);
	});
	it("can reconcile an owned manifest after create authorization has been withdrawn", async () => {
		const t = setup();
		const first = await t.sdk.createDefaultDashManifest(base());
		t.setAllowCreate(false);
		t.setWindow(true);
		expect(
			await t.sdk.createDefaultDashManifest({ ...base(), allowCreate: false }),
		).toBe(first);
		expect(t.posts()).toHaveLength(1);
	});
	it("reconciles a create whose response failed after the stamped request was accepted", async () => {
		const t = setup();
		t.setFailCreate();
		expect(await t.sdk.createDefaultDashManifest(base())).toBe("created-1");
		expect(t.posts()).toHaveLength(1);
		expect(
			t.audits.some(
				(entry) =>
					(entry.request as { phase?: string })?.phase === "post-failure",
			),
		).toBe(true);
	});
	it("propagates a failed create when no owned resource can be proven", async () => {
		const t = setup();
		t.setFailCreate(false);
		await expect(t.sdk.createDefaultDashManifest(base())).rejects.toThrow();
		expect(t.posts()).toHaveLength(1);
	});
	it("allows a first unstamped direct create while refusing name/output adoption", async () => {
		const t = setup({ stamped: false });
		t.resources.push({
			id: "unrelated",
			manifestName: "stream.mpd",
			outputs: [{ outputId: "output", outputPath: "test/" }],
		});
		expect(await t.sdk.createDefaultDashManifest(base())).toBe("created-2");
		expect(t.posts()).toHaveLength(1);
	});
	it("binds the executor's resolved period encoding IDs and full configuration", async () => {
		const t = setup();
		const result = await executeStep(
			{
				kind: "CREATE_MANIFEST_DASH",
				step: "manifest:dash",
				payload: {
					generationMode: "DEFAULT",
					manifestName: "stream.mpd",
					name: "Default DASH",
					outputPath: "test/",
					minBufferTime: 0,
					periods: [
						{
							adaptationSets: [
								{
									type: "CONDITION",
									attribute: "video.height",
									operator: ">=",
									value: "720",
								},
							],
						},
					],
				},
				refs: {
					outputId: "out",
					"periodEncodingIds:0": ["encoding:first", "encoding:second"],
				},
			},
			{
				sdk: t.sdk,
				ids: new Map([
					["out", "output"],
					["encoding:first", "resolved-A"],
					["encoding:second", "resolved-B"],
				]),
				resolveCredential: vi.fn(),
				poll: { intervalMs: 1, timeoutMs: 1, sleep: async () => {} },
			},
		);
		expect(result.resourceId).toBe("created-1");
		expect(t.posts()[0]?.body?.periods).toEqual([
			{
				encodingIds: ["resolved-A", "resolved-B"],
				adaptationSets: [
					{
						type: "CONDITION",
						attribute: "video.height",
						operator: ">=",
						value: "720",
					},
				],
			},
		]);
		expect(t.posts()[0]?.body?.customData).toBeDefined();
	});
	it("rejects strict reconciliation without an ownership identity", async () => {
		const t = setup({ stamped: false });
		await expect(
			t.sdk.createDefaultDashManifest({ ...base(), strictIdentity: true }),
		).rejects.toThrow(/ownership|identity/i);
		expect(t.posts()).toHaveLength(0);
	});
	it.each([
		"empty periods",
		"empty encoding IDs",
		"root encoding ID",
		"wrong algorithm",
	])("rejects malformed explicit period identity: %s", async (kind) => {
		const t = setup();
		const p = base();
		if (kind === "empty periods") p.periods = [];
		if (kind === "empty encoding IDs") p.periods = [{ encodingIds: [] }];
		if (kind === "root encoding ID") p.encodingId = "enc";
		if (kind === "wrong algorithm") p.version = "V1";
		await expect(t.sdk.createDefaultDashManifest(p)).rejects.toThrow(
			/V2|encoding IDs|encodingId/i,
		);
		expect(t.posts()).toHaveLength(0);
	});
	it("rechecks create authorization after the provider lookup completes", async () => {
		const t = setup();
		t.setAfterList(() => t.setAllowCreate(false));
		await expect(t.sdk.createDefaultDashManifest(base())).rejects.toThrow(
			/create intent|authorized/i,
		);
		expect(t.posts()).toHaveLength(0);
	});
	it("refuses an incomplete configured job-step stamp before any provider call", async () => {
		const t = setup({ step: "" });
		await expect(t.sdk.createDefaultDashManifest(base())).rejects.toThrow(
			/complete job and step identity/i,
		);
		expect(t.calls).toHaveLength(0);
	});
	it("cannot fall back to an account-wide name lookup without any encoding selection", async () => {
		const t = setup();
		const p = base();
		delete p.periods;
		await expect(t.sdk.createDefaultDashManifest(p)).rejects.toThrow(
			/encodingId|period list/i,
		);
		expect(t.calls).toHaveLength(0);
	});
	it("keeps the hash and POST bound to the complete call-time wire request during lookup", async () => {
		const t = setup();
		const p = base();
		t.setAfterList(() => {
			p.periods?.[0]?.encodingIds.push("later-mutation");
			p.destination.outputPath = "later/";
		});
		await t.sdk.createDefaultDashManifest(p);
		const posted = t.posts()[0]?.body;
		if (!posted) throw new Error("Missing SDK request");
		const { customData, ...actualWireRequest } = posted;

		expect(
			JSON.parse(
				JSON.stringify(
					t.audits.find((entry) => entry.method === "POST")?.request,
				),
			),
		).toEqual(actualWireRequest);
		expect(customData).toMatchObject({
			bitovp: {
				manifestRequestSha256: verificationRequestSha256(actualWireRequest),
			},
		});
		expect(posted.periods).toEqual(base().periods);
		expect(posted.outputs).toMatchObject([
			{ outputId: "output", outputPath: "test/" },
			{ outputId: "mirror", outputPath: "/test/" },
		]);
	});
});

describe("owned single-encoding Default DASH adoption", () => {
	it.each([
		"V1",
		"V2",
	] as const)("stamps and adopts an exact %s retry without a second POST", async (version) => {
		const t = setup();
		const params = { ...rootEncoding(), version };
		const before = structuredClone(params);
		const first = await t.sdk.createDefaultDashManifest(params);
		t.setWindow(true);
		expect(await t.sdk.createDefaultDashManifest(params)).toBe(first);
		expect(t.posts()).toHaveLength(1);
		expect(t.posts()[0]?.body).toMatchObject({
			encodingId: "root-encoding",
			version,
			minBufferTime: 0,
			customData: {
				bitovp: {
					manifestRequestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				},
			},
		});
		expect(t.posts()[0]?.body).not.toHaveProperty("periods");
		expect(params).toEqual(before);
		expect(
			t.calls
				.find((call) => call.method === "GET")
				?.url.searchParams.get("encodingId"),
		).toBe("root-encoding");
	});
	it.each([
		[
			"buffer time",
			(params: Params) => {
				params.minBufferTime = 4;
			},
		],
		[
			"mirrors",
			(params: Params) => {
				params.destination.mirrorOutputPaths = ["changed/"];
			},
		],
		[
			"profile",
			(params: Params) => {
				params.profile = "ON_DEMAND";
			},
		],
	] as const)("rejects a retry with different %s", async (_name, change) => {
		const t = setup();
		await t.sdk.createDefaultDashManifest(rootEncoding());
		const changed = rootEncoding();
		change(changed);
		t.setWindow(true);
		await expect(t.sdk.createDefaultDashManifest(changed)).rejects.toThrow(
			/identity conflict/i,
		);
		expect(t.posts()).toHaveLength(1);
	});
	it("does not adopt an unrelated single-encoding manifest at the same path", async () => {
		const t = setup();
		t.resources.push({
			id: "unrelated",
			manifestName: "stream.mpd",
			outputs: [{ outputId: "output", outputPath: "test/" }],
			customData: { bitovp: { job: "other-job", step: "manifest:dash" } },
		});
		expect(await t.sdk.createDefaultDashManifest(rootEncoding())).toBe(
			"created-2",
		);
		expect(t.posts()).toHaveLength(1);
	});
	it("fails closed when a single-encoding lookup is inconclusive", async () => {
		const t = setup();
		t.setFailList();
		await expect(
			t.sdk.createDefaultDashManifest(rootEncoding()),
		).rejects.toThrow();
		expect(t.posts()).toHaveLength(0);
	});
	it("does not create in an unresolved single-encoding crash window", async () => {
		const t = setup({ window: true });
		await expect(
			t.sdk.createDefaultDashManifest(rootEncoding()),
		).rejects.toThrow(/crash window|unresolved/i);
		expect(t.posts()).toHaveLength(0);
	});
});
