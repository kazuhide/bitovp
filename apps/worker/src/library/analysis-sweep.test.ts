import { matchesWhere, projectSelect } from "@bitovp/core/testing";
import type { AppPrismaClient } from "@bitovp/db";
import { UnsupportedBrowseError } from "@bitovp/storage";
import { describe, expect, it, vi } from "vitest";
import {
	ANALYSIS_MAX_ATTEMPTS,
	createAnalysisProvider,
	createAnalysisSweep,
} from "./analysis-sweep";

const instant = new Date("2026-09-14T00:00:00Z");
const raw = {
	metadata: { version: "1.0" },
	duration: 2.5,
	scenes: [],
	apiKey: "secret",
	future: "retained",
};
const output = {
	credentialId: "00000000-0000-4000-8000-000000000001",
	bucket: "bucket",
	path: "output/",
	filename: "asset.json",
};
const snapshot = {
	schemaVersion: 1,
	kind: "VOD_JOB",
	name: "asset",
	planHash: "hash",
	identity: "UNVERIFIED",
	inputs: [],
	playbackLinks: [],
	qcVerdict: null,
	qcOverriddenAt: null,
	analysisOutput: output,
};
function setup(
	overrides = {},
	readOutput?: Parameters<typeof createAnalysisSweep>[0]["readOutput"],
) {
	const row: Record<string, unknown> = {
		id: "source",
		encodingId: "encoding",
		accountId: "account",
		jobId: null,
		locales: ["en", "ja"],
		state: "PENDING",
		attempts: 0,
		availableAt: instant,
		leaseToken: null,
		leaseUntil: null,
		...overrides,
	};
	const revisions: Record<string, unknown>[] = [];
	const updateMany = vi.fn(async ({ where, data }) => {
		if (!matchesWhere(row, where)) return { count: 0 };
		for (const [key, value] of Object.entries(data))
			row[key] =
				key === "attempts"
					? Number(row.attempts) + (value as { increment: number }).increment
					: value;
		return { count: 1 };
	});
	const db = {
		librarySource: {
			updateMany,
			findMany: vi.fn(async ({ where, select }) =>
				matchesWhere(row, where) ? [projectSelect(row, select)] : [],
			),
		},
		sceneAnalysisRevision: {
			findMany: vi.fn(async () => revisions.map(({ locale }) => ({ locale }))),
			upsert: vi.fn(async ({ create }) => {
				revisions.push(create);
				return create;
			}),
		},
		$transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
	};
	const get = vi.fn(
		async (_id: string, _locale: string): Promise<unknown> => raw,
	);
	const providerFor = vi.fn(async () => ({ get }));
	const tick = createAnalysisSweep({
		prisma: db as unknown as AppPrismaClient,
		providerFor,
		readOutput,
		now: () => instant,
		uuid: () => "lease-new",
	});
	return { row, revisions, db, get, tick, providerFor };
}

