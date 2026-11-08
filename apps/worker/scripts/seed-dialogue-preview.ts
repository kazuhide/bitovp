/** Extra licensed original-dialogue fixture. Isolated editing-preview Compose only. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	CreateBucketCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import {
	canonicalEditingJson,
	cipherFromEnv,
	editingMediaStorageSchema,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import {
	createCredentialStore,
	createPrismaClient,
	createTenantPrismaClient,
	DEFAULT_ORGANIZATION_ID,
	type Prisma,
} from "@bitovp/db";
import { copyVerifiedAnimationSource } from "../src/library-editing/animation-fixture";
import {
	assertDialogueMediaFacts,
	DIALOGUE_ANALYSIS_ID,
	DIALOGUE_CONTENT_ID,
	DIALOGUE_CREDENTIAL_ID,
	DIALOGUE_DESCRIPTION,
	DIALOGUE_MEDIA_ID,
	DIALOGUE_SOURCE_ID,
	dialogueAnalysis,
	dialogueBindingProof,
	dialogueDemo,
	dialogueInputArgument,
} from "../src/library-editing/dialogue-fixture";
import { ensureDialoguePreviewSource } from "../src/library-editing/dialogue-source";
import { probeEditingMedia } from "../src/library-editing/media";
import { previewSeedEnvironment } from "../src/library-editing/preview-fixture";

const digest = (bytes: Uint8Array | string) =>
	createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const missing = (error: unknown) =>
	(error as { $metadata?: { httpStatusCode?: number } })?.$metadata
		?.httpStatusCode === 404;
function changed(): never {
	throw new Error("PREVIEW_DIALOGUE_EVIDENCE_CHANGED");
}

async function verifiedObject(client: S3Client, bucket: string) {
	const head = await client.send(
		new HeadObjectCommand({ Bucket: bucket, Key: dialogueDemo.objectKey }),
	);
	if (
		head.ContentLength !== dialogueDemo.prepared.bytes ||
		head.Metadata?.["dialogue-fixture"] !== dialogueDemo.id ||
		head.Metadata?.sha256 !== dialogueDemo.prepared.sha256 ||
		!head.ETag
	)
		changed();
	const object = await client.send(
		new GetObjectCommand({
			Bucket: bucket,
			Key: dialogueDemo.objectKey,
			IfMatch: head.ETag,
		}),
	);
	if (!object.Body || object.ContentLength !== dialogueDemo.prepared.bytes)
		changed();
	let count = 0;
	const hash = createHash("sha256");
	try {
		for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
			count += chunk.length;
			if (count > dialogueDemo.prepared.bytes) changed();
			hash.update(chunk);
		}
	} finally {
		(object.Body as { destroy?: () => void }).destroy?.();
	}
	if (
		count !== dialogueDemo.prepared.bytes ||
		hash.digest("hex") !== dialogueDemo.prepared.sha256
	)
		changed();
	return {
		credentialId: DIALOGUE_CREDENTIAL_ID,
		bucket,
		key: dialogueDemo.objectKey,
		size: count,
		expect: { etag: head.ETag },
	};
}

async function ensureObject(client: S3Client, bucket: string, bytes: Buffer) {
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
		return await verifiedObject(client, bucket);
	} catch (error) {
		if (!missing(error)) throw error;
	}
	await client.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: dialogueDemo.objectKey,
			Body: bytes,
			ContentType: "video/mp4",
			IfNoneMatch: "*",
			Metadata: {
				"dialogue-fixture": dialogueDemo.id,
				sha256: dialogueDemo.prepared.sha256,
			},
		}),
	);
	return verifiedObject(client, bucket);
}

async function main() {
	const input = dialogueInputArgument(process.argv.slice(2));
	const env = previewSeedEnvironment(process.env);
	const runtime = createPrismaClient(process.env.DATABASE_URL);
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
	let directory: string | undefined;
	try {
		const roles = await runtime.$queryRaw<
			Array<{ rolsuper: boolean; rolbypassrls: boolean }>
		>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
		if (roles.length !== 1 || roles[0]?.rolsuper || roles[0]?.rolbypassrls)
			throw new Error("PREVIEW_RESTRICTED_ROLE_REQUIRED");
		directory = await mkdtemp(join(tmpdir(), "bitovp-dialogue-seed-"));
		const owned = join(directory, "dialogue.mp4");
		await copyVerifiedAnimationSource(
			input,
			owned,
			dialogueDemo.prepared,
		).catch(() => {
			throw new Error("PREVIEW_DIALOGUE_SOURCE_INVALID");
		});
		const facts = await probeEditingMedia({
			sourcePath: owned,
			ffprobePath: process.env.FFPROBE_PATH || "ffprobe",
		});
		assertDialogueMediaFacts(facts);
		const bytes = await readFile(owned);
		if (
			bytes.length !== dialogueDemo.prepared.bytes ||
			digest(bytes) !== dialogueDemo.prepared.sha256
		)
			changed();
		const fixed = await ensureObject(client, env.bucket, bytes);
		const prisma = createTenantPrismaClient(runtime, DEFAULT_ORGANIZATION_ID);
		const cipher = cipherFromEnv();
		const secret = JSON.stringify({
			accessKeyId: env.accessKeyId,
			secretAccessKey: env.secretAccessKey,
		});
		const credential = {
			id: DIALOGUE_CREDENTIAL_ID,
			label: "Editing preview local S3 (Sintel original dialogue)",
			provider: "GENERIC_S3" as const,
			config: {
				host: "storage",
				port: 8333,
				ssl: false,
				signatureVersion: "S3_V4",
			},
		};
		const priorCredential = await prisma.credential.findUnique({
			where: { id: credential.id },
		});
		if (priorCredential) {
			if (
				priorCredential.organizationId !== DEFAULT_ORGANIZATION_ID ||
				priorCredential.label !== credential.label ||
				priorCredential.provider !== credential.provider ||
				canonicalEditingJson(priorCredential.config) !==
					canonicalEditingJson(credential.config)
			)
				changed();
			const revealed = await createCredentialStore(prisma, cipher).revealSecret(
				credential.id,
			);
			if (
				canonicalEditingJson(JSON.parse(revealed)) !==
				canonicalEditingJson(JSON.parse(secret))
			)
				changed();
		}
		const encryptedSecret = priorCredential
			? null
			: await cipher.encrypt(
					secret,
					`credential:${credential.id}:${credential.provider}`,
				);
		const result = await prisma.$transaction(async (tx) => {
			if (!priorCredential && encryptedSecret)
				await tx.credential.create({
					data: { ...credential, encryptedSecret },
				});
			const { source, created } = await ensureDialoguePreviewSource(tx, {
				organizationId: DEFAULT_ORGANIZATION_ID,
				cipher,
			});
			const existed = !created;
			if (created) {
				await tx.content.create({
					data: {
						id: DIALOGUE_CONTENT_ID,
						registrationKey: dialogueDemo.registrationKey,
						title: dialogueDemo.title,
						description: DIALOGUE_DESCRIPTION,
						tags: ["Sintel", "原音声", "手動メタデータ", "CC BY 3.0"],
						locale: "en",
					},
				});
				await tx.contentRevision.create({
					data: {
						contentId: DIALOGUE_CONTENT_ID,
						sourceId: source.id,
						revision: 1,
						title: dialogueDemo.title,
						description: DIALOGUE_DESCRIPTION,
						tags: ["Sintel", "原音声", "手動メタデータ", "CC BY 3.0"],
						locale: "en",
					},
				});
				const raw = dialogueAnalysis();
				await tx.sceneAnalysisRevision.create({
					data: {
						id: DIALOGUE_ANALYSIS_ID,
						sourceId: source.id,
						locale: "en",
						rawHash: digest(JSON.stringify(raw)),
						providerVersion: raw.metadata.version,
						raw: json(raw),
						document: json(normalizeSceneAnalysis(raw)),
					},
				});
				await tx.libraryMediaVersion.create({
					data: {
						id: DIALOGUE_MEDIA_ID,
						sourceId: source.id,
						credentialId: DIALOGUE_CREDENTIAL_ID,
						outputCredentialId: DIALOGUE_CREDENTIAL_ID,
						storage: {
							source: fixed,
							prepared: fixed,
							output: {
								credentialId: DIALOGUE_CREDENTIAL_ID,
								bucket: env.bucket,
								prefix: dialogueDemo.outputPrefix,
							},
						},
						state: "READY",
						sha256: dialogueDemo.prepared.sha256,
						width: facts.width,
						height: facts.height,
						durationUs: BigInt(facts.durationUs),
						fpsNum: 30,
						fpsDen: 1,
						timeMap: {
							id: DIALOGUE_MEDIA_ID,
							mediaVersionId: DIALOGUE_MEDIA_ID,
							kind: "CFR",
							sourceStartUs: 0,
							sourceEndUs: 14_000_000,
							editingStartFrame: 0,
							editingEndFrame: 420,
							fps: { num: 30, den: 1 },
						},
						probe: json(facts.probe),
					},
				});
			}
			await tx.$queryRaw`SELECT "id" FROM "LibrarySource" WHERE "id" = ${DIALOGUE_SOURCE_ID}::uuid AND "organizationId" = ${DEFAULT_ORGANIZATION_ID}::uuid FOR UPDATE`;
			const content = await tx.content.findUnique({
				where: { id: DIALOGUE_CONTENT_ID },
			});
			const analysis = await tx.sceneAnalysisRevision.findUnique({
				where: { id: DIALOGUE_ANALYSIS_ID },
			});
			const media = await tx.libraryMediaVersion.findUnique({
				where: { id: DIALOGUE_MEDIA_ID },
			});
			if (
				!content ||
				content.organizationId !== DEFAULT_ORGANIZATION_ID ||
				content.registrationKey !== dialogueDemo.registrationKey ||
				!analysis ||
				!media
			)
				changed();
			const currentStorage = editingMediaStorageSchema.parse(media.storage);
			if (
				media.credentialId !== DIALOGUE_CREDENTIAL_ID ||
				media.outputCredentialId !== DIALOGUE_CREDENTIAL_ID ||
				canonicalEditingJson(currentStorage.source) !==
					canonicalEditingJson(fixed) ||
				canonicalEditingJson(currentStorage.prepared ?? null) !==
					canonicalEditingJson(fixed)
			)
				changed();
			const proof = dialogueBindingProof({
				organizationId: DEFAULT_ORGANIZATION_ID,
				source,
				analysis,
				media,
			});
			const where = {
				organizationId: DEFAULT_ORGANIZATION_ID,
				mediaVersionId: DIALOGUE_MEDIA_ID,
				analysisRevisionId: DIALOGUE_ANALYSIS_ID,
			};
			const prior = await tx.libraryAnalysisBinding.findFirst({ where });
			if (prior) {
				if (canonicalEditingJson(prior.proof) !== canonicalEditingJson(proof))
					changed();
			} else
				await tx.libraryAnalysisBinding.create({
					data: { ...where, proof: json(proof) },
				});
			return {
				status: existed ? "preserved" : "created",
				contentId: content.id,
				sourceId: source.id,
				mediaVersionId: media.id,
				analysisRevisionId: analysis.id,
				automaticBindingKind: "FIXTURE_AUTHORED",
				metadataProvenance: "MANUALLY_ANNOTATED_DEMO",
				voiceProvenance: "ORIGINAL_FILM_AUDIO",
				sourceSha256: dialogueDemo.prepared.sha256,
				libraryPath: `/library/${content.id}`,
			};
		});
		console.log(JSON.stringify(result));
	} finally {
		client.destroy();
		try {
			await runtime.$disconnect();
		} finally {
			if (directory) await rm(directory, { recursive: true, force: true });
		}
	}
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : "";
		console.error(
			/^PREVIEW_[A-Z_]+$/.test(message)
				? message
				: "PREVIEW_DIALOGUE_SEED_FAILED",
		);
		process.exitCode = 1;
	});
