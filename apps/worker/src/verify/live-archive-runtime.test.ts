import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import {
	compileLiveChannel,
	liveChannelPlanSchema,
	type StepLogEntry,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	status: vi.fn(),
	mux: vi.fn(),
	output: vi.fn(),
	head: vi.fn(),
	get: vi.fn(),
	dispose: vi.fn(),
	inspect: vi.fn(),
	run: vi.fn(),
}));
vi.mock("@bitovp/core", async (load) => ({
	...(await load<object>()),
	cipherFromEnv: () => ({}),
}));
vi.mock("@bitovp/db", () => ({
	createBitmovinAccountStore: () => ({
		get: async () => ({}),
		revealApiKey: async () => "unused",
	}),
	createCredentialStore: () => ({
		get: async () => ({ provider: "AWS_S3", config: {} }),
		revealSecret: async () => "{}",
	}),
}));
vi.mock("@bitovp/storage", () => ({
	createBrowserForCredential: () => ({
		headObject: mocks.head,
		getObject: mocks.get,
		dispose: mocks.dispose,
	}),
}));
vi.mock("../bitmovin/sdk-ctor", () => ({
	BitmovinApi: class {
		encoding = {
			encodings: { status: mocks.status, muxings: { mp4: { get: mocks.mux } } },
			outputs: { s3: { get: mocks.output } },
		};
	},
}));
vi.mock("./live-archive", async (load) => ({
	...(await load<object>()),
	inspectArchiveBytes: mocks.inspect,
}));

import { verifyLiveArchives } from "./live-archive-runtime";

function fixture() {
	const raw = JSON.parse(
		readFileSync(
			new URL(
				"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	raw.muxings.push({
		key: "archive",
		kind: "MP4",
		streamKey: "v1080",
		additionalStreamKeys: ["a128"],
		filename: "archive.mp4",
		destination: { outputKey: "origin", path: "verification/archive" },
	});
	const plan = liveChannelPlanSchema.parse(raw);
	const steps = compileLiveChannel(plan).map((s) => ({
		...s,
		status: "DONE",
		resourceId: `id-${s.step}`,
	})) as StepLogEntry[];
	return { plan, steps };
}
const db = {
	liveChannelRun: { findUniqueOrThrow: mocks.run },
} as unknown as AppPrismaClient;
describe("QA archive runtime", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		const { plan, steps } = fixture();
		mocks.run.mockResolvedValue({
			id: "run-a",
			liveChannelId: "channel-a",
			createdAt: new Date(0),
			stepLog: steps,
			liveChannel: { bitmovinAccountId: "account-a" },
		});
		mocks.status.mockResolvedValue({ status: "FINISHED" });
		mocks.mux.mockResolvedValue({
			id: "id-muxing:archive",
			filename: "archive.mp4",
			streams: [
				{ streamId: "id-stream:v1080" },
				{ streamId: "id-stream:a128" },
			],
			outputs: [
				{ outputId: "id-output:origin", outputPath: "verification/archive" },
			],
		});
		mocks.output.mockResolvedValue({
			id: "id-output:origin",
			bucketName: (plan.outputs[0] as { bucket: string }).bucket,
		});
		mocks.head.mockResolvedValue({
			size: 3,
			etag: "pinned",
			lastModified: new Date(1000).toISOString(),
		});
		mocks.get.mockImplementation(async () =>
			Readable.from([Buffer.from("abc")]),
		);
		mocks.inspect.mockResolvedValue({
			bytes: 3,
			sha256: "digest",
			videoDurationSeconds: 2,
			audioDurationSeconds: 2,
			avSync: "UNVERIFIED",
		});
	});
	const run = () =>
		verifyLiveArchives(db, {
			channelId: "channel-a",
			encodingId: "id-encoding",
			plan: fixture().plan,
		});
	it("reads pinned exact-run bytes only after FINISHED and joins result to run", async () => {
		const checks = await run();
		expect(checks[0]?.verdict).toBe("PASS");
		expect(JSON.parse(checks[0]?.detail ?? "null")).toMatchObject({
			liveChannelRunId: "run-a",
			avSync: "UNVERIFIED",
			privacy: "UNVERIFIED",
		});
		expect(mocks.get.mock.calls[0]?.[0].expect).toMatchObject({
			etag: "pinned",
		});
	});
	it.each([
		"RUNNING",
		"ERROR",
	])("does not fetch archives for provider %s", async (status) => {
		mocks.status.mockResolvedValue({ status });
		expect((await run())[0]?.verdict).toBe("SKIP");
		expect(mocks.get).not.toHaveBeenCalled();
	});
	it.each([
		{ size: 250000001, etag: "pin" },
		{ size: 3 },
	])("refuses oversize/unpinned identity %j", async (identity) => {
		mocks.head.mockResolvedValue({
			...identity,
			lastModified: new Date(1000).toISOString(),
		});
		expect((await run())[0]?.verdict).toBe("SKIP");
		expect(mocks.get).not.toHaveBeenCalled();
	});
	it("does not consume a version-changed read", async () => {
		mocks.get.mockRejectedValue(new Error("secret provider detail"));
		const checks = await run();
		expect(checks[0]?.verdict).toBe("SKIP");
		expect(checks[0]?.detail).not.toContain("secret provider");
		expect(mocks.inspect).not.toHaveBeenCalled();
	});
	it("fails a nondecodable exact file without exposing raw errors", async () => {
		mocks.inspect.mockRejectedValue(new Error("raw private path"));
		const checks = await run();
		expect(checks[0]?.verdict).toBe("FAIL");
		expect(checks[0]?.detail).not.toContain("private path");
	});
	it("returns SKIP at the hard deadline even for a stuck storage HEAD", async () => {
		vi.useFakeTimers();
		try {
			mocks.head.mockReturnValue(new Promise(() => {}));
			const result = run();
			await vi.advanceTimersByTimeAsync(120000);
			expect((await result)[0]?.verdict).toBe("SKIP");
			expect(mocks.get).not.toHaveBeenCalled();
			expect(mocks.dispose).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
