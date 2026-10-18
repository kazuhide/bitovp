import assert from "node:assert/strict";
import type { Readable } from "node:stream";
import {
	cipherFromEnv,
	type LiveChannelPlan,
	parseStorageEndpointAllowlist,
	type StepLogEntry,
} from "@bitovp/core";
import {
	type AppPrismaClient,
	createBitmovinAccountStore,
	createCredentialStore,
} from "@bitovp/db";
import {
	createBrowserForCredential,
	type ObjectStorageBrowser,
} from "@bitovp/storage";
import { BitmovinApi } from "../bitmovin/sdk-ctor";
import type { Check } from "./engine";
import { ARCHIVE_MAX_BYTES, inspectArchiveBytes } from "./live-archive";
import { bindLiveArchive } from "./live-archive-binding";

export type ArchiveCheckInput = {
	channelId: string;
	encodingId: string;
	plan: LiveChannelPlan;
};

/** QA-only, read-only post-stop verification. Never runs on normal operator stop. */
export async function verifyLiveArchives(
	prisma: AppPrismaClient,
	input: ArchiveCheckInput,
): Promise<Check[]> {
	const checks: Check[] = [];
	for (const mux of input.plan.muxings.filter((m) => m.kind === "MP4")) {
		for (const outputKey of new Set([
			mux.destination?.outputKey ?? "",
			...(input.plan.deliveryMirrors ?? []).map((m) => m.outputKey),
		])) {
			const id = `live:archive:${mux.key}:${outputKey}`;
			const controller = new AbortController();
			let browser: ObjectStorageBrowser | undefined;
			let stream: Readable | undefined;
			let stage = "binding";
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					stream?.destroy();
					browser?.dispose?.();
					reject(new Error("archive timeout"));
				}, 120_000);
			});
			const perform = async (): Promise<Check> => {
				// Encoding ids are unique across run rows: never substitute channel.latestRun.
				const run = await prisma.liveChannelRun.findUniqueOrThrow({
					where: { bitmovinEncodingId: input.encodingId },
					select: {
						id: true,
						liveChannelId: true,
						createdAt: true,
						stepLog: true,
						liveChannel: { select: { bitmovinAccountId: true } },
					},
				});
				assert.equal(run.liveChannelId, input.channelId);
				controller.signal.throwIfAborted();
				const binding = bindLiveArchive(
					input.plan,
					run.stepLog as StepLogEntry[],
					input.encodingId,
					mux.key,
					outputKey,
				);
				const accountId = run.liveChannel.bitmovinAccountId;
				assert.ok(accountId);
				const accounts = createBitmovinAccountStore(prisma, cipherFromEnv());
				const account = await accounts.get(accountId);
				assert.ok(account);
				const sdk = new BitmovinApi({
					apiKey: await accounts.revealApiKey(accountId),
					...(account.tenantOrgId ? { tenantOrgId: account.tenantOrgId } : {}),
					fetch: (url, init) =>
						fetch(url, { ...init, signal: controller.signal }),
				});
				stage = "provider-terminal";
				assert.equal(
					(await sdk.encoding.encodings.status(input.encodingId)).status,
					"FINISHED",
				);
				stage = "provider-binding";
				const actual = await sdk.encoding.encodings.muxings.mp4.get(
					input.encodingId,
					binding.muxingId,
				);
				assert.equal(actual.id, binding.muxingId);
				assert.equal(actual.filename, binding.filename);
				assert.deepEqual(
					(actual.streams ?? []).map((s) => s.streamId).sort(),
					[...binding.streamIds].sort(),
				);
				const destinations = (actual.outputs ?? []).filter(
					(o) => o.outputId === binding.outputId,
				);
				assert.equal(destinations.length, 1);
				assert.equal(
					destinations[0]?.outputPath?.replace(/^\/+|\/+$/g, ""),
					binding.outputPath,
				);
				const actualOutput =
					binding.output.kind === "S3"
						? await sdk.encoding.outputs.s3.get(binding.outputId)
						: await sdk.encoding.outputs.genericS3.get(binding.outputId);
				assert.equal(actualOutput.id, binding.outputId);
				assert.equal(actualOutput.bucketName, binding.output.bucket);
				const credentials = createCredentialStore(prisma, cipherFromEnv());
				const credential = await credentials.get(binding.output.credentialId);
				assert.ok(credential);
				const credentialConfig = (credential.config ?? {}) as Record<
					string,
					unknown
				>;
				if (binding.output.kind === "GENERIC_S3")
					assert.equal(
						(actualOutput as { host?: string }).host,
						credentialConfig.host,
					);
				const secret = JSON.parse(
					await credentials.revealSecret(binding.output.credentialId),
				);
				controller.signal.throwIfAborted();
				browser = createBrowserForCredential(
					{ provider: credential.provider, config: credentialConfig, secret },
					{
						endpointAllowlist:
							process.env.STORAGE_ENDPOINT_ALLOWED_HOSTS === undefined
								? undefined
								: parseStorageEndpointAllowlist(
										process.env.STORAGE_ENDPOINT_ALLOWED_HOSTS,
									),
						onWarning: () => {},
					},
				);
				assert.ok(browser.headObject && browser.getObject);
				stage = "object-identity";
				const identity = await browser.headObject({
					bucket: binding.output.bucket,
					key: binding.key,
				});
				controller.signal.throwIfAborted();
				assert.ok(
					Number.isSafeInteger(identity.size) &&
						identity.size > 0 &&
						identity.size <= ARCHIVE_MAX_BYTES,
				);
				assert.ok(identity.etag || identity.versionId || identity.generation);
				assert.ok(
					identity.lastModified &&
						Date.parse(identity.lastModified) >= run.createdAt.getTime(),
				);
				controller.signal.throwIfAborted();
				stage = "conditional-read";
				stream = (await browser.getObject({
					bucket: binding.output.bucket,
					key: binding.key,
					expect: {
						etag: identity.etag,
						versionId: identity.versionId,
						generation: identity.generation,
					},
				})) as Readable;
				if (controller.signal.aborted) stream.destroy();
				controller.signal.throwIfAborted();
				stage = "decode";
				const facts = await inspectArchiveBytes(
					stream,
					identity.size,
					binding.codecs,
					controller.signal,
				);
				controller.signal.throwIfAborted();
				return {
					id,
					area: "hygiene",
					verdict: "PASS",
					detail: JSON.stringify({
						liveChannelRunId: run.id,
						encodingId: input.encodingId,
						muxingId: binding.muxingId,
						outputId: binding.outputId,
						checkedAt: new Date().toISOString(),
						objectIdentity: identity,
						...facts,
						privacy: "UNVERIFIED",
						boundary:
							"Exact-run FINISHED, conditional full GET and all planned media decoded. Duration difference is not lip-sync proof.",
					}),
				};
			};
			try {
				checks.push(await Promise.race([perform(), deadline]));
			} catch (error) {
				const toolUnavailable =
					error instanceof Error && "code" in error && error.code === "ENOENT";
				checks.push({
					id,
					area: "hygiene",
					verdict:
						stage === "decode" && !controller.signal.aborted && !toolUnavailable
							? "FAIL"
							: "SKIP",
					detail: `${controller.signal.aborted ? "UNVERIFIED: 120-second archive limit" : `UNVERIFIED: archive ${stage} not established`}; no privacy or lip-sync claim; private details withheld`,
				});
			} finally {
				clearTimeout(timer);
				controller.abort();
				stream?.destroy();
				browser?.dispose?.();
			}
		}
	}
	return checks;
}
