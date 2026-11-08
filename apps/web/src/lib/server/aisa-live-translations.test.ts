import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	enabled: vi.fn(),
	context: vi.fn(),
	accountClient: vi.fn(),
	audit: vi.fn(),
	get: vi.fn(),
	latest: vi.fn(),
	config: vi.fn(),
	probe: vi.fn(),
	translate: vi.fn(),
}));
vi.mock("./context", () => ({ getServerContext: mocks.context }));
vi.mock("./audit", () => ({ writeAuditLog: mocks.audit }));
vi.mock("./aisa-live-sdk", () => ({
	aisaLivePreviewEnabled: mocks.enabled,
	aisaLiveClientForAccount: mocks.accountClient,
	AisaLiveError: class extends Error {
		constructor(
			readonly httpStatusCode: number,
			readonly code?: string,
		) {
			super("private upstream error");
		}
	},
}));
vi.mock("./aisa-live-translations-engine", async (importOriginal) => ({
	...(await importOriginal<typeof import("./aisa-live-translations-engine")>()),
	readAisaTranslationEngineConfig: mocks.config,
	probeAisaTranslationEngine: mocks.probe,
	translateAisaObservations: mocks.translate,
}));

import {
	aisaTranslationsGet,
	aisaTranslationsPost,
} from "./aisa-live-translations";

const ownerId = "11111111-1111-4111-8111-111111111111";
const owner = {
	actorUserId: ownerId,
	effectiveUserId: ownerId,
	actor: `user:${ownerId}`,
	role: "ADMIN",
	actorRole: "ADMIN",
	isImpersonating: false,
};

const accountId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const analysisId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const encodingId = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const organizationId = "dddddddd-dddd-4ddd-addd-dddddddddddd";
const source = {
	id: "observation-1",
	text: "The player scores a goal.",
	startTimeSeconds: 0,
	endTimeSeconds: 10,
};
const snapshot = {
	analysisId,
	encodingId,
	sequence: 1,
	producedAt: "2026-11-07T00:00:00.000Z",
	mediaTimeOriginUnixMs: 1794009600000,
	isFinal: true,
	analyzedStartTimeSeconds: 0,
	analyzedEndTimeSeconds: 10,
	metadata: { version: "synthetic", disclaimer: "Synthetic fixture" },
	observations: [source],
	keyMoments: [],
	sourceGaps: [],
};
const request = (body?: unknown) =>
	new Request(
		`http://test/api/live/analyses/${analysisId}/translations?bitmovinAccountId=${accountId}`,
		body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
	);
const automatic = {
	bitmovinAccountId: accountId,
	encodingId,
	action: "translate",
	observationIds: [source.id],
};
const manual = {
	bitmovinAccountId: accountId,
	encodingId,
	action: "save",
	translations: [
		{
			observationId: source.id,
			sourceText: source.text,
			sourceTextHash: createHash("sha256").update(source.text).digest("hex"),
			text: "選手が得点します。",
		},
	],
};
let rows: Map<string, unknown>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW_USER_ID", ownerId);
	rows = new Map();
	const prisma = {
		appSetting: {
			findMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) =>
				where.key.in
					.filter((key) => rows.has(key))
					.map((key) => ({ key, value: rows.get(key) })),
			),
			upsert: vi.fn(
				async ({
					where,
					create,
				}: {
					where: { key: string };
					create: { value: unknown };
				}) => {
					rows.set(where.key, create.value);
					return create;
				},
			),
		},
		$transaction: async <T>(action: (client: unknown) => Promise<T>) =>
			action(prisma),
	};
	mocks.enabled.mockReturnValue(true);
	mocks.context.mockResolvedValue({
		prisma,
		tenant: { ...owner, organizationId },
	});
	mocks.accountClient.mockResolvedValue({
		get: mocks.get,
		latest: mocks.latest,
	});
	mocks.get.mockResolvedValue({ analysisId, encodingId, status: "FINISHED" });
	mocks.latest.mockResolvedValue(snapshot);
	mocks.config.mockReturnValue({
		baseUrl: "http://127.0.0.1:11445/v1",
		model: "installed-qwen",
	});
	mocks.probe.mockResolvedValue(true);
	mocks.translate.mockResolvedValue([
		{ id: source.id, text: "選手がゴールを決めます。" },
	]);
});

afterEach(() => vi.unstubAllEnvs());

