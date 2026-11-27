import { inspect } from "node:util";
import type { AppPrismaClient } from "@bitovp/db";
import { afterEach, expect, it, vi } from "vitest";
import { auditedOperationCases } from "../../../../scripts/api-coverage-test-cases";
import { makeWorkerSdk } from "./make-sdk";
import { stopRecordedRoleManifest } from "./manifest-resume";

afterEach(() => vi.unstubAllGlobals());

const formats = ["hls", "dash", "smooth"] as const;
const manifestId = "00000000-0000-4000-8000-0000000000ab";
const probes = ["status", "customData"] as const;
const protectedProbeCases = formats.flatMap((format) =>
	probes.flatMap((probe) =>
		[200, 300, 503].map((status) => [format, probe, status] as const),
	),
);

function roleManifestSdk() {
	return makeWorkerSdk({
		auditLog: { create: vi.fn() },
	} as unknown as AppPrismaClient)({
		apiKey: "synthetic-only",
		bitmovinAccountId: "fixture-account",
		tenantOrgId: "fixture-org",
		withholdProviderDetails: true,
	});
}

it.each(
	auditedOperationCases(
		import.meta.url,
		"worker-standalone-manifest-stop",
		formats,
		(format) => [`POST /encoding/manifests/${format}/{manifest_id}/stop`],
	),
)("sends the official %s manifest stop once via the worker SDK", async (format) => {
	const audit = vi.fn(async () => {});
	const fetch = vi.fn(async (_raw: string, _init: RequestInit) => {
		throw new TypeError("synthetic lost stop reply");
	});
	vi.stubGlobal("fetch", fetch);
	const sdk = makeWorkerSdk({
		auditLog: { create: audit },
	} as unknown as AppPrismaClient)({
		apiKey: "synthetic-only",
		bitmovinAccountId: "fixture-account",
		tenantOrgId: "fixture-org",
		withholdProviderDetails: true,
	});
	await expect(sdk.stopManifest(format, manifestId)).rejects.toThrow();
	expect(fetch).toHaveBeenCalledOnce();
	const call = fetch.mock.calls[0];
	if (!call) throw new Error("Missing manifest stop request");
	const [raw, init] = call;
	const url = new URL(raw);
	expect(url.origin).toBe("https://api.bitmovin.com");
	expect(url.pathname).toBe(
		`/v1/encoding/manifests/${format}/${manifestId}/stop`,
	);
	expect(init.method).toBe("POST");
	expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe("fixture-org");
	expect(audit).toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({
				method: "POST",
				path: `/encoding/manifests/${format}/${manifestId}/stop`,
				bitmovinAccountId: "fixture-account",
			}),
		}),
	);
});

it.each(
	auditedOperationCases(
		import.meta.url,
		"worker-smooth-manifest-owner",
		["smooth"] as const,
		() => ["GET /encoding/manifests/smooth/{manifest_id}/customData"],
	),
)("reads the official %s manifest owner marker via the worker SDK", async (format) => {
	const fetch = vi.fn(async (raw: string, init: RequestInit) => {
		expect(new URL(raw).pathname).toBe(
			`/v1/encoding/manifests/${format}/${manifestId}/customData`,
		);
		expect(init.method).toBe("GET");
		expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(
			"fixture-org",
		);
		return Response.json({
			data: {
				result: {
					customData: {
						bitovp: { job: "fixture-job", step: "manifest:smooth" },
					},
				},
			},
		});
	});
	vi.stubGlobal("fetch", fetch);
	const sdk = makeWorkerSdk({
		auditLog: { create: vi.fn() },
	} as unknown as AppPrismaClient)({
		apiKey: "synthetic-only",
		bitmovinAccountId: "fixture-account",
		tenantOrgId: "fixture-org",
		withholdProviderDetails: true,
	});
	await expect(
		sdk.ownsManifest(format, manifestId, "fixture-job", "manifest:smooth"),
	).resolves.toBe(true);
	expect(fetch).toHaveBeenCalledOnce();
});

it.each(
	protectedProbeCases,
)("defers %s STOP on %s HTTP %i with null data", async (format, probe, status) => {
	const path = `/v1/encoding/manifests/${format}/${manifestId}`;
	const wire = vi.fn(async (raw: string, init: RequestInit) => {
		expect(init.method).toBe("GET");
		expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(
			"fixture-org",
		);
		const requested = new URL(raw).pathname;
		if (requested === `${path}/${probe}`)
			return Response.json({ data: null }, { status });
		expect(requested).toBe(`${path}/status`);
		return Response.json({ data: { result: { status: "RUNNING" } } });
	});
	vi.stubGlobal("fetch", wire);
	const beforeStop = vi.fn(async () => {});
	await expect(
		stopRecordedRoleManifest(
			roleManifestSdk(),
			format,
			manifestId,
			"fixture-job",
			"manifest:fixture",
			beforeStop,
		),
	).resolves.toBe("ACTIVE");
	expect(beforeStop).not.toHaveBeenCalled();
	expect(wire.mock.calls.map(([raw]) => new URL(raw).pathname)).toEqual(
		probe === "status"
			? [`${path}/status`]
			: [`${path}/status`, `${path}/customData`],
	);
});

