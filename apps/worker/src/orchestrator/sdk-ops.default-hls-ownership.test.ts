import {
	type CompiledOperation,
	curlForStep,
	verificationRequestSha256,
} from "@bitovp/core";
import type { AuditEntry } from "@bitovp/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import {
	createBitmovinSdkOps,
	type SdkOps,
	type SdkOpsOptions,
} from "./sdk-ops";

type Params = Parameters<SdkOps["createDefaultHlsManifest"]>[0];
type Resource = {
	id: string;
	manifestName: string;
	outputs: { outputId: string; outputPath: string }[];
	customData?: Record<string, unknown>;
};
const base = (): Params => ({
	encodingId: "encoding-A",
	manifestName: "stream.m3u8",
	name: "Default HLS",
	version: "V1",
	masterVersion: "HLS_V7",
	mediaVersion: "HLS_V6",
	channelsAttributeForAudio: "ALWAYS",
	targetDurationRoundingMode: "UPWARD_ROUNDING",
	destination: {
		outputId: "output",
		outputPath: "test/",
		acl: "PUBLIC_READ",
		mirrorOutputIds: ["mirror"],
		mirrorOutputPaths: ["/test/"],
	},
});
const json = (result: unknown, status = 200) =>
	new Response(JSON.stringify({ data: { result } }), {
		status,
		headers: { "content-type": "application/json" },
	});

