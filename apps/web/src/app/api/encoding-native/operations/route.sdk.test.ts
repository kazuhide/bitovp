import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
	getAccount: vi.fn(),
	reveal: vi.fn(),
	audit: vi.fn(),
	getReceipt: vi.fn(),
	claim: vi.fn(),
	budget: vi.fn(),
	settle: vi.fn(),
	list: vi.fn(),
	owns: vi.fn(),
	fetch: vi.fn(),
	role: "ADMIN",
	impersonating: false,
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: async () => ({
		tenant: {
			role: mocks.role,
			isImpersonating: mocks.impersonating,
			actor: "token",
		},
		prisma: {},
		bitmovinAccounts: {
			get: mocks.getAccount,
			revealForEncoding: mocks.reveal,
		},
	}),
}));
vi.mock("@/lib/server/audit", () => ({ writeAuditLog: mocks.audit }));
vi.mock(import("@/lib/server/native-account-journal"), async (original) => ({
	...(await original()),
	getNativeOperation: mocks.getReceipt,
	claimNativeOperation: mocks.claim,
	nativeOperationDispatchBudget: mocks.budget,
	settleNativeOperation: mocks.settle,
	listNativeOperations: mocks.list,
	ownsNativeResource: mocks.owns,
}));

const accountId = "00000000-0000-4000-8000-000000000001";
const scopeVersion = "00000000-0000-4000-8000-000000000002";
const operationId = "00000000-0000-4000-8000-000000000003";
const providerId = "00000000-0000-4000-8000-000000000004";
const inputId = "00000000-0000-4000-8000-000000000005";
const outputId = "00000000-0000-4000-8000-000000000006";
const tenantOrgId = "00000000-0000-4000-8000-000000000007";
const providerKey = "PROVIDER_ACCOUNT_KEY";
const secret = "DO_NOT_STORE_USERNAME_PASSWORD_OR_SIGNED_URL";
const uploadUrl = `https://upload.example.test/object?signature=${secret}`;
const name = "Studio fixture";
const host = "files.example.test";
const target = { resourceId: providerId, confirmId: providerId };
const template = {
	name,
	inputId,
	inputPath: "incoming/source.mp4",
	outputId,
	outputPath: "review",
};
const watch = { ...template, inputPath: "incoming" };
const base = "https://app.example.test/api/encoding-native/operations";
const success = (result: object) =>
	Response.json({ status: "SUCCESS", data: { result } });
function latch() {
	let release = () => {};
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { wait, release };
}
const request = (action: string, body: object = {}, id = operationId) =>
	new Request(base, {
		method: "POST",
		headers: { "Content-Type": "application/json", "Idempotency-Key": id },
		body: JSON.stringify({
			bitmovinAccountId: accountId,
			scopeVersion,
			action,
			...body,
		}),
	});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.role = "ADMIN";
	mocks.impersonating = false;
	mocks.getAccount.mockResolvedValue({ resourceScopeVersion: scopeVersion });
	mocks.reveal.mockResolvedValue({
		apiKey: providerKey,
		tenantOrgId,
		resourceScopeVersion: scopeVersion,
	});
	mocks.getReceipt.mockResolvedValue(null);
	mocks.budget.mockResolvedValue(60_000);
	mocks.claim.mockImplementation(async (_db, row) => ({
		row: {
			...row,
			state: "PENDING",
			createdAt: new Date(),
			providerId: null,
			passed: null,
		},
		send: true,
	}));
	mocks.settle.mockImplementation(async (_db, row, result) => ({
		...row,
		...result,
	}));
	mocks.list.mockResolvedValue([]);
	mocks.owns.mockResolvedValue(true);
	vi.stubGlobal("fetch", mocks.fetch);
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 9).toString("base64"));
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

type Effect = {
	action: string;
	verb: "POST" | "DELETE";
	path: string;
	request: object;
	body?: object;
	type?: string;
	preflights?: string[];
	wire?: object;
	result?: object;
};

