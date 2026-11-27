import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as engine from "./engine";
import { main } from "./job";

const ports = vi.hoisted(() => ({
	jobs: vi.fn(),
	disconnect: vi.fn(),
	credentials: vi.fn(),
	credential: vi.fn(),
	reveal: vi.fn(),
	browser: vi.fn(),
}));
vi.mock("@bitovp/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@bitovp/core")>()),
	cipherFromEnv: () => ({}),
}));
vi.mock("@bitovp/db", () => ({
	createPrismaClient: () => ({
		encodingJob: { findMany: ports.jobs },
		$disconnect: ports.disconnect,
	}),
	createCredentialStore: () => ({
		list: ports.credentials,
		get: ports.credential,
		revealSecret: ports.reveal,
	}),
}));
vi.mock("@bitovp/storage", () => ({
	createBrowserForCredential: ports.browser,
}));
vi.mock("./adapters", async (importOriginal) => ({
	...(await importOriginal<typeof import("./adapters")>()),
	probeFile: async () => ({ durationSec: 9, fps: 30, nbFrames: 270 }),
}));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.resetAllMocks();
});

describe("verify job on a saved S3 role-based VOD", () => {
	it.each([
		{ case: "reads from the bound bucket", matchRole: true, matchBucket: true },
		{ case: "rejects another role", matchRole: false, matchBucket: true },
		{ case: "rejects another bucket", matchRole: true, matchBucket: false },
		{
			case: "marks a role mirror incomplete even with a healthy primary",
			matchRole: true,
			matchBucket: true,
			mirror: true,
		},
	])("$case", async ({ matchRole, matchBucket, mirror }) => {
		const plan = JSON.parse(
			readFileSync(
				join(
					import.meta.dirname,
					"../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws-role.plan.json",
				),
				"utf8",
			),
		);
		const roleId = "00000000-0000-4000-8000-000000000002";
		const otherRoleId = "00000000-0000-4000-8000-000000000009";
		const inputBucket = "verify-input-bucket";
		const outputBucket = "verify-output-bucket";
		const sourceKey = "/fixtures/source?literal%3F.mov";
		for (const ingest of plan.ingest) ingest.inputPath = sourceKey;
		plan.inputs[0].credentialId = roleId;
		plan.inputs[0].bucket = inputBucket;
		plan.outputs[0].credentialId = matchRole ? roleId : otherRoleId;
		plan.outputs[0].bucket = matchBucket ? outputBucket : "other-bucket";
		const jobId = "88888888-8888-4888-8888-888888888888";
		ports.jobs.mockResolvedValue([
			{
				id: jobId,
				name: plan.name,
				status: "FINISHED",
				plan,
				createdAt: new Date(),
			},
		]);
		const observer = {
			id: "00000000-0000-4000-8000-000000000003",
			label: "verify-reader",
			provider: "AWS_S3",
			config: { region: "ap-northeast-1" },
		};
		if (mirror) {
			plan.outputs.push({ ...plan.outputs[0], key: "archive" });
			plan.outputs[0].kind = "S3";
			plan.outputs[0].credentialId = observer.id;
			plan.outputs[0].bucket = "primary-bucket";
			plan.deliveryMirrors = [{ outputKey: "archive" }];
			vi.spyOn(engine, "verifyArtefacts").mockImplementation(
				async (expected) => {
					const report = new engine.ReportBuilder();
					report.pass("manifest:hls", "manifest", "primary delivery checked");
					return report.build(expected.planName);
				},
			);
		}
		const role = {
			id: roleId,
			label: "verify-role",
			provider: "AWS_S3_ROLE_BASED",
			config: {
				roleArn: "arn:aws:iam::123456789012:role/verify",
				region: "ap-northeast-1",
			},
		};
		ports.credentials.mockResolvedValue([
			role,
			{ ...role, id: otherRoleId, label: "verify-other-role" },
			{ ...observer, id: "other-reader", label: "verify-reader-other" },
			observer,
		]);
		ports.credential.mockImplementation(async (id) =>
			id === observer.id ? observer : null,
		);
		const secret = { accessKeyId: "test", secretAccessKey: "test" };
		ports.reveal.mockResolvedValue(JSON.stringify(secret));
		const manifestKey = "output/fixed-bitrate-hls-on-aws-role/stream.m3u8";
		const listObjects = vi.fn(async () => ({
			objects: [{ key: manifestKey, size: 60 }],
		}));
		const getObject = vi.fn(async ({ key }: { key: string }) =>
			Readable.from([key === manifestKey ? "#EXTM3U\n" : "reference fixture"]),
		);
		ports.browser.mockReturnValue({ listObjects, getObject });
		vi.stubEnv("VERIFY_S3_ROLE_BASED_LABEL", role.label);
		vi.stubEnv("VERIFY_S3_LABEL", observer.label);
		vi.stubEnv("VERIFY_S3_INPUT_BUCKET", inputBucket);
		vi.stubEnv("VERIFY_S3_OUTPUT_BUCKET", outputBucket);
		vi.stubEnv("VERIFY_SOURCE_OBJECT", "unrelated-corpus-source");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		if (mirror) {
			expect(await main([jobId])).toBe(1);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("PASS 1  WARN 0  FAIL 0  SKIP 1"),
			);
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining('S3 role mirror "archive"'),
			);
		} else if (matchRole && matchBucket) {
			await main([jobId]);
		} else {
			await expect(main([jobId])).rejects.toThrow(
				"requires a separate S3 verification observer",
			);
		}

		expect(ports.disconnect).toHaveBeenCalledOnce();
		expect(getObject).toHaveBeenCalledWith({
			bucket: inputBucket,
			key: sourceKey,
		});
		expect(
			ports.credential.mock.calls.every(([id]) => id === observer.id),
		).toBe(true);
		expect(ports.reveal.mock.calls.every(([id]) => id === observer.id)).toBe(
			true,
		);
		expect(ports.browser).toHaveBeenCalledWith({
			provider: "AWS_S3",
			config: observer.config,
			secret,
		});
		if (matchRole && matchBucket && !mirror) {
			expect(listObjects).toHaveBeenCalledWith(
				expect.objectContaining({ bucket: outputBucket }),
			);
			expect(getObject).toHaveBeenCalledWith({
				bucket: outputBucket,
				key: manifestKey,
			});
		} else {
			expect(listObjects).not.toHaveBeenCalled();
		}
	});
});
