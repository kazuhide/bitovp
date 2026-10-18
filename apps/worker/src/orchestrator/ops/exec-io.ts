/**
 *  half 2: the io cases of executor.ts' 84-case switch,
 * moved VERBATIM. executor.ts keeps every case LABEL (grouped, so its
 * `never` default still proves exhaustiveness and the freeze scan still
 * reads all 84) and dispatches here; this switch narrows the same way the
 * monolithic one did. The default is unreachable by construction.
 */

import type { CompiledOperation } from "@bitovp/core";
import {
	AKAMAI_MSL_VERSION_BEHAVIOR,
	CREDENTIAL_PROVIDER_SHAPES,
} from "@bitovp/core";
import type { StepResult } from "../executor";
import type { SrtConnectionParams } from "../sdk-ops";
import type { ExecStepContext } from "./exec-shared";
import {
	GENERIC_S3_PROVIDERS,
	genericS3Endpoint,
	num,
	optNum,
	optStr,
	requireSecret,
	sigVersionName,
	str,
} from "./exec-shared";

/**
 * . `streamId` + `eventName` ARE the whole identity of an MSL
 * destination, so neither may take the silent fallback that is harmless on a
 * cosmetic field. (This said "MSL has no credential" until 2026-08-25 — false
 * since the 2026-08-19 remodel, and contradicted by the MSL branch further
 * down this file, which resolves an `AKAMAI_MSL` credential and guards its provider.
 * The claim was corrected in `schema.ts` and left standing here and in
 * `template.ts`: fixed where the author was looking, not where it lived.) `str(x)` defaults to `""` and `num(x, 0)`
 * to 0 — both are valid-looking values that address nothing at Akamai, and the
 * encoding would start and write into a void.
 *
 * The plan schema already requires both, so reaching either of these throws
 * means a compiler bug, and the message says which field so it is one grep
 * rather than a bisect (review-4 #6: the first cut guarded streamId and left
 * eventName on the silent-`""` path, which is the same defect wearing a
 * different type).
 */
function requiredStreamId(value: unknown, step: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(
			`step "${step}" has no usable Akamai streamId (got ${JSON.stringify(value)})`,
		);
	}
	return value;
}

function requiredEventName(value: unknown, step: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(
			`step "${step}" has no usable Akamai eventName (got ${JSON.stringify(value)})`,
		);
	}
	return value;
}

