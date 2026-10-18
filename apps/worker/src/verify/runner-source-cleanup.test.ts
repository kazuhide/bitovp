import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunnerConfig, stagedSourceSeconds } from "./runner";

const mocks = vi.hoisted(() => ({
	getObject: vi.fn(),
	probeFile: vi.fn(),
	dirs: [] as string[],
	cleanupFails: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		mkdtemp: async (prefix: string) => {
			const dir = await actual.mkdtemp(prefix);
			if (prefix.endsWith("verify-src-")) mocks.dirs.push(dir);
			return dir;
		},
		rm: async (...args: Parameters<typeof actual.rm>) => {
			if (mocks.cleanupFails && mocks.dirs.includes(String(args[0]))) {
				throw new Error("cleanup failed");
			}
			return actual.rm(...args);
		},
	};
});
vi.mock("@bitovp/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@bitovp/db")>()),
	createCredentialStore: () => ({
		get: async () => ({ provider: "S3", config: {} }),
		revealSecret: async () => "{}",
	}),
}));
vi.mock("@bitovp/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("@bitovp/storage")>()),
	createBrowserForCredential: () => ({ getObject: mocks.getObject }),
}));
vi.mock("./adapters", async (importOriginal) => ({
	...(await importOriginal<typeof import("./adapters")>()),
	probeFile: mocks.probeFile,
}));

const config = {
	prisma: {
		credential: { findMany: async () => [{ id: "source", label: "verify" }] },
	},
	s3CredentialLabel: "verify",
	inputBucket: "input",
	ffprobePath: "ffprobe",
} as unknown as RunnerConfig;

let unrelated: string;
beforeEach(async () => {
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32).toString("base64"));
	mocks.dirs.length = 0;
	mocks.getObject
		.mockReset()
		.mockImplementation(() => Readable.from(["source"]));
	mocks.probeFile.mockReset().mockResolvedValue({ fps: 24, nbFrames: 240 });
	unrelated = await mkdtemp(join(tmpdir(), "verify-source-neighbor-"));
	await writeFile(join(unrelated, "keep"), "unrelated");
});
afterEach(async () => {
	vi.unstubAllEnvs();
	mocks.cleanupFails = false;
	await Promise.all(
		[unrelated, ...mocks.dirs].map((dir) =>
			rm(dir, { recursive: true, force: true }),
		),
	);
});

describe("staged source scratch cleanup", () => {
	it.each([
		false,
		true,
	])("preserves the probe outcome when cleanup fails (probe failure: %s)", async (probeFails) => {
		mocks.cleanupFails = true;
		if (probeFails)
			mocks.probeFile.mockRejectedValue(new Error("probe failed"));
		expect(await stagedSourceSeconds(config, "source.mp4")).toBe(
			probeFails ? undefined : 10,
		);
	});
	it.each([
		"success",
		"download failure",
		"probe failure",
	])("removes only its own scratch after %s", async (outcome) => {
		if (outcome === "download failure") {
			mocks.getObject.mockImplementation(() =>
				Readable.from(
					(async function* () {
						yield "partial";
						throw new Error("download failed");
					})(),
				),
			);
		}
		if (outcome === "probe failure")
			mocks.probeFile.mockRejectedValue(new Error("probe failed"));
		expect(await stagedSourceSeconds(config, "source.mp4")).toBe(
			outcome === "success" ? 10 : undefined,
		);
		expect(mocks.dirs).toHaveLength(1);
		const dir = mocks.dirs[0];
		if (!dir) throw new Error("probe did not allocate scratch");
		await expect(readdir(dir)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(await readdir(unrelated)).toEqual(["keep"]);
	});
});