async function effect(spec: Effect) {
	const preflights = spec.preflights ?? [];
	const requests: string[] = [];
	mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
		const headers = new Headers(init.headers);
		expect(headers.get("X-Api-Key")).toBe(providerKey);
		expect(headers.get("X-Tenant-Org-Id")).toBe(tenantOrgId);
		const path = new URL(url).pathname;
		requests.push(`${init.method} ${path}`);
		if (init.method === "GET") {
			expect(path).toBe(`/v1${preflights[requests.length - 1]}`);
			expect(mocks.claim).toHaveBeenCalledTimes(1);
			if (path.includes(inputId)) return success({ id: inputId, type: "S3" });
			if (path.includes(outputId)) return success({ id: outputId, type: "S3" });
			return success({
				id: providerId,
				type: spec.type,
				status: spec.action === "stop-watch-folder" ? "STARTED" : "STOPPED",
			});
		}
		expect(mocks.claim).toHaveBeenCalledTimes(1);
		expect(init.method).toBe(spec.verb);
		expect(path).toBe(`/v1${spec.path}`);
		if (spec.body) {
			const body = JSON.parse(String(init.body));
			expect(body).toMatchObject(spec.body);
			if (
				spec.action === "create-template" ||
				spec.action === "start-template"
			) {
				expect(Object.keys(body)).toEqual([
					"metadata",
					"configurations",
					"encodings",
				]);
				expect(body.configurations).toMatchObject({
					video: {
						h264: {
							video: {
								properties: {
									profile: "MAIN",
									height: 720,
									bitrate: 2_000_000,
								},
							},
						},
					},
					audio: {
						aac: { audio: { properties: { rate: 48_000, bitrate: 128_000 } } },
					},
				});
				expect(Object.keys(body.encodings.mp4)).toEqual([
					"properties",
					"streams",
					"muxings",
					"start",
				]);
				expect(
					body.encodings.mp4.streams.video.properties.inputStreams,
				).toEqual([
					{
						inputId,
						inputPath: template.inputPath,
						selectionMode: "VIDEO_RELATIVE",
						position: 0,
					},
				]);
				expect(
					body.encodings.mp4.streams.audio.properties.inputStreams,
				).toEqual([
					{
						inputId,
						inputPath: template.inputPath,
						selectionMode: "AUDIO_RELATIVE",
						position: 0,
					},
				]);
				expect(body.encodings.mp4.muxings.mp4.video.properties).toMatchObject({
					filename: "video.mp4",
					outputs: [
						{
							outputId,
							outputPath:
								spec.action === "start-template"
									? `${template.outputPath}/${operationId}/`
									: template.outputPath,
							acl: [{ permission: "PRIVATE" }],
						},
					],
				});
				expect(body.encodings.mp4.start.properties).toEqual({
					encodingMode: "SINGLE_PASS",
				});
			}
		} else {
			expect(init.body).toBeUndefined();
		}
		return success({
			id: providerId,
			type: spec.type,
			credentials: secret,
			...spec.wire,
		});
	});
	const response = await POST(request(spec.action, spec.request));
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	const result = await response.json();
	expect(result).toMatchObject({
		id: operationId,
		state: "ACCEPTED",
		providerId,
		...spec.result,
	});
	const { uploadUrl: ephemeral, ...retained } = result;
	expect(ephemeral).toBe(
		spec.action === "create-direct-upload" ? uploadUrl : undefined,
	);
	expect(JSON.stringify(retained)).not.toMatch(
		new RegExp(`${secret}|${providerKey}`),
	);
	expect(requests).toEqual([
		...preflights.map((p) => `GET /v1${p}`),
		`${spec.verb} /v1${spec.path}`,
	]);
	expect(mocks.reveal).toHaveBeenCalledWith(accountId);
	for (const spy of [mocks.claim, mocks.settle, mocks.audit]) {
		expect(spy).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(spy.mock.calls)).not.toMatch(
			new RegExp(`${secret}|${providerKey}`),
		);
	}
}

it("dispatches inputs.aspera.create", async () => {
	await effect({
		action: "create-aspera-input",
		verb: "POST",
		path: `/encoding/inputs/aspera`,
		request: { name, host, token: secret },
		body: { name, host, token: secret },
		type: "ASPERA",
	});
});

it("dispatches inputs.aspera.delete", async () => {
	await effect({
		action: "delete-aspera-input",
		verb: "DELETE",
		path: `/encoding/inputs/aspera/${providerId}`,
		request: target,
		type: "ASPERA",
		preflights: [`/encoding/inputs/aspera/${providerId}`],
	});
});

it("dispatches inputs.directFileUpload.create", async () => {
	await effect({
		action: "create-direct-upload",
		verb: "POST",
		path: `/encoding/inputs/direct-file-upload`,
		request: { name },
		body: { name },
		type: "DIRECT_FILE_UPLOAD",
		wire: { uploadUrl },
		result: { uploadUrl },
	});
});