export async function executeIoStep(
	op: CompiledOperation,
	ec: ExecStepContext,
): Promise<StepResult> {
	const { ctx, request } = ec;
	const p = op.payload;
	switch (op.kind) {
		case "CREATE_INPUT_S3": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			// review-109pr1 P1 (the review-223 F4 class, ported): every OTHER
			// input creator guards its provider by name; this one built an S3
			// input from ANY credential, and a GCS_HMAC secret's different
			// field names would fall through ?? "" into blank credentials —
			// created at Bitmovin, failing late and vendor-side.
			if (cred.provider !== "AWS_S3") {
				throw new Error(
					`step "${op.step}" needs an AWS_S3 credential but got provider "${cred.provider}"`,
				);
			}
			const resourceId = await ctx.sdk.createS3Input({
				name: str(p.name),
				bucketName: str(p.bucketName),
				accessKey: cred.secret.accessKeyId ?? "",
				secretKey: cred.secret.secretAccessKey ?? "",
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_INPUT_AZURE": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "AZURE_BLOB") {
				throw new Error(
					`step "${op.step}" needs an AZURE_BLOB credential but got provider "${cred.provider}"`,
				);
			}
			const resourceId = await ctx.sdk.createAzureInput({
				name: str(p.name),
				container: str(p.container),
				accountName: str(cred.config.accountName),
				accountKey: cred.secret.accountKey ?? "",
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_INPUT_HTTPS": {
			// Host-only — public HTTPS inputs carry no credential.
			const resourceId = await ctx.sdk.createHttpsInput({
				name: str(p.name),
				host: str(p.host),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_INPUT_GENERIC_S3": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (!GENERIC_S3_PROVIDERS.has(cred.provider)) {
				throw new Error(
					`step "${op.step}" needs an Akamai/OCI/GenericS3 credential but got provider "${cred.provider}"`,
				);
			}
			const endpoint = genericS3Endpoint(cred, op.step);
			const resourceId = await ctx.sdk.createGenericS3Input({
				name: str(p.name),
				bucketName: str(p.bucketName),
				host: endpoint.host,
				port: endpoint.port,
				ssl: endpoint.ssl,
				signatureVersion: sigVersionName(endpoint.signatureVersion),
				accessKey: requireSecret(cred, "accessKeyId", op.step, "Generic S3"),
				secretKey: requireSecret(
					cred,
					"secretAccessKey",
					op.step,
					"Generic S3",
				),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_INPUT_GCS": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "GCS_HMAC") {
				throw new Error(
					`step "${op.step}" needs a GCS_HMAC credential but got provider "${cred.provider}"`,
				);
			}
			const resourceId = await ctx.sdk.createGcsInput({
				name: str(p.name),
				bucketName: str(p.bucketName),
				cloudRegion: optStr(p.cloudRegion),
				// GCS-HMAC secret keys are { accessKey, secret } (not accessKeyId).
				accessKey: requireSecret(cred, "accessKey", op.step, "GCS HMAC"),
				secretKey: requireSecret(cred, "secret", op.step, "GCS HMAC"),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_INPUT_GCS_SERVICE_ACCOUNT": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "GCS_SERVICE_ACCOUNT") {
				throw new Error(
					`step "${op.step}" needs a GCS_SERVICE_ACCOUNT credential but got provider "${cred.provider}"`,
				);
			}
			const resourceId = await ctx.sdk.createGcsServiceAccountInput({
				name: str(p.name),
				bucketName: str(p.bucketName),
				cloudRegion: optStr(p.cloudRegion),
				serviceAccountCredentials: requireSecret(
					cred,
					"serviceAccountJson",
					op.step,
					"GCS service account",
				),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_OUTPUT_S3": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "AWS_S3") {
				throw new Error(
					`step "${op.step}" needs an AWS_S3 credential but got provider "${cred.provider}"`,
				);
			}
			const resourceId = await ctx.sdk.createS3Output({
				name: str(p.name),
				bucketName: str(p.bucketName),
				accessKey: cred.secret.accessKeyId ?? "",
				secretKey: cred.secret.secretAccessKey ?? "",
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_OUTPUT_AZURE": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "AZURE_BLOB") {
				throw new Error(
					`step "${op.step}" needs an AZURE_BLOB credential but got provider "${cred.provider}"`,
				);
			}
			const resourceId = await ctx.sdk.createAzureOutput({
				name: str(p.name),
				container: str(p.container),
				accountName: str(cred.config.accountName),
				accountKey: cred.secret.accountKey ?? "",
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_OUTPUT_SFTP": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "SFTP") {
				throw new Error(
					`step "${op.step}" needs an SFTP credential but got provider "${cred.provider}"`,
				);
			}
			const resourceId = await ctx.sdk.createSftpOutput({
				name: str(p.name),
				host: str(cred.config.host),
				port: num(cred.config.port, 22),
				username: str(cred.config.username),
				password: cred.secret.password ?? "",
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_INPUT_AKAMAI_NETSTORAGE":
		case "CREATE_OUTPUT_AKAMAI_NETSTORAGE": {
			// . One branch for both directions: the SDK's input and
			// output models carry the identical three fields, so splitting them
			// would be two copies of one mapping.
			const cred = await ctx.resolveCredential(str(p.credentialId));
			// `cred.config.host` reads a host off ANY provider's config, so an
			// S3 credential picked by mistake would send its endpoint as a
			// NetStorage host and fail somewhere unrecognisable. This comment
			// used to add "the check the SFTP branch above does NOT do, and
			// should" — that gap stayed open until audit AA972-CONTRACT-001
			// found it (along with Azure in, S3/Azure out); SFTP guards itself
			// now, and `no credential-backed IO op reaches the vendor with a
			// mismatched credential` in executor.test.ts derives the population
			// from OPERATION_KINDS so the next such branch cannot be added
			// unclassified.
			if (cred.provider !== "AKAMAI_NETSTORAGE") {
				throw new Error(
					`step "${op.step}" needs an AKAMAI_NETSTORAGE credential but got provider "${cred.provider}"`,
				);
			}
			const payload = {
				name: str(p.name),
				host: str(cred.config.host),
				username: str(cred.config.username),
				// requireSecret, not `?? ""`: an empty password authenticates
				// as nobody, and the request would fail with a message about
				// permissions rather than about a missing secret (the same
				// reasoning as #137's streamId and eventName refusals).
				password: requireSecret(cred, "password", op.step, "NetStorage"),
			};
			const resourceId =
				op.kind === "CREATE_INPUT_AKAMAI_NETSTORAGE"
					? await ctx.sdk.createAkamaiNetStorageInput(payload)
					: await ctx.sdk.createAkamaiNetStorageOutput(payload);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_OUTPUT_GENERIC_S3": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (!GENERIC_S3_PROVIDERS.has(cred.provider)) {
				throw new Error(
					`step "${op.step}" needs an Akamai/OCI/GenericS3 credential but got provider "${cred.provider}"`,
				);
			}
			const endpoint = genericS3Endpoint(cred, op.step);
			const resourceId = await ctx.sdk.createGenericS3Output({
				name: str(p.name),
				bucketName: str(p.bucketName),
				host: endpoint.host,
				port: endpoint.port,
				ssl: endpoint.ssl,
				signatureVersion: sigVersionName(endpoint.signatureVersion),
				accessKey: requireSecret(cred, "accessKeyId", op.step, "Generic S3"),
				secretKey: requireSecret(
					cred,
					"secretAccessKey",
					op.step,
					"Generic S3",
				),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_OUTPUT_GCS": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "GCS_HMAC") {
				throw new Error(
					`step "${op.step}" needs a GCS_HMAC credential but got provider "${cred.provider}"`,
				);
			}
			const resourceId = await ctx.sdk.createGcsOutput({
				name: str(p.name),
				bucketName: str(p.bucketName),
				cloudRegion: optStr(p.cloudRegion),
				accessKey: requireSecret(cred, "accessKey", op.step, "GCS HMAC"),
				secretKey: requireSecret(cred, "secret", op.step, "GCS HMAC"),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_OUTPUT_LIVE_MEDIA_INGEST": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "LIVE_MEDIA_INGEST")
				throw new Error(
					`step "${op.step}" needs a LIVE_MEDIA_INGEST credential but got provider "${cred.provider}"`,
				);
			const secret = CREDENTIAL_PROVIDER_SHAPES.LIVE_MEDIA_INGEST.secret.parse(
				cred.secret,
			);
			const resourceId = await ctx.sdk.createLiveMediaIngestOutput({
				name: str(p.name),
				publishingPoint: secret.publishingPoint,
				...(typeof p.scte35Passthrough === "boolean"
					? { scte35Passthrough: p.scte35Passthrough }
					: {}),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_OUTPUT_AKAMAI_MSL": {
			// , remodelled 2026-08-19: the provisioned streamId and
			// eventName come from an AKAMAI_MSL vault credential. The first cut
			// carried them inline because MSL has no password — but you cannot
			// obtain either without an Akamai account, which makes them
			// account-scoped facts, and treating MSL as the one credential-less
			// output is what kept it off the credential-first output step.
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "AKAMAI_MSL") {
				throw new Error(
					`step "${op.step}" needs an AKAMAI_MSL credential but got provider "${cred.provider}"`,
				);
			}
			/*
			 * MSL5 publishing auth —  PR 2.
			 *
			 * `enabled` is DERIVED and never stored: presence of a resolved
			 * pair is the only source of truth, so there is no state where a
			 * flag and a credential can disagree (security F3). The object is
			 * OMITTED entirely otherwise, which the SDK documents as publishing
			 * unauthenticated — legal, and rail 3b warns about it at submit.
			 *
			 * MSL4 never gets the field, and that is a REFUSAL upstream rather
			 * than an ignore. The vendor's own test asserts the message:
			 * "The MSL5-only field publishingAuthentication cannot be set on
			 * MSL4 outputs", thrown. So the version check is what keeps a
			 * migrated credential — one legitimately carrying a pair while its
			 * output is still MSL4, which is the normal mid-migration state —
			 * from turning into a 400.
			 *
			 * The AND guard is POIS's, not ZIXI's: a half pair must throw, not
			 * send one half. The credential schema already refuses to STORE
			 * one, so this is the second lock — and the one that still holds if
			 * a row predates the refine.
			 */
			const digestUser = cred.secret.username;
			const digestPass = cred.secret.password;
			if (Boolean(digestUser) !== Boolean(digestPass)) {
				throw new Error(
					`step "${op.step}": AKAMAI_MSL credential carries only half a Digest pair — Bitmovin rejects a username without a password`,
				);
			}
			/*
			 * DERIVED from the anchor, not `!== "MSL4"` — review of PR #319, and
			 * the asymmetry it named was real: rail 3b already derives this
			 * exact fact from `AKAMAI_MSL_VERSION_BEHAVIOR`, while the ONE site
			 * that actually talks to Bitmovin hardcoded the version name.
			 *
			 * It also failed toward SENDING. `str` returns "" for a non-string
			 * and this executor replays PERSISTED payloads under
			 * `z.record(z.string, z.unknown)`, so an absent `mslVersion`
			 * gave `"" !== "MSL4"` → true → the MSL5-only field sent on a
			 * version we cannot identify. Unknown now reads as FORBIDDEN, which
			 * is the safe direction, and a future MSL6 becomes a tsc error at
			 * the wire too — the whole point of having the Record.
			 *
			 * Not a live bug today: both compilers gained `mslVersion` in the
			 * same commit that added AKAMAI_MSL at all, so no persisted payload
			 * can lack it. Hardening, and the reviewer derived that
			 * independently rather than taking my word.
			 */
			const versionBehavior =
				AKAMAI_MSL_VERSION_BEHAVIOR[
					str(p.mslVersion) as keyof typeof AKAMAI_MSL_VERSION_BEHAVIOR
				];
			const wantsAuth =
				versionBehavior?.publishingAuth !== undefined &&
				versionBehavior.publishingAuth !== "FORBIDDEN" &&
				Boolean(digestUser && digestPass);
			const resourceId = await ctx.sdk.createAkamaiMslOutput({
				name: str(p.name),
				// The refusals stay: a `num(x, 0)` fallback would address
				// stream 0, and `str(x)` would send a nameless event — both
				// valid-looking values pointing at nothing.
				streamId: requiredStreamId(cred.config.streamId, op.step),
				eventName: requiredEventName(cred.config.eventName, op.step),
				streamFormat: str(p.streamFormat),
				mslVersion: str(p.mslVersion),
				...(wantsAuth
					? {
							publishingAuthentication: {
								enabled: true,
								username: String(digestUser),
								password: String(digestPass),
							},
						}
					: {}),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_OUTPUT_GCS_SERVICE_ACCOUNT": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "GCS_SERVICE_ACCOUNT") {
				throw new Error(
					`step "${op.step}" needs a GCS_SERVICE_ACCOUNT credential but got provider "${cred.provider}"`,
				);
			}
			const resourceId = await ctx.sdk.createGcsServiceAccountOutput({
				name: str(p.name),
				bucketName: str(p.bucketName),
				cloudRegion: optStr(p.cloudRegion),
				serviceAccountCredentials: requireSecret(
					cred,
					"serviceAccountJson",
					op.step,
					"GCS service account",
				),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_INPUT_RTMP": {
			// : a plan can PIN a specific RTMP input id (accounts may
			// carry several). Pinned ⇒ use it verbatim, no listing at all — the
			// list call is what forces the single-input restriction below.
			const pinnedInputId = optStr(p.inputId);
			if (pinnedInputId) {
				return {
					resourceId: pinnedInputId,
					request,
					response: { id: pinnedInputId, resolved: "plan-pinned" },
				};
			}
			// Resolve-by-list contract: the API has no POST /encoding/inputs/rtmp
			// — accounts come pre-provisioned with a default RTMP input.
			const inputs = await ctx.sdk.listRtmpInputs();
			const first = inputs[0];
			if (!first) {
				throw new Error(
					`step "${op.step}": the Bitmovin account has no RTMP input to resolve — RTMP inputs are account-provisioned (contact Bitmovin) or use a REDUNDANT_RTMP/SRT input instead`,
				);
			}
			if (inputs.length > 1) {
				// Resolve-by-list is only deterministic with exactly one input
				// — silently picking inputs[0] would bind the channel to an
				// arbitrary ingest endpoint (list order is not contractual).
				const ids = inputs.map((input) => input.id).join(", ");
				throw new Error(
					`step "${op.step}": the Bitmovin account has ${inputs.length} RTMP inputs (${ids}) — resolve-by-list needs exactly one; pin one in the wizard's RTMP input id field (liveInput.inputId) or use REDUNDANT_RTMP/SRT`,
				);
			}
			return {
				resourceId: first.id,
				request,
				response: {
					id: first.id,
					resolved: "account-default",
					available: inputs.length,
				},
			};
		}

		case "CREATE_INPUT_REDUNDANT_RTMP": {
			const resourceId = await ctx.sdk.createRedundantRtmpInput({
				name: str(p.name),
				delayThreshold: optNum(p.delayThreshold),
				ingestPoints: p.ingestPoints as
					| { applicationName: string; streamKey: string }[]
					| undefined,
				staticIngestPoints: p.staticIngestPoints as
					| {
							name?: string;
							streamKeyConfiguration?: { type: string; streamKeyId?: string };
					  }[]
					| undefined,
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_INPUT_SRT": {
			// Vault SRT passphrases resolve here, at execution only — the
			// payload carries credentialId refs, never the passphrase, and the
			// snapshot is op.payload (still refs-only).
			type SrtConnectionPayload = {
				mode?: unknown;
				host?: unknown;
				port?: unknown;
				path?: unknown;
				latency?: unknown;
				credentialId?: unknown;
				keyLength?: unknown;
			};
			const resolveConnection = async (
				c: SrtConnectionPayload,
			): Promise<SrtConnectionParams> => {
				let passphrase: string | undefined;
				if (c.credentialId !== undefined) {
					const cred = await ctx.resolveCredential(str(c.credentialId));
					if (cred.provider !== "SRT_PASSPHRASE") {
						throw new Error(
							`step "${op.step}" needs an SRT_PASSPHRASE credential but got provider "${cred.provider}"`,
						);
					}
					passphrase = cred.secret.passphrase;
					if (!passphrase) {
						// Never fall back to "" — an empty passphrase fails open.
						throw new Error(
							`step "${op.step}": SRT_PASSPHRASE credential carries no passphrase`,
						);
					}
					const keyLength = optNum(c.keyLength);
					if (keyLength !== undefined) {
						// AES-128 derives from 16 chars, AES-256 from 32 — a vault/
						// plan mismatch would fail opaquely at the encoder.
						const expected = keyLength === 128 ? 16 : 32;
						if (passphrase.length !== expected) {
							throw new Error(
								`step "${op.step}": keyLength ${keyLength} needs a ${expected}-char passphrase but the vaulted one has ${passphrase.length} chars`,
							);
						}
					}
				}
				return {
					mode: str(c.mode),
					host: optStr(c.host),
					port: num(c.port, 0),
					path: optStr(c.path),
					latency: optNum(c.latency),
					passphrase,
					keyLength: optNum(c.keyLength),
				};
			};
			const backup = p.backupSrtInputs as
				| { delayThreshold?: number; srtInputs?: SrtConnectionPayload[] }
				| undefined;
			const resourceId = await ctx.sdk.createSrtInput({
				name: str(p.name),
				...(await resolveConnection(p as SrtConnectionPayload)),
				...(backup
					? {
							backupSrtInputs: {
								delayThreshold: optNum(backup.delayThreshold),
								srtInputs: await Promise.all(
									(backup.srtInputs ?? []).map(resolveConnection),
								),
							},
						}
					: {}),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_INPUT_ZIXI": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "ZIXI") {
				throw new Error(
					`step "${op.step}" needs a ZIXI credential but got provider "${cred.provider}"`,
				);
			}
			const password = cred.secret.password;
			const decryptionKey = cred.secret.decryptionKey;
			if (!password && !decryptionKey) {
				// Never fall back to "" — an unauthenticated input fails open.
				throw new Error(
					`step "${op.step}": ZIXI credential carries neither password nor decryptionKey`,
				);
			}
			const resourceId = await ctx.sdk.createZixiInput({
				name: str(p.name),
				host: str(p.host),
				port: num(p.port, 0),
				stream: str(p.stream),
				password: password || undefined,
				decryptionKey: decryptionKey || undefined,
				latency: optNum(p.latency),
				minBitrate: optNum(p.minBitrate),
				decryptionType: optStr(p.decryptionType),
			});
			return { resourceId, request, response: { id: resourceId } };
		}
		default:
			throw new Error(
				`executeIoStep: unhandled kind ${String(op.kind)} — the executor dispatch and this switch have diverged`,
			);
	}
}
