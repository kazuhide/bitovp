/** Invoked only by the isolated editing-preview Docker Compose seed service. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	CreateBucketCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { cipherFromEnv, normalizeSceneAnalysis } from "@bitovp/core";
import {
	createCredentialStore,
	createPrismaClient,
	createTenantPrismaClient,
	DEFAULT_ORGANIZATION_ID,
} from "@bitovp/db";
import {
	ANIMATION_CONTENT_ID,
	ANIMATION_DESCRIPTION,
	ANIMATION_OBJECT_KEY,
	ANIMATION_REGISTRATION_KEY,
	ANIMATION_SOURCE_ID,
	ANIMATION_TITLE,
	animationAnalysis,
	animationDemo,
	animationInputArgument,
	animationMediaArguments,
	animationSourceSnapshot,
	copyVerifiedAnimationSource,
} from "../src/library-editing/animation-fixture";
import { sealAutomaticFixtureBindings } from "../src/library-editing/automatic-fixture-binding";
import { probeEditingMedia } from "../src/library-editing/media";
import {
	PREVIEW_CONTENT_ID,
	PREVIEW_DESCRIPTION,
	PREVIEW_FIXTURE_VERSION,
	PREVIEW_OBJECT_KEY,
	PREVIEW_REGISTRATION_KEY,
	PREVIEW_SOURCE_ID,
	PREVIEW_TITLE,
	previewAnalysis,
	previewMediaArguments,
	previewSeedEnvironment,
	previewSourceSnapshot,
} from "../src/library-editing/preview-fixture";

const hash = (bytes: Buffer | string) =>
	createHash("sha256").update(bytes).digest("hex");
const isMissing = (error: unknown) =>
	(error as { $metadata?: { httpStatusCode?: number } })?.$metadata
		?.httpStatusCode === 404;

function selectedFixture(animation: boolean) {
	return animation
		? {
				contentId: ANIMATION_CONTENT_ID,
				sourceId: ANIMATION_SOURCE_ID,
				registrationKey: ANIMATION_REGISTRATION_KEY,
				objectKey: ANIMATION_OBJECT_KEY,
				originalJobId: "72b30340-2426-439e-8029-3e5dc764ee03",
				accountId: "72b30340-2426-439e-8029-3e5dc764ee04",
				version: animationDemo.id,
				providerVersion: "manual-animation-caminandes2-v1",
				title: ANIMATION_TITLE,
				description: ANIMATION_DESCRIPTION,
				tags: ["アニメ構図デモ", "手動メタデータ", "CC BY 3.0"],
				credentialLabel: "Editing preview local S3 (licensed animation demo)",
				analysis: animationAnalysis,
				snapshot: animationSourceSnapshot,
				width: animationDemo.profile.width,
				height: animationDemo.profile.height,
				frames: animationDemo.profile.frameCount,
				durationUs: animationDemo.excerpt.durationSeconds * 1_000_000,
			}
		: {
				contentId: PREVIEW_CONTENT_ID,
				sourceId: PREVIEW_SOURCE_ID,
				registrationKey: PREVIEW_REGISTRATION_KEY,
				objectKey: PREVIEW_OBJECT_KEY,
				originalJobId: "72b20340-2426-439e-8029-3e5dc764ee03",
				accountId: "72b20340-2426-439e-8029-3e5dc764ee04",
				version: PREVIEW_FIXTURE_VERSION,
				providerVersion: `synthetic-preview-${PREVIEW_FIXTURE_VERSION}`,
				title: PREVIEW_TITLE,
				description: PREVIEW_DESCRIPTION,
				tags: ["合成サンプル", "AISA編集検証"],
				credentialLabel: "Editing preview local S3 (synthetic only)",
				analysis: previewAnalysis,
				snapshot: previewSourceSnapshot,
				width: 960,
				height: 540,
				frames: 540,
				durationUs: 18_000_000,
			};
}

async function generateMedia(args: string[]) {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, {
			stdio: ["ignore", "ignore", "pipe"],
		});
		// Drain errors without reflecting paths or environment values into logs.
		child.stderr.resume();
		const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
		child.once("error", () => {
			clearTimeout(timeout);
			reject(new Error("PREVIEW_MEDIA_GENERATION_FAILED"));
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) resolve();
			else reject(new Error("PREVIEW_MEDIA_GENERATION_FAILED"));
		});
	});
}

async function ensureSourceObject(
	client: S3Client,
	bucket: string,
	fixture: ReturnType<typeof selectedFixture>,
	animationInputPath: string | null,
): Promise<string> {
	try {
		await client.send(new CreateBucketCommand({ Bucket: bucket }));
	} catch (error) {
		if (
			!["BucketAlreadyExists", "BucketAlreadyOwnedByYou"].includes(
				(error as Error).name,
			)
		)
			throw error;
	}
	try {
		const head = await client.send(
			new HeadObjectCommand({ Bucket: bucket, Key: fixture.objectKey }),
		);
		if (
			head.Metadata?.["preview-fixture"] !== fixture.version ||
			!head.Metadata.sha256 ||
			!/^[a-f0-9]{64}$/.test(head.Metadata.sha256) ||
			!head.ETag ||
			!head.ContentLength ||
			head.ContentLength > 16 * 1024 * 1024
		)
			throw new Error("PREVIEW_SOURCE_WAS_CHANGED");
		const existing = await client.send(
			new GetObjectCommand({
				Bucket: bucket,
				Key: fixture.objectKey,
				IfMatch: head.ETag,
			}),
		);
		const bytes = await existing.Body?.transformToByteArray();
		if (
			!bytes ||
			bytes.length !== head.ContentLength ||
			hash(Buffer.from(bytes)) !== head.Metadata.sha256
		)
			throw new Error("PREVIEW_SOURCE_WAS_CHANGED");
		return head.Metadata.sha256;
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	const directory = await mkdtemp(join(tmpdir(), "bitovp-editing-preview-"));
	try {
		const path = join(directory, "aisa-demo.mp4");
		await generateMedia(
			animationInputPath
				? animationMediaArguments(animationInputPath, path)
				: previewMediaArguments(path),
		);
		// Refuse invalid normalized bytes before any object or Library record is published.
		const facts = await probeEditingMedia({
			sourcePath: path,
			ffprobePath: process.env.FFPROBE_PATH || "ffprobe",
		});
		if (
			facts.width !== fixture.width ||
			facts.height !== fixture.height ||
			facts.frameCount !== fixture.frames ||
			facts.durationUs !== fixture.durationUs ||
			!facts.hasAudio
		)
			throw new Error("PREVIEW_MEDIA_INVALID");
		if (animationInputPath) {
			const streams = Array.isArray(facts.probe.streams)
				? facts.probe.streams
				: [];
			const audio = streams.find(
				(stream: unknown): stream is Record<string, unknown> =>
					!!stream &&
					typeof stream === "object" &&
					"codec_type" in stream &&
					stream.codec_type === "audio",
			);
			if (
				Number(audio?.sample_rate) !== animationDemo.profile.audioSampleRate ||
				Number(audio?.channels) !== 2
			)
				throw new Error("PREVIEW_MEDIA_INVALID");
		}
		const bytes = await readFile(path);
		const sourceSha256 = hash(bytes);
		await client.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: fixture.objectKey,
				Body: bytes,
				ContentType: "video/mp4",
				IfNoneMatch: "*",
				Metadata: {
					"preview-fixture": fixture.version,
					sha256: sourceSha256,
				},
			}),
		);
		return sourceSha256;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function main() {
	const animationPath = animationInputArgument(process.argv.slice(2));
	const fixture = selectedFixture(animationPath !== null);
	const env = previewSeedEnvironment(process.env);
	const client = new S3Client({
		endpoint: env.endpoint,
		region: "us-east-1",
		forcePathStyle: true,
		credentials: {
			accessKeyId: env.accessKeyId,
			secretAccessKey: env.secretAccessKey,
		},
		maxAttempts: 3,
		requestHandler: { requestTimeout: 30_000, connectionTimeout: 5_000 },
	});
	const runtime = createPrismaClient(process.env.DATABASE_URL);
	let inputDirectory: string | null = null;
	try {
		const roles = await runtime.$queryRaw<
			Array<{ rolsuper: boolean; rolbypassrls: boolean }>
		>`
			SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
		`;
		if (roles.length !== 1 || roles[0]?.rolsuper || roles[0]?.rolbypassrls)
			throw new Error("PREVIEW_RESTRICTED_ROLE_REQUIRED");
		let ownedInput: string | null = null;
		if (animationPath) {
			inputDirectory = await mkdtemp(join(tmpdir(), "bitovp-animation-input-"));
			ownedInput = join(inputDirectory, "original.mp4");
			await copyVerifiedAnimationSource(animationPath, ownedInput);
		}
		const sourceSha256 = await ensureSourceObject(
			client,
			env.bucket,
			fixture,
			ownedInput,
		);
		const prisma = createTenantPrismaClient(runtime, DEFAULT_ORGANIZATION_ID);
		const existing = await prisma.librarySource.findUnique({
			where: { id: fixture.sourceId },
		});
		if (!existing) {
			const store = createCredentialStore(prisma, cipherFromEnv());
			const config = {
				host: "storage",
				port: 8333,
				ssl: false,
				signatureVersion: "S3_V4",
			};
			const priorCredential = await prisma.credential.findFirst({
				where: { label: fixture.credentialLabel },
			});
			if (
				priorCredential &&
				(priorCredential.provider !== "GENERIC_S3" ||
					!isDeepStrictEqual(priorCredential.config, config))
			)
				throw new Error("PREVIEW_CREDENTIAL_WAS_CHANGED");
			const credential =
				priorCredential ??
				(await store.create({
					label: fixture.credentialLabel,
					provider: "GENERIC_S3",
					config,
					secret: JSON.stringify({
						accessKeyId: env.accessKeyId,
						secretAccessKey: env.secretAccessKey,
					}),
				}));
			const raw = fixture.analysis();
			const document = normalizeSceneAnalysis(raw);
			await prisma.$transaction(async (tx) => {
				await tx.librarySource.create({
					data: {
						id: fixture.sourceId,
						sourceKey: fixture.registrationKey,
						originalJobId: fixture.originalJobId,
						encodingId: fixture.providerVersion,
						accountId: fixture.accountId,
						state: "READY",
						locales: ["ja"],
						snapshot: fixture.snapshot(credential.id),
					},
				});
				await tx.content.create({
					data: {
						id: fixture.contentId,
						registrationKey: fixture.registrationKey,
						title: fixture.title,
						description: fixture.description,
						tags: fixture.tags,
						locale: "ja",
					},
				});
				await tx.contentRevision.create({
					data: {
						contentId: fixture.contentId,
						sourceId: fixture.sourceId,
						revision: 1,
						title: fixture.title,
						description: fixture.description,
						tags: fixture.tags,
						locale: "ja",
					},
				});
				await tx.sceneAnalysisRevision.create({
					data: {
						sourceId: fixture.sourceId,
						locale: "ja",
						rawHash: hash(JSON.stringify(raw)),
						providerVersion: fixture.providerVersion,
						raw,
						document,
					},
				});
			});
		}
		const automaticBindings = await sealAutomaticFixtureBindings({
			prisma,
			organizationId: DEFAULT_ORGANIZATION_ID,
			fixture: animationPath ? "ANIMATION" : "SYNTHETIC",
			sourceSha256,
		});
		console.log(
			JSON.stringify({
				status: existing ? "preserved" : "created",
				contentId: fixture.contentId,
				sourceId: fixture.sourceId,
				libraryPath: `/library/${fixture.contentId}`,
				automaticBindingKind: "FIXTURE_AUTHORED",
				automaticBindings,
				syntheticOnly: animationPath === null,
				...(animationPath
					? { metadataProvenance: "MANUALLY_ANNOTATED_DEMO" }
					: {}),
			}),
		);
	} finally {
		client.destroy();
		try {
			await runtime.$disconnect();
		} finally {
			if (inputDirectory)
				await rm(inputDirectory, { recursive: true, force: true });
		}
	}
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : "";
	console.error(
		/^PREVIEW_[A-Z_]+$/.test(message) ? message : "PREVIEW_SEED_FAILED",
	);
	process.exitCode = 1;
});