it("dispatches inputs.directFileUpload.delete", async () => {
	await effect({
		action: "delete-direct-upload",
		verb: "DELETE",
		path: `/encoding/inputs/direct-file-upload/${providerId}`,
		request: target,
		type: "DIRECT_FILE_UPLOAD",
		preflights: [`/encoding/inputs/direct-file-upload/${providerId}`],
	});
});

it("dispatches inputs.ftp.create", async () => {
	await effect({
		action: "create-ftp-input",
		verb: "POST",
		path: `/encoding/inputs/ftp`,
		request: { name, host, username: "studio", password: secret },
		body: { name, host, username: "studio", password: secret },
		type: "FTP",
	});
});

it("dispatches inputs.ftp.delete", async () => {
	await effect({
		action: "delete-ftp-input",
		verb: "DELETE",
		path: `/encoding/inputs/ftp/${providerId}`,
		request: target,
		type: "FTP",
		preflights: [`/encoding/inputs/ftp/${providerId}`],
	});
});

it("dispatches inputs.http.create", async () => {
	await effect({
		action: "create-http-input",
		verb: "POST",
		path: `/encoding/inputs/http`,
		request: { name, host, port: 8080 },
		body: { name, host, port: 8080 },
		type: "HTTP",
	});
});

it("dispatches inputs.http.delete", async () => {
	await effect({
		action: "delete-http-input",
		verb: "DELETE",
		path: `/encoding/inputs/http/${providerId}`,
		request: target,
		type: "HTTP",
		preflights: [`/encoding/inputs/http/${providerId}`],
	});
});

it("dispatches inputs.local.create", async () => {
	await effect({
		action: "create-local-input",
		verb: "POST",
		path: `/encoding/inputs/local`,
		request: { name, path: "/mnt/ingest" },
		body: { name, path: "/mnt/ingest" },
		type: "LOCAL",
	});
});

it("dispatches inputs.local.delete", async () => {
	await effect({
		action: "delete-local-input",
		verb: "DELETE",
		path: `/encoding/inputs/local/${providerId}`,
		request: target,
		type: "LOCAL",
		preflights: [`/encoding/inputs/local/${providerId}`],
	});
});

it("dispatches inputs.sftp.create", async () => {
	await effect({
		action: "create-sftp-input",
		verb: "POST",
		path: `/encoding/inputs/sftp`,
		request: { name, host, port: 22, username: "studio", password: secret },
		body: { name, host, port: 22, username: "studio", password: secret },
		type: "SFTP",
	});
});

it("dispatches inputs.sftp.delete", async () => {
	await effect({
		action: "delete-sftp-input",
		verb: "DELETE",
		path: `/encoding/inputs/sftp/${providerId}`,
		request: target,
		type: "SFTP",
		preflights: [`/encoding/inputs/sftp/${providerId}`],
	});
});

it("dispatches outputs.ftp.create", async () => {
	await effect({
		action: "create-ftp-output",
		verb: "POST",
		path: `/encoding/outputs/ftp`,
		request: { name, host, username: "studio", password: secret },
		body: { name, host, username: "studio", password: secret },
		type: "FTP",
	});
});

it("dispatches outputs.ftp.delete", async () => {
	await effect({
		action: "delete-ftp-output",
		verb: "DELETE",
		path: `/encoding/outputs/ftp/${providerId}`,
		request: target,
		type: "FTP",
		preflights: [`/encoding/outputs/ftp/${providerId}`],
	});
});

it("dispatches outputs.local.create", async () => {
	await effect({
		action: "create-local-output",
		verb: "POST",
		path: `/encoding/outputs/local`,
		request: { name, path: "/mnt/output" },
		body: { name, path: "/mnt/output" },
		type: "LOCAL",
	});
});

it("dispatches outputs.local.delete", async () => {
	await effect({
		action: "delete-local-output",
		verb: "DELETE",
		path: `/encoding/outputs/local/${providerId}`,
		request: target,
		type: "LOCAL",
		preflights: [`/encoding/outputs/local/${providerId}`],
	});
});

it("dispatches filters.azureSpeechToCaptions.create", async () => {
	await effect({
		action: "create-azure-captions",
		verb: "POST",
		path: `/encoding/filters/azure-speech-to-captions`,
		request: {
			name,
			region: "japaneast",
			language: "ja-JP",
			subscriptionKey: secret,
		},
		body: {
			name,
			azureSpeechToCaptionsSettings: {
				region: "japaneast",
				language: "ja-JP",
				azureSpeechServicesCredentials: { subscriptionKey: secret },
			},
		},
		type: "AZURE_SPEECH_TO_CAPTIONS",
	});
});