function setup({
	stamped = true,
	window = false,
	allowCreate = true,
	step = "manifest:hls",
	verification,
}: {
	stamped?: boolean;
	window?: boolean;
	allowCreate?: boolean;
	step?: string;
	verification?: NonNullable<SdkOpsOptions["stamp"]>["verification"];
} = {}) {
	const resources: Resource[] = [],
		calls: { method: string; url: URL; body?: Record<string, unknown> }[] = [],
		audits: Array<Omit<AuditEntry, "actor"> & { actor?: string | null }> = [];
	let failList = false,
		failCustomData = false,
		failCreate = false,
		persistFailedCreate = true,
		recovery = window,
		createAllowed = allowCreate;
	let afterList: (() => void) | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			const parsed = new URL(url),
				method = init.method ?? "GET",
				body = init.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ method, url: parsed, body });
			if (
				method === "GET" &&
				parsed.pathname === "/v1/encoding/manifests/hls"
			) {
				if (failList) return json({ message: "list unavailable" }, 503);
				const offset = Number(parsed.searchParams.get("offset") ?? 0),
					limit = Number(parsed.searchParams.get("limit") ?? 100);
				const response = json({
					items: resources.slice(offset, offset + limit),
				});
				afterList?.();
				return response;
			}
			if (method === "GET" && parsed.pathname.endsWith("/customData")) {
				if (failCustomData)
					return json({ message: "custom data unavailable" }, 503);
				return json({
					customData: resources.find(
						(resource) => resource.id === parsed.pathname.split("/").at(-2),
					)?.customData,
				});
			}
			if (
				method === "POST" &&
				parsed.pathname === "/v1/encoding/manifests/hls/default"
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
	const sdk = createBitmovinSdkOps(
		{
			apiKey: "test-only",
			tenantOrgId: null,
			...(stamped
				? {
						stamp: {
							jobId: "job-owned",
							currentStep: () => step,
							adoptWindow: () => recovery,
							allowCreate: () => createAllowed,
							...(verification ? { verification } : {}),
						},
					}
				: {}),
		},
		async (entry) => {
			audits.push(entry);
		},
	);
	return {
		sdk,
		resources,
		calls,
		audits,
		posts: () => calls.filter((call) => call.method === "POST"),
		setWindow: (value: boolean) => {
			recovery = value;
		},
		setAllowCreate: (value: boolean) => {
			createAllowed = value;
		},
		setAfterList: (callback: () => void) => {
			afterList = callback;
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
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("owned Default HLS request reconciliation", () => {
	it("stamps the complete wire request and adopts an exact retry without another POST", async () => {
		const t = setup();
		const params = base(),
			before = structuredClone(params);
		const first = await t.sdk.createDefaultHlsManifest(params);
		t.setWindow(true);
		expect(await t.sdk.createDefaultHlsManifest(params)).toBe(first);
		expect(t.posts()).toHaveLength(1);
		expect(params).toEqual(before);
		expect(
			t.calls
				.find((call) => call.url.pathname === "/v1/encoding/manifests/hls")
				?.url.searchParams.get("encodingId"),
		).toBe("encoding-A");
		expect(
			t.calls.some((call) => call.url.pathname.endsWith("/customData")),
		).toBe(true);
		const body = t.posts()[0]?.body;
		if (!body) throw new Error("missing SDK body");
		const { customData, ...wire } = body;
		expect(customData).toMatchObject({
			bitovp: {
				job: "job-owned",
				step: "manifest:hls",
				manifestRequestSha256: verificationRequestSha256(wire),
			},
		});
		expect(wire).toMatchObject({
			encodingId: "encoding-A",
			hlsMasterPlaylistVersion: "7",
			hlsMediaPlaylistVersion: "6",
			channelsAttributeForAudio: "ALWAYS",
			targetDurationRoundingMode: "UPWARD_ROUNDING",
			outputs: [
				{ outputId: "output", outputPath: "test/" },
				{ outputId: "mirror", outputPath: "/test/" },
			],
		});
		expect(
			t.audits.some(
				(entry) =>
					entry.method === "GET" &&
					(entry.response as { id?: string })?.id === first,
			),
		).toBe(true);
	});
	it.each([
		"channels",
		"rounding",
		"master version",
		"media version",
		"mirror",
		"ACL",
		"name",
	] as const)("refuses a same-owner retry with changed %s", async (kind) => {
		const t = setup();
		await t.sdk.createDefaultHlsManifest(base());
		const changed = base();
		if (kind === "channels") changed.channelsAttributeForAudio = "LEGACY";
		if (kind === "rounding")
			changed.targetDurationRoundingMode = "NORMAL_ROUNDING";
		if (kind === "master version") changed.masterVersion = "HLS_V8";
		if (kind === "media version") changed.mediaVersion = "HLS_V7";
		if (kind === "mirror")
			changed.destination.mirrorOutputPaths = ["elsewhere/"];
		if (kind === "ACL") changed.destination.acl = "PRIVATE";
		if (kind === "name") changed.name = "Changed HLS";
		t.setWindow(true);
		await expect(t.sdk.createDefaultHlsManifest(changed)).rejects.toThrow(
			/request.*(?:conflict|match)|identity/i,
		);
		expect(t.posts()).toHaveLength(1);
	});
	it("does not adopt another job's resource at the same destination", async () => {
		const t = setup();
		t.resources.push({
			id: "foreign",
			manifestName: "stream.m3u8",
			outputs: [{ outputId: "output", outputPath: "test/" }],
			customData: { bitovp: { job: "another-job", step: "manifest:hls" } },
		});
		expect(await t.sdk.createDefaultHlsManifest(base())).toBe("created-2");
		expect(t.posts()).toHaveLength(1);
	});
	it.each([
		"list",
		"customData",
		"horizon",
	] as const)("does not POST after inconclusive %s lookup", async (kind) => {
		const t = setup();
		if (kind === "list") t.setFailList();
		if (kind === "customData") {
			t.resources.push({
				id: "foreign",
				manifestName: "stream.m3u8",
				outputs: [{ outputId: "output", outputPath: "test/" }],
			});
			t.setFailCustomData();
		}
		if (kind === "horizon")
			for (let i = 0; i < 500; i++)
				t.resources.push({
					id: `other-${i}`,
					manifestName: "different.m3u8",
					outputs: [],
				});
		await expect(t.sdk.createDefaultHlsManifest(base())).rejects.toThrow(
			/lookup|scan|limit|identity/i,
		);
		expect(t.posts()).toHaveLength(0);
	});
	it("rejects duplicate owned requests instead of taking the first resource", async () => {
		const t = setup();
		await t.sdk.createDefaultHlsManifest(base());
		const resource = t.resources[0];
		if (!resource) throw new Error("missing owned resource");
		t.resources.push({ ...structuredClone(resource), id: "duplicate" });
		t.setWindow(true);
		await expect(t.sdk.createDefaultHlsManifest(base())).rejects.toThrow(
			/ambiguous|duplicate/i,
		);
		expect(t.posts()).toHaveLength(1);
	});
	it("does not trust a legacy marker without the complete request hash", async () => {
		const t = setup({ window: true });
		t.resources.push({
			id: "legacy",
			manifestName: "stream.m3u8",
			outputs: [{ outputId: "output", outputPath: "test/" }],
			customData: { bitovp: { job: "job-owned", step: "manifest:hls" } },
		});
		await expect(t.sdk.createDefaultHlsManifest(base())).rejects.toThrow(
			/identity|request/i,
		);
		expect(t.posts()).toHaveLength(0);
	});
	it("cannot create into an unresolved crash window", async () => {
		const t = setup({ window: true });
		await expect(t.sdk.createDefaultHlsManifest(base())).rejects.toThrow(
			/crash window|unresolved/i,
		);
		expect(t.posts()).toHaveLength(0);
	});
	it.each([
		"parameter",
		"lifecycle",
		"during lookup",
	] as const)("rechecks %s creation authority", async (kind) => {
		const t = setup({ allowCreate: kind !== "lifecycle" });
		const params = base();
		if (kind === "parameter") params.allowCreate = false;
		if (kind === "during lookup") t.setAfterList(() => t.setAllowCreate(false));
		await expect(t.sdk.createDefaultHlsManifest(params)).rejects.toThrow(
			/create intent|authorized|cancelled/i,
		);
		expect(t.posts()).toHaveLength(0);
	});
	it("reconciles an owned request after create authority is withdrawn", async () => {
		const t = setup();
		const first = await t.sdk.createDefaultHlsManifest(base());
		t.setWindow(true);
		t.setAllowCreate(false);
		expect(
			await t.sdk.createDefaultHlsManifest({ ...base(), allowCreate: false }),
		).toBe(first);
		expect(t.posts()).toHaveLength(1);
	});
	it("adopts its stamped create after losing the response, without a second POST", async () => {
		const t = setup();
		t.setFailCreate();
		expect(await t.sdk.createDefaultHlsManifest(base())).toBe("created-1");
		expect(t.posts()).toHaveLength(1);
		expect(
			t.audits.some(
				(entry) =>
					(entry.request as { phase?: string })?.phase === "post-failure",
			),
		).toBe(true);
	});
	it("propagates failed creation when no owned request is visible", async () => {
		const t = setup();
		t.setFailCreate(false);
		await expect(t.sdk.createDefaultHlsManifest(base())).rejects.toThrow();
		expect(t.posts()).toHaveLength(1);
	});
	it("allows an unstamped direct create without adopting a resource it cannot own", async () => {
		const t = setup({ stamped: false });
		t.resources.push({
			id: "foreign",
			manifestName: "stream.m3u8",
			outputs: [{ outputId: "output", outputPath: "test/" }],
		});
		expect(await t.sdk.createDefaultHlsManifest(base())).toBe("created-2");
		expect(t.calls.filter((call) => call.method === "GET")).toHaveLength(0);
	});
	it.each([
		"unstamped strict",
		"missing step",
		"empty encoding",
		"wrong version",
	] as const)("rejects %s identity before provider calls", async (kind) => {
		const t = setup({
			stamped: kind !== "unstamped strict",
			step: kind === "missing step" ? "" : "manifest:hls",
		});
		const params = base();
		if (kind === "unstamped strict") params.strictIdentity = true;
		if (kind === "empty encoding") params.encodingId = "";
		if (kind === "wrong version") params.version = "V2";
		await expect(t.sdk.createDefaultHlsManifest(params)).rejects.toThrow(
			/identity|encodingId|version|HlsManifestDefaultVersion/i,
		);
		expect(t.calls).toHaveLength(0);
	});
	it("keeps audit, hash and POST bound to the pre-await SDK wire body", async () => {
		const t = setup();
		const params = base();
		params.name = "";
		params.destination.mirrorOutputIds = [];
		params.destination.mirrorOutputPaths = [];
		t.setAfterList(() => {
			params.encodingId = "later";
			params.channelsAttributeForAudio = "LEGACY";
			params.destination.outputPath = "later/";
			params.destination.mirrorOutputIds?.push("late-mirror");
		});
		await t.sdk.createDefaultHlsManifest(params);
		const posted = t.posts()[0]?.body;
		if (!posted) throw new Error("missing wire request");
		const { customData, ...wire } = posted;
		expect(
			JSON.parse(
				JSON.stringify(
					t.audits.find((entry) => entry.method === "POST")?.request,
				),
			),
		).toEqual(wire);
		expect(wire).toMatchObject({
			encodingId: "encoding-A",
			name: "",
			channelsAttributeForAudio: "ALWAYS",
			outputs: [{ outputId: "output", outputPath: "test/" }],
		});
		expect(customData).toMatchObject({
			bitovp: { manifestRequestSha256: verificationRequestSha256(wire) },
		});
	});
	it("checks the durable verification identity as well as job and step", async () => {
		const verification = {
			key: "verify-current",
			requestSha256: "a".repeat(64),
		};
		const t = setup({ verification });
		await t.sdk.createDefaultHlsManifest(base());
		const resource = t.resources[0];
		if (!resource?.customData) throw new Error("missing owner marker");
		const marker = resource.customData.bitovp as Record<string, unknown>;
		marker.verification = {
			key: "verify-another",
			requestSha256: "a".repeat(64),
		};
		t.setWindow(true);
		await expect(t.sdk.createDefaultHlsManifest(base())).rejects.toThrow(
			/identity conflict/i,
		);
		expect(t.posts()).toHaveLength(1);
	});
	it("retains the executor's resolved encoding, versions, globals and mirror destinations", async () => {
		const t = setup();
		const op: CompiledOperation = {
			kind: "CREATE_MANIFEST_HLS",
			step: "manifest:hls",
			payload: {
				generationMode: "DEFAULT",
				manifestName: "stream.m3u8",
				name: "Default HLS",
				hlsMasterPlaylistVersion: "HLS_V7",
				hlsMediaPlaylistVersion: "HLS_V6",
				channelsAttributeForAudio: "ALWAYS",
				targetDurationRoundingMode: "UPWARD_ROUNDING",
				outputPath: "test/",
			},
			refs: {
				encodingId: "encoding:first",
				outputId: "output:origin",
				mirrorOutputIds: ["output:mirror"],
			},
		};
		const result = await executeStep(op, {
			sdk: t.sdk,
			ids: new Map([
				["encoding:first", "resolved-encoding"],
				["output:origin", "output"],
				["output:mirror", "mirror"],
			]),
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 1, sleep: async () => {} },
		});
		expect(result.resourceId).toBe("created-1");
		expect(t.posts()[0]?.body).toMatchObject({
			encodingId: "resolved-encoding",
			hlsMasterPlaylistVersion: "7",
			hlsMediaPlaylistVersion: "6",
			channelsAttributeForAudio: "ALWAYS",
			targetDurationRoundingMode: "UPWARD_ROUNDING",
			outputs: [
				{ outputId: "output", outputPath: "test/" },
				{ outputId: "mirror", outputPath: "test/" },
			],
		});
		const copied = curlForStep({
			...op,
			status: "DONE",
			request: result.request,
		});
		if (!copied.ok) throw new Error(copied.code);
		const jsonBody = copied.command.match(/--data '([\s\S]*)'$/)?.[1];
		const body = t.posts()[0]?.body;
		if (!jsonBody || !body)
			throw new Error("missing copied or actual wire body");
		const { customData: _owner, ...wire } = body;
		expect(JSON.parse(jsonBody)).toEqual(wire);
	});
});
