import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	readExperimentRuntime,
	readExperimentSource,
} from "./encoding-experiments-files";

it("publishes only a fresh, verified GPU runtime", async () => {
	const root = await mkdtemp(join(tmpdir(), "bitovp-experiment-health-"));
	try {
		const checkedAt = 120_000;
		const digest = "1".repeat(64);
		const runtime = {
			schemaVersion: 1,
			runtimeId: digest,
			gpuUuid: "GPU-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			gpuName: "Example GPU",
			driverVersion: "580.178.04",
			supportedCodecs: ["H264", "HEVC", "AV1"],
			scoringProfileId: "official-vmaf-cuda-0.6.1",
			ffmpegSha256: digest,
			ffprobeSha256: digest,
			modelSha256: digest,
			runnerSha256: digest,
			sdkProbeSha256: digest,
			maxNvencApiVersion: 208,
		};
		await writeFile(
			join(root, "runtime.json"),
			JSON.stringify({ checkedAt, runtime }),
		);
		expect(await readExperimentRuntime(root, checkedAt + 20_000)).toEqual(
			runtime,
		);
		expect(await readExperimentRuntime(root, checkedAt + 120_000)).toBeNull();
		expect(await readExperimentRuntime(root, checkedAt - 20_000)).toBeNull();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("rejects invalid locators and symlinked registrations", async () => {
	const root = await mkdtemp(join(tmpdir(), "bitovp-experiment-source-"));
	try {
		const organization = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
		const location = join(root, "sources", organization);
		const { mkdir } = await import("node:fs/promises");
		await mkdir(location, { recursive: true });
		await writeFile(
			join(root, "other.json"),
			JSON.stringify({ id: "media", label: "media", sha256: "a".repeat(64) }),
		);
		await symlink(join(root, "other.json"), join(location, "media.json"));
		expect(
			await readExperimentSource(root, organization, "../other"),
		).toBeNull();
		expect(await readExperimentSource(root, organization, "media")).toBeNull();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