it("dispatches filters.azureSpeechToCaptions.delete", async () => {
	await effect({
		action: "delete-azure-captions",
		verb: "DELETE",
		path: `/encoding/filters/azure-speech-to-captions/${providerId}`,
		request: target,
		type: "AZURE_SPEECH_TO_CAPTIONS",
		preflights: [`/encoding/filters/azure-speech-to-captions/${providerId}`],
	});
});

it("dispatches templates.create", async () => {
	await effect({
		action: "create-template",
		verb: "POST",
		path: `/encoding/templates`,
		request: template,
		body: { metadata: { name, type: "VOD" } },
		type: "VOD",
		preflights: [
			`/encoding/inputs/${inputId}`,
			`/encoding/outputs/${outputId}`,
		],
	});
});

it("dispatches templates.delete", async () => {
	await effect({
		action: "delete-template",
		verb: "DELETE",
		path: `/encoding/templates/${providerId}`,
		request: target,
		type: "VOD",
		preflights: [`/encoding/templates/${providerId}`],
	});
});

it("dispatches watchFolders.create", async () => {
	await effect({
		action: "create-watch-folder",
		verb: "POST",
		path: `/encoding/watch-folders`,
		request: watch,
		body: {
			name,
			input: { inputId, inputPath: watch.inputPath },
			outputs: [{ outputId, outputPath: watch.outputPath }],
		},
		preflights: [
			`/encoding/inputs/${inputId}`,
			`/encoding/outputs/${outputId}`,
		],
	});
});

it("dispatches watchFolders.delete", async () => {
	await effect({
		action: "delete-watch-folder",
		verb: "DELETE",
		path: `/encoding/watch-folders/${providerId}`,
		request: target,
		preflights: [`/encoding/watch-folders/${providerId}`],
	});
});

it("dispatches outputs.checkPermissions", async () => {
	await effect({
		action: "check-s3-output",
		verb: "POST",
		path: `/encoding/outputs/${providerId}/check-permissions`,
		request: { ...target, path: "check", acceptWrite: true },
		body: { path: `check/.bitovp-permissions-${operationId}/` },
		preflights: [`/encoding/outputs/s3/${providerId}`],
		type: "S3",
		wire: {
			outputId: providerId,
			outputType: "S3",
			path: `check/.bitovp-permissions-${operationId}/`,
			passed: false,
			failureReason: secret,
		},
		result: { passed: false },
	});
});

it("dispatches templates.start", async () => {
	await effect({
		action: "start-template",
		verb: "POST",
		path: `/encoding/templates/start`,
		request: { ...template, confirmId: outputId, acceptCharges: true },
		body: { metadata: { type: "VOD", name } },
		preflights: [
			`/encoding/inputs/${inputId}`,
			`/encoding/outputs/${outputId}`,
		],
		wire: { encodingId: providerId },
	});
});

it("dispatches watchFolders.start", async () => {
	await effect({
		action: "start-watch-folder",
		verb: "POST",
		path: `/encoding/watch-folders/${providerId}/start`,
		request: { ...target, acceptCharges: true },
		preflights: [`/encoding/watch-folders/${providerId}`],
	});
});

it("dispatches watchFolders.stop", async () => {
	await effect({
		action: "stop-watch-folder",
		verb: "POST",
		path: `/encoding/watch-folders/${providerId}/stop`,
		request: target,
		preflights: [`/encoding/watch-folders/${providerId}`],
	});
});

it("requires a matching resource, scope, and explicit consent before a provider effect", async () => {
	for (const req of [
		request("start-template", { ...template, confirmId: outputId }),
		request("start-template", {
			...template,
			confirmId: inputId,
			acceptCharges: true,
		}),
		request("start-template", {
			...template,
			confirmId: outputId,
			acceptCharges: true,
			rawYaml: "!!x",
		}),
		request("start-watch-folder", target),
		request("check-s3-output", { ...target, path: "../unsafe" }),
		request("delete-ftp-input", { ...target, confirmId: inputId }),
		request("create-local-input", { name, path: "/" }),
	])
		expect((await POST(req)).status).toBe(400);
	expect(mocks.fetch).not.toHaveBeenCalled();
	mocks.reveal.mockResolvedValue({
		apiKey: providerKey,
		tenantOrgId,
		resourceScopeVersion: inputId,
	});
	expect((await POST(request("delete-ftp-input", target))).status).toBe(409);
	mocks.reveal.mockResolvedValue({
		apiKey: providerKey,
		tenantOrgId: "  ",
		resourceScopeVersion: scopeVersion,
	});
	expect(
		(await POST(request("create-http-input", { name, host }))).status,
	).toBe(409);
	expect(mocks.claim).not.toHaveBeenCalled();
	expect(mocks.fetch).not.toHaveBeenCalled();
});