const scopedOwner = { job: "fixture-job", step: "manifest:fixture" };
const taskResultResponse = (result: object) =>
	Response.json({ data: { result } });

it.each([
	["status", {}, "ACTIVE"],
	["status", { status: null }, "ACTIVE"],
	["status", { status: "UNRECOGNIZED_STATUS" }, "ACTIVE"],
	["status", { status: ["RUNNING"] }, "ACTIVE"],
	["customData", {}, "ACTIVE"],
	["customData", { customData: [] }, "ACTIVE"],
	[
		"customData",
		{ customData: { bitovp: { job: scopedOwner.job } } },
		"ACTIVE",
	],
	["customData", { customData: {} }, "UNVERIFIED"],
	[
		"customData",
		{ customData: { bitovp: { ...scopedOwner, step: "different-step" } } },
		"UNVERIFIED",
	],
] as const)("qualifies protected %s results %j without sending STOP", async (probe, result, outcome) => {
	const path = `/v1/encoding/manifests/hls/${manifestId}`;
	const wire = vi.fn(async (raw: string, init: RequestInit) => {
		expect(init.method).toBe("GET");
		const requested = new URL(raw).pathname;
		if (requested === `${path}/${probe}`) return taskResultResponse(result);
		expect(requested).toBe(`${path}/status`);
		return taskResultResponse({ status: "RUNNING" });
	});
	vi.stubGlobal("fetch", wire);
	const beforeStop = vi.fn(async () => {});
	await expect(
		stopRecordedRoleManifest(
			roleManifestSdk(),
			"hls",
			manifestId,
			scopedOwner.job,
			scopedOwner.step,
			beforeStop,
		),
	).resolves.toBe(outcome);
	expect(beforeStop).not.toHaveBeenCalled();
	expect(wire.mock.calls.map(([raw]) => new URL(raw).pathname)).toEqual(
		probe === "status"
			? [`${path}/status`]
			: [`${path}/status`, `${path}/customData`],
	);
});

it.each([
	200, 300,
])("keeps one acknowledged STOP pending after malformed HTTP %i status readback", async (status) => {
	const path = `/v1/encoding/manifests/smooth/${manifestId}`;
	let statusReads = 0;
	const wire = vi.fn(async (raw: string, init: RequestInit) => {
		const requested = new URL(raw).pathname;
		if (init.method === "POST") {
			expect(requested).toBe(`${path}/stop`);
			return new Response(null, { status: 202 });
		}
		expect(init.method).toBe("GET");
		if (requested === `${path}/customData`)
			return taskResultResponse({ customData: { bitovp: scopedOwner } });
		expect(requested).toBe(`${path}/status`);
		if (statusReads++ === 0) return taskResultResponse({ status: "RUNNING" });
		return Response.json({ data: null }, { status });
	});
	vi.stubGlobal("fetch", wire);
	const beforeStop = vi.fn(async () => {});
	await expect(
		stopRecordedRoleManifest(
			roleManifestSdk(),
			"smooth",
			manifestId,
			scopedOwner.job,
			scopedOwner.step,
			beforeStop,
		),
	).resolves.toBe("ACTIVE");
	expect(beforeStop).toHaveBeenCalledOnce();
	expect(wire.mock.calls.map(([raw]) => new URL(raw).pathname)).toEqual([
		`${path}/status`,
		`${path}/customData`,
		`${path}/stop`,
		`${path}/status`,
	]);
});

it.each([
	[401, () => Response.json({ data: null }, { status: 401 })],
	[
		403,
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error("private-denial-body"));
					},
				}),
				{ status: 403 },
			),
	],
] as const)("keeps HTTP %i denial fail-closed even when the body is unreadable", async (status, response) => {
	const wire = vi.fn(async () => response());
	vi.stubGlobal("fetch", wire);
	const sdk = roleManifestSdk();
	const beforeStop = vi.fn(async () => {});
	await expect(
		stopRecordedRoleManifest(
			sdk,
			"hls",
			manifestId,
			"fixture-job",
			"manifest:fixture",
			beforeStop,
		),
	).resolves.toBe("UNVERIFIED");
	expect(beforeStop).not.toHaveBeenCalled();
	expect(wire).toHaveBeenCalledOnce();
	await expect(sdk.getHlsManifestStatus(manifestId)).rejects.toMatchObject({
		httpStatusCode: status,
	});
});

it.each(
	probes,
)("projects only safe status and code on protected %s failures", async (probe) => {
	const wire = vi.fn(async (_raw: string, _init: RequestInit) =>
		Response.json(
			{
				requestId: "private-request",
				data: {
					code: 2104,
					message: "private-message",
					developerMessage: "private-developer-message",
					details: [null],
				},
			},
			{ status: 503 },
		),
	);
	vi.stubGlobal("fetch", wire);
	const sdk = roleManifestSdk();
	const result =
		probe === "status"
			? sdk.getHlsManifestStatus(manifestId)
			: sdk.ownsManifest("hls", manifestId, "fixture-job", "manifest:fixture");
	const error = await result.catch((error: unknown) => error);
	expect(error).toMatchObject({ httpStatusCode: 503, errorCode: 2104 });
	expect(inspect(error, { depth: null })).not.toContain("private-");
	expect(wire).toHaveBeenCalledOnce();
});
