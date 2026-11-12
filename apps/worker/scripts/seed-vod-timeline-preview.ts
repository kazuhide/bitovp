/** Synthetic media only, restricted to the isolated branch-preview stack. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CreateBucketCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { cipherFromEnv } from "@bitovp/core";
import {
	createCredentialStore,
	createPrismaClient,
	createTenantPrismaClient,
	DEFAULT_ORGANIZATION_ID,
} from "@bitovp/db";
import { previewSeedEnvironment } from "../src/library-editing/preview-fixture";
import { runMediaProcess } from "../src/library-editing/process";

async function main() {
	const env = previewSeedEnvironment(process.env);
	const directory = await mkdtemp(join(tmpdir(), "bitovp-vod-fixture-"));
	const client = new S3Client({
		endpoint: env.endpoint,
		region: "us-east-1",
		forcePathStyle: true,
		credentials: {
			accessKeyId: env.accessKeyId,
			secretAccessKey: env.secretAccessKey,
		},
		maxAttempts: 2,
	});
	const runtime = createPrismaClient(process.env.DATABASE_URL);
	try {
		const roles = await runtime.$queryRaw<
			Array<{ rolsuper: boolean; rolbypassrls: boolean }>
		>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
		if (roles.length !== 1 || roles[0]?.rolsuper || roles[0]?.rolbypassrls)
			throw new Error("PREVIEW_RESTRICTED_ROLE_REQUIRED");
		try {
			await client.send(new CreateBucketCommand({ Bucket: env.bucket }));
		} catch (error) {
			if (
				!["BucketAlreadyExists", "BucketAlreadyOwnedByYou"].includes(
					(error as Error).name,
				)
			)
				throw error;
		}
		for (const [name, video, frequency] of [
			[
				"a",
				"color=red:s=960x540:r=30:d=8,drawbox=x=0:y=0:w=iw:h=ih:color=green:t=fill:enable='gte(t,4)'",
				440,
			],
			["b", "color=blue:s=640x480:r=24:d=6", 880],
		] as const) {
			const path = join(directory, `${name}.mp4`);
			await runMediaProcess(
				process.env.FFMPEG_PATH ?? "ffmpeg",
				[
					"-v",
					"error",
					"-nostdin",
					"-cpucount",
					"1",
					"-filter_threads",
					"1",
					"-f",
					"lavfi",
					"-i",
					video,
					"-f",
					"lavfi",
					"-i",
					`sine=frequency=${frequency}:sample_rate=48000`,
					"-shortest",
					"-c:v",
					"libx264",
					"-threads",
					"1",
					"-preset",
					"ultrafast",
					"-pix_fmt",
					"yuv420p",
					"-c:a",
					"aac",
					"-ac",
					"2",
					"-movflags",
					"+faststart",
					path,
				],
				{ timeoutMs: 30_000 },
			);
			const bytes = await readFile(path);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const key = `fixtures/vod-timeline/v1/${name}.mp4`;
			let exists = false;
			try {
				const head = await client.send(
					new HeadObjectCommand({ Bucket: env.bucket, Key: key }),
				);
				if (head.Metadata?.sha256 !== sha256)
					throw new Error("PREVIEW_FIXTURE_WAS_CHANGED");
				exists = true;
			} catch (error) {
				if (!["NotFound", "NoSuchKey"].includes((error as Error).name))
					throw error;
			}
			if (!exists)
				await client.send(
					new PutObjectCommand({
						Bucket: env.bucket,
						Key: key,
						Body: bytes,
						ContentType: "video/mp4",
						Metadata: { sha256, "preview-fixture": "vod-timeline-v1" },
					}),
				);
		}
		const prisma = createTenantPrismaClient(runtime, DEFAULT_ORGANIZATION_ID);
		const label = "VOD timeline local S3 (synthetic only)";
		const existing = await prisma.credential.findFirst({ where: { label } });
		const credential =
			existing ??
			(await createCredentialStore(prisma, cipherFromEnv()).create({
				label,
				provider: "GENERIC_S3",
				config: {
					host: "storage",
					port: 8333,
					ssl: false,
					signatureVersion: "S3_V4",
				},
				secret: JSON.stringify({
					accessKeyId: env.accessKeyId,
					secretAccessKey: env.secretAccessKey,
				}),
			}));
		console.log(
			JSON.stringify({
				fixture: "vod-timeline-v1",
				credentialId: credential.id,
				bucket: env.bucket,
				objects: [
					"fixtures/vod-timeline/v1/a.mp4",
					"fixtures/vod-timeline/v1/b.mp4",
				],
			}),
		);
	} finally {
		client.destroy();
		await runtime.$disconnect();
		await rm(directory, { recursive: true, force: true });
	}
}
main().catch(() => {
	console.error("VOD_TIMELINE_PREVIEW_SEED_FAILED");
	process.exitCode = 1;
});