it("rejects read-only sessions and deletion of resources without an owned creation receipt", async () => {
	mocks.role = "OPERATOR";
	expect(
		(await POST(request("create-http-input", { name, host }))).status,
	).toBe(403);
	mocks.role = "ADMIN";
	mocks.impersonating = true;
	expect(
		(await POST(request("create-http-input", { name, host }))).status,
	).toBe(403);
	mocks.impersonating = false;
	mocks.owns.mockResolvedValue(false);
	expect((await POST(request("delete-ftp-input", target))).status).toBe(404);
	expect(mocks.claim).not.toHaveBeenCalled();
	expect(mocks.fetch).not.toHaveBeenCalled();
});

it("rejects an exact target match when the raw resource type is wrong", async () => {
	mocks.fetch.mockImplementation(async () =>
		success({ id: providerId, type: "HTTP" }),
	);
	expect((await POST(request("delete-ftp-input", target))).status).toBe(404);
	expect(mocks.fetch).toHaveBeenCalledTimes(1);
	expect(mocks.claim).toHaveBeenCalledTimes(1);
	expect(mocks.settle).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ id: operationId }),
		{ state: "REJECTED" },
	);
});

it("keeps a lost effect response unresolved and never sends it again under the same key", async () => {
	mocks.fetch.mockRejectedValue(new Error(secret));
	const command = { name, host };
	const failed = await POST(request("create-http-input", command));
	expect(failed.status).toBe(202);
	const response = await failed.json();
	expect(response.state).toBe("UNKNOWN");
	expect(JSON.stringify(response)).not.toContain(secret);
	const previous = {
		...mocks.claim.mock.calls[0]?.[1],
		state: "UNKNOWN",
		createdAt: new Date(),
	};
	mocks.getReceipt.mockResolvedValue(previous);
	expect((await POST(request("create-http-input", command))).status).toBe(202);
	expect(
		(
			await POST(
				request("create-http-input", {
					...command,
					host: "other.example.test",
				}),
			)
		).status,
	).toBe(409);
	expect(mocks.fetch).toHaveBeenCalledTimes(1);
	expect(mocks.claim).toHaveBeenCalledTimes(1);
});

it("reads receipts without revealing credentials and provides the current scope", async () => {
	const response = await GET(
		new Request(`${base}?bitmovinAccountId=${accountId}`),
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ scopeVersion, rows: [] });
	expect(mocks.reveal).not.toHaveBeenCalled();
	expect(mocks.fetch).not.toHaveBeenCalled();
});