describe("AISA translation persistence and routes", () => {
	it("denies unproven access before provider reads, stored translations, or model work", async () => {
		mocks.context.mockResolvedValue({
			tenant: { ...owner, effectiveUserId: undefined },
		});
		for (const response of await Promise.all([
			aisaTranslationsGet(request(), analysisId),
			aisaTranslationsPost(request(manual), analysisId),
			aisaTranslationsPost(request(automatic), analysisId),
		])) {
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({ error: "Not found" });
			expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		}
		expect(mocks.accountClient).not.toHaveBeenCalled();
		expect(mocks.config).not.toHaveBeenCalled();
		expect(mocks.probe).not.toHaveBeenCalled();
		expect(mocks.translate).not.toHaveBeenCalled();
		expect(rows.size).toBe(0);
	});

	it("hides disabled endpoints and rejects unknown accounts before touching stored translations", async () => {
		mocks.enabled.mockReturnValue(false);
		expect((await aisaTranslationsGet(request(), analysisId)).status).toBe(404);
		expect(mocks.context).not.toHaveBeenCalled();
		mocks.enabled.mockReturnValue(true);
		mocks.accountClient.mockResolvedValue(null);
		expect((await aisaTranslationsGet(request(), analysisId)).status).toBe(404);
		expect(mocks.latest).not.toHaveBeenCalled();
	});
	it("generates once, preserves the source, and reuses it through later sequences", async () => {
		const response = await aisaTranslationsPost(request(automatic), analysisId);
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.translations[0]).toMatchObject({
			origin: "LOCAL_MODEL",
			sourceText: source.text,
			text: "選手がゴールを決めます。",
			model: "installed-qwen",
		});
		expect(snapshot.observations[0]?.text).toBe(source.text);
		mocks.latest.mockResolvedValue({ ...snapshot, sequence: 3 });
		expect(
			(await aisaTranslationsPost(request(automatic), analysisId)).status,
		).toBe(200);
		expect(mocks.translate).toHaveBeenCalledTimes(1);
		expect(
			(await aisaTranslationsGet(request(), analysisId)).headers.get(
				"Cache-Control",
			),
		).toBe("private, no-store");
	});
	it("manual entries are honestly labeled and never overwritten by automatic generation", async () => {
		expect(
			(await aisaTranslationsPost(request(manual), analysisId)).status,
		).toBe(200);
		const result = await aisaTranslationsPost(request(automatic), analysisId);
		expect((await result.json()).translations[0]).toMatchObject({
			origin: "MANUAL",
			provider: "OPERATOR",
			model: null,
			text: "選手が得点します。",
		});
		expect(mocks.translate).not.toHaveBeenCalled();
	});
	it("keeps an operator correction saved while local inference was running", async () => {
		mocks.translate.mockImplementationOnce(async () => {
			expect(
				(await aisaTranslationsPost(request(manual), analysisId)).status,
			).toBe(200);
			return [{ id: source.id, text: "モデルの別の訳文です。" }];
		});
		const response = await aisaTranslationsPost(request(automatic), analysisId);
		expect((await response.json()).translations[0]).toMatchObject({
			origin: "MANUAL",
			text: "選手が得点します。",
		});
	});
	it("invalidates generated cache entries when the configured model changes", async () => {
		await aisaTranslationsPost(request(automatic), analysisId);
		mocks.config.mockReturnValue({
			baseUrl: "http://127.0.0.1:11445/v1",
			model: "another-installed-model",
		});
		expect(
			(await (await aisaTranslationsGet(request(), analysisId)).json())
				.translations,
		).toEqual([]);
		const next = await aisaTranslationsPost(request(automatic), analysisId);
		expect((await next.json()).translations[0].model).toBe(
			"another-installed-model",
		);
		expect(mocks.translate).toHaveBeenCalledTimes(2);
	});
	it("rejects stale manual source hashes and excludes stale, withdrawn, foreign-account translations", async () => {
		expect(
			(
				await aisaTranslationsPost(
					request({
						...manual,
						translations: [
							{ ...manual.translations[0], sourceTextHash: "0".repeat(64) },
						],
					}),
					analysisId,
				)
			).status,
		).toBe(409);
		expect(rows.size).toBe(0);
		await aisaTranslationsPost(request(manual), analysisId);
		mocks.latest.mockResolvedValue({
			...snapshot,
			observations: [{ ...source, text: "The source changed." }],
		});
		expect(
			(await (await aisaTranslationsGet(request(), analysisId)).json())
				.translations,
		).toEqual([]);
		mocks.latest.mockResolvedValue({ ...snapshot, observations: [] });
		expect(
			(await (await aisaTranslationsGet(request(), analysisId)).json())
				.translations,
		).toEqual([]);
		mocks.latest.mockResolvedValue(snapshot);
		const other = new Request(
			`http://test?bitmovinAccountId=${organizationId}`,
		);
		expect(
			(await (await aisaTranslationsGet(other, analysisId)).json())
				.translations,
		).toEqual([]);
	});
	it("rechecks source identity after inference before persisting any translation", async () => {
		mocks.translate.mockImplementationOnce(async () => {
			mocks.latest.mockResolvedValue({ ...snapshot, observations: [] });
			return [{ id: source.id, text: "選手が得点します。" }];
		});
		expect(
			(await aisaTranslationsPost(request(automatic), analysisId)).status,
		).toBe(409);
		expect(rows.size).toBe(0);
	});
	it("coalesces duplicate in-flight requests and rejects different concurrent inference", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		mocks.translate.mockImplementationOnce(async () => {
			await gate;
			return [{ id: source.id, text: "ゴールを決めます。" }];
		});
		const first = aisaTranslationsPost(request(automatic), analysisId);
		await vi.waitFor(() => expect(mocks.translate).toHaveBeenCalledTimes(1));
		const second = aisaTranslationsPost(request(automatic), analysisId);
		const foreign = aisaTranslationsPost(
			request({ ...automatic, bitmovinAccountId: organizationId }),
			analysisId,
		);
		expect((await foreign).status).toBe(429);
		release();
		expect((await first).status).toBe(200);
		expect((await second).status).toBe(200);
		expect(mocks.translate).toHaveBeenCalledTimes(1);
	});
	it("has no pretend automatic fallback when a local engine is not configured", async () => {
		mocks.config.mockReturnValue(undefined);
		expect(
			(await aisaTranslationsPost(request(automatic), analysisId)).status,
		).toBe(503);
		expect(mocks.translate).not.toHaveBeenCalled();
		expect(rows.size).toBe(0);
	});
	it("sanitizes unexpected provider failures without persisting incomplete translations", async () => {
		mocks.translate.mockRejectedValueOnce(new Error("private-token=SECRET"));
		const response = await aisaTranslationsPost(request(automatic), analysisId);
		expect(response.status).toBe(500);
		expect(JSON.stringify(await response.json())).not.toContain("SECRET");
		expect(rows.size).toBe(0);
	});
});