describe("durable analysis import", () => {
	it("automatically reads configured output without requesting the provider analysis API", async () => {
		const read = vi.fn(async () => raw);
		const f = setup({ snapshot }, read);
		await f.tick();
		expect(f.row.state).toBe("READY");
		expect(read).toHaveBeenCalledWith(output, "ja");
		expect(f.providerFor).not.toHaveBeenCalled();
	});
	it("falls back to the analysis API only for unsupported storage, not missing or invalid output", async () => {
		const unsupported = setup(
			{ snapshot },
			vi.fn().mockRejectedValue(new UnsupportedBrowseError("unsupported")),
		);
		await unsupported.tick();
		expect(unsupported.row.state).toBe("READY");
		const missing = setup(
			{ snapshot },
			vi.fn().mockRejectedValue(new Error("missing")),
		);
		await missing.tick();
		expect(missing.row.state).toBe("ERROR");
		expect(missing.providerFor).not.toHaveBeenCalled();
	});
	it("imports after job deletion, redacts raw and keeps unknown raw fields", async () => {
		const f = setup();
		await f.tick();
		expect(f.row.state).toBe("READY");
		expect(f.revisions).toHaveLength(2);
		expect(f.revisions[0]?.raw).toMatchObject({
			apiKey: "[REDACTED]",
			future: "retained",
		});
		expect(f.revisions[0]?.document).not.toHaveProperty("future");
		expect(f.db).not.toHaveProperty("encodingJob");
	});
	it("imports default English for additional-only locales and waits for its actual output", async () => {
		const f = setup({ locales: ["ja"] });
		f.get.mockImplementation(async (_id, locale) => {
			if (locale === "en")
				throw new Error("English output is not available yet");
			return raw;
		});
		await f.tick();
		expect(f.row.locales).toEqual(["ja", "en"]);
		expect(f.row.state).toBe("ERROR");
		expect(f.revisions.map((revision) => revision.locale)).toEqual(["ja"]);
		f.row.availableAt = instant;
		f.get.mockClear();
		f.get.mockResolvedValue(raw);
		await f.tick();
		expect(f.row.state).toBe("READY");
		expect(f.get).toHaveBeenCalledExactlyOnceWith("encoding", "en");
		expect(f.revisions.map((revision) => revision.locale)).toEqual([
			"ja",
			"en",
		]);
	});
	it("imports provider shots that overlap scene boundaries without altering their timing", async () => {
		const f = setup({ locales: ["ja"] });
		f.get.mockResolvedValue({
			metadata: { version: "1.79.0" },
			duration: 653.83,
			scenes: [
				{
					id: "61cd7f2b-4057-4d21-9475-0bc5bfd78413",
					startInSeconds: 151.3125,
					endInSeconds: 238.875,
					shots: [{ startInSeconds: 149.875, endInSeconds: 152.916667 }],
				},
			],
		});
		await f.tick();
		expect(f.row.state).toBe("READY");
		expect(f.row.error).toBeNull();
		expect(f.revisions[0]?.document).toMatchObject({
			scenes: [
				{ shots: [{ startInSeconds: 149.875, endInSeconds: 152.916667 }] },
			],
		});
	});
	it("recovers a stale lease; an active lease cannot be taken", async () => {
		const stale = setup({
			state: "RUNNING",
			leaseToken: "old",
			leaseUntil: new Date(instant.getTime() - 1),
		});
		await stale.tick();
		expect(stale.row.state).toBe("READY");
		const active = setup({
			state: "RUNNING",
			leaseToken: "old",
			leaseUntil: new Date(instant.getTime() + 1),
		});
		await active.tick();
		expect(active.get).not.toHaveBeenCalled();
	});
	it("refuses late response persistence after lease ownership changes", async () => {
		const f = setup();
		f.get.mockImplementation(async () => {
			f.row.leaseToken = "another-worker";
			return raw;
		});
		await f.tick();
		expect(f.revisions).toHaveLength(0);
		expect(f.row.state).toBe("RUNNING");
		expect(f.row.leaseToken).toBe("another-worker");
	});
	it("keeps successful locales and retries only missing locales without changing encoding state", async () => {
		const f = setup();
		f.get.mockImplementation(async (_id, locale) => {
			if (locale === "ja") throw new Error("apiKey=secret");
			return raw;
		});
		await f.tick();
		expect(f.row.state).toBe("ERROR");
		expect(f.revisions).toHaveLength(1);
		expect(f.row.error).not.toContain("secret");
		f.row.availableAt = instant;
		f.get.mockClear();
		f.get.mockResolvedValue(raw);
		await f.tick();
		expect(f.row.state).toBe("READY");
		expect(f.revisions).toHaveLength(2);
		expect(f.get).toHaveBeenCalledExactlyOnceWith("encoding", "ja");
	});
	it("caps attempts and settles an abandoned final attempt", async () => {
		const f = setup({
			state: "RUNNING",
			attempts: ANALYSIS_MAX_ATTEMPTS,
			leaseUntil: new Date(instant.getTime() - 1),
		});
		await f.tick();
		expect(f.row.state).toBe("ERROR");
		expect(f.get).not.toHaveBeenCalled();
		await f.tick();
		expect(f.providerFor).not.toHaveBeenCalled();
	});
	it.each([
		{ locale: "en", suffix: "" },
		{ locale: "ja", suffix: "/language/ja" },
	])("uses the SDK $locale GET path and retains raw JSON before SDK mapping", async ({
		locale,
		suffix,
	}) => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(
					JSON.stringify({ status: "SUCCESS", data: { result: raw } }),
					{ status: 200 },
				),
			);
		try {
			const provider = await createAnalysisProvider({
				revealBitmovinAccount: async () => ({
					apiKey: "test",
					tenantOrgId: null,
				}),
			})("account");
			expect(await provider.get("encoding", locale)).toEqual(raw);
			expect(fetchMock.mock.calls[0]?.[0]).toBe(
				`https://api.bitmovin.com/v1/ai-scene-analysis/analyses/by-encoding-id/encoding/details${suffix}`,
			);
			expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
		} finally {
			fetchMock.mockRestore();
		}
	});
});