it("uses the default organization only for a stored null scope", async () => {
	mocks.reveal.mockResolvedValueOnce({
		apiKey: providerKey,
		tenantOrgId: null,
		resourceScopeVersion: scopeVersion,
	});
	mocks.fetch.mockImplementationOnce(
		async (_url: string, init: RequestInit) => {
			expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBeNull();
			return success({ id: providerId, type: "HTTP" });
		},
	);
	expect(
		(await POST(request("create-http-input", { name, host }))).status,
	).toBe(200);
	expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it("does not report acceptance when a watch-folder response identifies a different folder", async () => {
	mocks.fetch
		.mockResolvedValueOnce(success({ id: providerId, status: "STOPPED" }))
		.mockResolvedValueOnce(success({ id: inputId, credentials: secret }));
	const response = await POST(
		request("start-watch-folder", { ...target, acceptCharges: true }),
	);
	expect(response.status).toBe(202);
	const result = await response.json();
	expect(result).toMatchObject({ state: "UNKNOWN", providerId: null });
	expect(JSON.stringify(result)).not.toContain(secret);
});

it("replays a receipt after an explicit tenant's Bitmovin credential rotates", async () => {
	const command = { name, host };
	mocks.fetch.mockResolvedValueOnce(success({ id: providerId, type: "HTTP" }));
	const initial = await POST(request("create-http-input", command));
	expect(initial.status).toBe(200);
	const accepted = await initial.json();
	mocks.getReceipt.mockResolvedValue({
		...mocks.claim.mock.calls[0]?.[1],
		...accepted,
		createdAt: new Date(accepted.createdAt),
	});
	mocks.reveal.mockResolvedValue({
		apiKey: "rotated-fixture",
		tenantOrgId,
		resourceScopeVersion: scopeVersion,
	});
	const replay = await POST(request("create-http-input", command));
	expect(replay.status).toBe(200);
	expect(await replay.json()).toEqual(accepted);
	expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it("returns the winner's durable receipt to a same-key delete before the loser reads Bitmovin", async () => {
	const reading = latch();
	const continueRead = latch();
	let receipt: object | undefined;
	mocks.claim.mockImplementation(async (_db, proposal) => {
		if (receipt) return { row: receipt, send: false };
		receipt = {
			...proposal,
			state: "PENDING",
			createdAt: new Date(),
			providerId: null,
			passed: null,
		};
		return { row: receipt, send: true };
	});
	mocks.fetch
		.mockImplementationOnce(async () => {
			reading.release();
			await continueRead.wait;
			return success({ id: providerId, type: "FTP" });
		})
		.mockImplementationOnce(async (_url: string, init: RequestInit) =>
			init.method === "DELETE"
				? success({ id: providerId, type: "FTP" })
				: Response.json(
						{ status: "ERROR", data: { code: 1001, message: "Missing" } },
						{ status: 404 },
					),
		);
	const winner = POST(request("delete-ftp-input", target));
	await reading.wait;
	try {
		const loser = await POST(request("delete-ftp-input", target));
		expect(loser.status).toBe(202);
		expect(await loser.json()).toMatchObject({
			id: operationId,
			state: "PENDING",
		});
	} finally {
		continueRead.release();
		await winner;
	}
	expect(await (await winner).json()).toMatchObject({
		id: operationId,
		state: "ACCEPTED",
	});
	expect(mocks.fetch.mock.calls.map(([, init]) => init.method)).toEqual([
		"GET",
		"DELETE",
	]);
});

it("checks watch-folder state only after acquiring its target reservation", async () => {
	mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) =>
		init.method === "GET"
			? success({
					id: providerId,
					status: mocks.claim.mock.calls.length ? "STARTED" : "STOPPED",
				})
			: success({ id: providerId }),
	);
	const response = await POST(request("delete-watch-folder", target));
	expect(response.status).toBe(409);
	expect(mocks.fetch.mock.calls.map(([, init]) => init.method)).toEqual([
		"GET",
	]);
	expect(mocks.settle).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ id: operationId }),
		{ state: "REJECTED" },
	);
});

it("rejects contradictory Live evidence when deleting a stored VOD template", async () => {
	mocks.fetch.mockResolvedValueOnce(success({ id: providerId, type: "LIVE" }));
	const response = await POST(request("delete-template", target));
	expect(response.status).toBe(404);
	expect(mocks.fetch.mock.calls.map(([, init]) => init.method)).toEqual([
		"GET",
	]);
});

it("cannot dispatch a receipt that expired before the request resumed", async () => {
	mocks.claim.mockImplementationOnce(async (_db, proposal) => ({
		row: {
			...proposal,
			state: "PENDING",
			createdAt: new Date(Date.now() - 61_000),
			providerId: null,
			passed: null,
		},
		send: true,
	}));
	mocks.fetch.mockResolvedValueOnce(success({ id: providerId, type: "HTTP" }));
	const response = await POST(request("create-http-input", { name, host }));
	expect(response.status).toBe(202);
	expect(await response.json()).toMatchObject({
		id: operationId,
		state: "UNKNOWN",
	});
	expect(mocks.fetch).not.toHaveBeenCalled();
});

it("checks the dispatch deadline at SDK fetch after the durable claim check", async () => {
	mocks.budget.mockImplementationOnce(async () => {
		const beforePause = performance.now();
		vi.spyOn(performance, "now")
			.mockReturnValueOnce(beforePause)
			.mockReturnValue(beforePause + 60_000);
		return 60_000;
	});
	mocks.fetch.mockResolvedValueOnce(success({ id: providerId, type: "HTTP" }));
	const response = await POST(request("create-http-input", { name, host }));
	expect(response.status).toBe(202);
	expect(await response.json()).toMatchObject({
		id: operationId,
		state: "UNKNOWN",
	});
	expect(mocks.budget).toHaveBeenCalledOnce();
	expect(mocks.fetch).not.toHaveBeenCalled();
});
