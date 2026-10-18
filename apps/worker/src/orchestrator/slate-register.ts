import {
	compareSlateCompatibility,
	feederError,
	normalizeSlateInputPath,
	SLATE_SUPPORTED_PROVIDERS,
	type SlateConversionDestination,
	type SlateSource,
	slateImageDifference,
	slatePositionDifference,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import type { MediaAttributes, ProbeResult } from "../feeder/command";
import type { SlatePreparer } from "../slate/prepare";
import {
	GENERIC_S3_PROVIDERS,
	genericS3Endpoint,
	sigVersionName,
} from "./ops/exec-shared";
import type { SdkOps } from "./sdk-ops";

/**
 * Deferred slate-content registration .
 *
 * A creation-time SLATE_IN row carries a SOURCE (credential/bucket/key), not
 * a content id: insertable content is a per-ENCODING resource and no encoding
 * existed at creation. The scheduler sweep claims the row (`contentClaimedAt`
 * CAS) once the channel is RUNNING and enqueues `register-slate-content`;
 * this module is the processor side.
 *
 * It writes `insertableContentId` only when the content is READY, which is
 * the whole protocol: the sweep's fire path treats "no content id yet" as
 * WAIT, so readiness never needs a second check anywhere.
 *
 * Idempotency has two layers, in line with tonight's non-idempotent-action
 * findings: the enqueue is deduped by BullMQ job id (`sched-content-<row>`),
 * and the CONTENT is adopted by name (`slate:<scheduleId>`) before being
 * created — so a redelivery after a lost response finds the first attempt's
 * content instead of minting a duplicate. The INPUT is account-scoped and
 * deliberately re-created on retry ('s documented trade for
 * account-scoped resources): a duplicate input is inert; a duplicate slate
 * INSERT on air would not be.
 */

export type ResolvedSlateCredential = {
	provider: string;
	config: Record<string, unknown>;
	secret: Record<string, string>;
};

export type SlateRegisterDeps = {
	prisma: AppPrismaClient;
	sdk: SdkOps;
	resolveCredential(credentialId: string): Promise<ResolvedSlateCredential>;
	now(): Date;
	sleep(ms: number): Promise<void>;
	pollIntervalMs: number;
	/** Durable claim re-check immediately before each provider mutation. */
	beforeProviderMutation?: () => Promise<void>;
	/** Ceiling for content processing; past it the claim is RELEASED. */
	registrationTimeoutMs?: number;
	/**
	 *  — what the live encoder is currently ingesting, so the
	 * slate can be checked against Bitmovin's own documented match rule
	 * before a content resource exists. Null when the run has no reference
	 * (an external ingest that has never reported a heartbeat), and the
	 * check then stands down.
	 */
	ingestMedia?: MediaAttributes | null;
	/**
	 * Bounded ffprobe over the slate object (`createBoundedObjectProbe`).
	 * BEST-EFFORT by contract: `null` means "not measured", never "bad", and
	 * registration then proceeds exactly as it did before the check existed.
	 */
	probeSlateSource?: (source: SlateSource) => Promise<ProbeResult | null>;
	/**
	 * : the preparer that makes the clip match the ingest (a still or
	 * a matching MPEG-TS passes through; anything else is transcoded to an
	 * MPEG-TS next to the source — `apps/worker/src/slate/prepare.ts`). When
	 * present it REPLACES the refuse-on-mismatch check: a mismatch is now
	 * something to fix, only a clip that cannot be read or has no video is
	 * refused, and a movie with no ingest reference yet WAITS for the input
	 * (claim released, next tick retries). Absent = the pre-#330 behaviour.
	 */
	prepareSlate?: SlatePreparer;
	/**
	 * Where the preparer writes a converted file (`slateConversionDestination`
	 * of the channel's plan); null = next to the source.
	 */
	conversionDestination?: SlateConversionDestination | null;
};

export const DEFAULT_REGISTRATION_TIMEOUT_MS = 10 * 60_000;

/** Content and input names — the adopt key, so they must stay stable. */
export function slateContentName(scheduleId: string): string {
	return `slate:${scheduleId}`;
}

/**
 * The marker a stood-down preflight leaves behind — on the schedule row's
 * `note` here, on the provider content's `description` when the direct
 * route registered the content — so the fire path's verdict can name it
 * when the insertion later fails (`preflightUnverifiedReason`). One
 * spelling, shared by the writers and the reader.
 */
export const PREFLIGHT_UNVERIFIED_MARKER = "preflight UNVERIFIED";

/**
 * Pull the stood-down reason out of a note or description that carries the
 * marker: `… preflight UNVERIFIED (no ingest reference) …` → `no ingest
 * reference`. Null when the text carries no marker.
 */
export function preflightUnverifiedReason(
	text: string | null | undefined,
): string | null {
	if (typeof text !== "string") {
		return null;
	}
	const at = text.indexOf(PREFLIGHT_UNVERIFIED_MARKER);
	if (at < 0) {
		return null;
	}
	const rest = text.slice(at + PREFLIGHT_UNVERIFIED_MARKER.length).trim();
	const match = /^\(([^)]*)\)/.exec(rest);
	return match?.[1]?.trim() || "reason not recorded";
}

function slateInputName(label: string): string {
	return `slate-src:${label}`;
}

/**
 * Create the Bitmovin input for the slate's source bucket, per provider —
 * the same mapping the VOD executor uses (`exec-io.ts`), against the same
 * vaulted credential shape. Unsupported providers return a reason instead of
 * throwing: the row records WHY, and the operator re-arms with a supported
 * source rather than spelunking a queue error.
 */
export async function createSourceInput(
	deps: Pick<
		SlateRegisterDeps,
		"resolveCredential" | "sdk" | "beforeProviderMutation"
	>,
	/** The schedule row id, or  the SlateNormalization row id. */
	label: string,
	source: SlateSource,
): Promise<{ inputId: string } | { inputId: null; reason: string }> {
	const cred = await deps.resolveCredential(source.credentialId);
	const name = slateInputName(label);
	const step = `slate:${label}`;
	// review-223b minor: a MISSING secret field is as deterministic as an
	// unsupported driver — re-running cannot conjure it, only re-vaulting can,
	// and re-vaulting comes with an operator who can re-arm. Refuse by NAME
	// and keep the claim, instead of throwing into the transient path where
	// the sweep would re-resolve + re-LIST every 30s for the whole window.
	const missingSecret = (field: string, label: string) =>
		cred.secret[field]
			? null
			: {
					inputId: null as null,
					reason: `${label} credential carries no ${field}`,
				};
	switch (cred.provider) {
		case "AWS_S3": {
			// review-223 F4: `?? ""` sent EMPTY credentials to the API and let
			// Bitmovin's 4xx name the problem — the refusal names the field
			// here, where the row's error can say something actionable.
			const refused =
				missingSecret("accessKeyId", "S3") ??
				missingSecret("secretAccessKey", "S3");
			if (refused) {
				return refused;
			}
			await deps.beforeProviderMutation?.();
			const inputId = await deps.sdk.createS3Input({
				name,
				bucketName: source.bucket,
				accessKey: cred.secret.accessKeyId as string,
				secretKey: cred.secret.secretAccessKey as string,
			});
			return { inputId };
		}
		case "GENERIC_S3":
		case "AKAMAI_OBJECT_STORAGE":
		case "OCI_OBJECT_STORAGE": {
			if (!GENERIC_S3_PROVIDERS.has(cred.provider)) {
				return {
					inputId: null,
					reason: `provider ${cred.provider} is not S3-compatible`,
				};
			}
			const refused =
				missingSecret("accessKeyId", "Generic S3") ??
				missingSecret("secretAccessKey", "Generic S3");
			if (refused) {
				return refused;
			}
			const endpoint = genericS3Endpoint(cred, step);
			await deps.beforeProviderMutation?.();
			const inputId = await deps.sdk.createGenericS3Input({
				name,
				bucketName: source.bucket,
				host: endpoint.host,
				port: endpoint.port,
				ssl: endpoint.ssl,
				signatureVersion: sigVersionName(endpoint.signatureVersion),
				accessKey: cred.secret.accessKeyId as string,
				secretKey: cred.secret.secretAccessKey as string,
			});
			return { inputId };
		}
		case "GCS_HMAC": {
			const refused =
				missingSecret("accessKey", "GCS HMAC") ??
				missingSecret("secret", "GCS HMAC");
			if (refused) {
				return refused;
			}
			await deps.beforeProviderMutation?.();
			const inputId = await deps.sdk.createGcsInput({
				name,
				bucketName: source.bucket,
				accessKey: cred.secret.accessKey as string,
				secretKey: cred.secret.secret as string,
			});
			return { inputId };
		}
		case "AZURE_BLOB": {
			const accountName = cred.config.accountName;
			if (typeof accountName !== "string" || accountName.length === 0) {
				return {
					inputId: null,
					reason: "Azure credential carries no accountName",
				};
			}
			const refused = missingSecret("accountKey", "Azure");
			if (refused) {
				return refused;
			}
			await deps.beforeProviderMutation?.();
			const inputId = await deps.sdk.createAzureInput({
				name,
				container: source.bucket,
				accountName,
				accountKey: cred.secret.accountKey as string,
			});
			return { inputId };
		}
		default:
			// Backstop only: the wizard's picker and the creation route both
			// enforce SLATE_SUPPORTED_PROVIDERS, so reaching this means a row
			// predates the 422 check or was written around the API.
			return {
				inputId: null,
				reason: `slate source provider ${cred.provider} is not supported for insertable content (supported: ${SLATE_SUPPORTED_PROVIDERS.join(", ")})`,
			};
	}
}

export type SlateRegisterResult =
	| { outcome: "REGISTERED"; insertableContentId: string }
	| { outcome: "SKIPPED"; reason: string }
	| { outcome: "FAILED"; reason: string }
	| { outcome: "RELEASED"; reason: string };

/**
 * Register + wait READY + link the row. Every terminal path writes its
 * reason onto the row, because the operator's view IS the row.
 */
export async function registerSlateContent(
	deps: SlateRegisterDeps,
	args: { scheduleId: string; source: SlateSource; encodingId: string },
): Promise<SlateRegisterResult> {
	const row = await deps.prisma.liveSchedule.findUnique({
		where: { id: args.scheduleId },
		select: { id: true, status: true, insertableContentId: true },
	});
	if (!row) {
		return { outcome: "SKIPPED", reason: "schedule row no longer exists" };
	}
	if (row.insertableContentId) {
		return { outcome: "SKIPPED", reason: "content already registered" };
	}
	if (row.status !== "ARMED") {
		return { outcome: "SKIPPED", reason: `row is ${row.status}, not ARMED` };
	}

	try {
		return await registerAndLink(deps, args);
	} catch (err) {
		// review-223 F4: a thrown SDK/credential error left the row SILENT —
		// claimed, no note, no error — until the F2 window closed. Throws are
		// treated as transient: the reason lands on the row and the claim is
		// RELEASED, so the next sweep tick retries (adopt-by-name makes that a
		// resume) and the slate window, not the queue, stays the deadline.
		// Deterministic refusals (unsupported driver, content ERROR) return
		// FAILED above instead and KEEP the claim — retrying cannot fix those.
		const reason = `slate registration failed: ${err instanceof Error ? err.message : String(err)}`;
		await deps.prisma.liveSchedule.updateMany({
			where: { id: args.scheduleId, insertableContentId: null },
			data: { contentClaimedAt: null, note: reason },
		});
		return { outcome: "RELEASED", reason };
	}
}

/**
 * Does this slate clip match what the encoder is playing it into?
 *
 * The rule is Bitmovin's, quoted from the SDK's own `InsertableContent`
 * model (generated from the OpenAPI spec, so it is the authoritative
 * statement of the contract):
 *
 *   "The movie files must have a video stream at stream position 0, which
 *    matches the codec, resolution and framerate of the livestream. The
 *    number of audio streams must also be the same and they have to match
 *    the sample format, number of channels and sample rate of the audio
 *    streams of the livestream."
 *
 * Nothing checked it. Registration verified the credential, the provider and
 * that the content reached READY — and READY is not a match: Bitmovin
 * validates the attributes at INSERT time, which is why the 2026-08-29 paid
 * run (audit §3.3) had content READY, a schedule FIRED and a provider entry
 * that went ERROR while our own timeline read as success and the programme
 * segments never changed.
 *
 * The rule itself is `compareSlateCompatibility` in `@bitovp/core` (C36):
 * one table shared with the direct registration route, so a slate armed at
 * channel creation and one registered from the channel page are held to the
 * same verdict. Bitmovin plays the clip AS IT IS — there is no re-encode
 * between the object and the live stream — so nothing is normalisable and
 * every attribute difference in that table blocks.
 *
 * Conservative on every axis. No reference (nothing recorded, no heartbeat)
 * or no probe (unsupported provider, an endpoint that ignores byte ranges, a
 * clip whose index sits past the bounded window) means NO opinion — the
 * registration proceeds, and SAYS SO: the stand-down reason is returned as
 * `unverified` and lands on the row's note as `preflight UNVERIFIED (…)`, so
 * a later insert failure can be connected to the check that never ran. Only
 * a measured, provable mismatch refuses, and it refuses BEFORE the Bitmovin
 * input and content are created, so a rejected slate leaves nothing behind
 * at the provider.
 */
async function slateIngestMismatch(
	deps: SlateRegisterDeps,
	source: SlateSource,
): Promise<{
	error: string | null;
	unverified: string | null;
	/** What an OK verdict actually compared — named on the row (rev406 R1). */
	compared: string[];
	notComparable: string[];
}> {
	const none = { compared: [], notComparable: [] };
	const reference = deps.ingestMedia;
	if (!reference) {
		return { error: null, unverified: "no ingest reference", ...none };
	}
	if (!deps.probeSlateSource) {
		return { error: null, unverified: "no probe available", ...none };
	}
	const probe = await deps.probeSlateSource(source);
	if (!probe) {
		return { error: null, unverified: "clip could not be probed", ...none };
	}
	const result = compareSlateCompatibility(reference, probe);
	if (result.ok) {
		return {
			error: null,
			unverified:
				result.standDown === "NO_COMPARABLE_ATTRIBUTE"
					? "no comparable attribute in the ingest reference"
					: null,
			compared: result.compared,
			notComparable: result.notComparable,
		};
	}
	// A still image (C36) is admitted since : unreachable while
	// SLATE_ALLOW_IMAGES is true, kept as the translator for older rows.
	if (slateImageDifference(result) !== undefined) {
		return { error: feederError("slateImage"), unverified: null, ...none };
	}
	// "a video stream at stream position 0" — positional, and the one rule in
	// the contract that is about layout rather than attributes. :
	// structured so the schedule panel translates the sentence; `found` names
	// what sits at position 0 instead of video.
	const position = slatePositionDifference(result);
	if (position !== undefined) {
		return {
			error: feederError("slatePosition", { found: position.candidate }),
			unverified: null,
			...none,
		};
	}
	// : store typed differences for localized attribute labels. Only
	// the BLOCKING rows are listed: a reported-only row (the container, per the
	// 2026-09-02 A/B) is not why the slate was refused.
	return {
		error: feederError(
			"slateMismatch",
			{},
			result.differences.filter((d) => d.blocking),
		),
		unverified: null,
		...none,
	};
}

async function registerAndLink(
	deps: SlateRegisterDeps,
	args: { scheduleId: string; source: SlateSource; encodingId: string },
): Promise<SlateRegisterResult> {
	// Adopt before create: a redelivery whose first attempt lost its response
	// must find that attempt's content, not mint a second.
	const name = slateContentName(args.scheduleId);
	let contentId: string | null = null;
	let unverified: string | null = null;
	let scope: string | null = null;
	const existing = await deps.sdk.listLiveInsertableContent(args.encodingId);
	const adopted = existing.find((item) => item.name === name);
	if (adopted) {
		contentId = adopted.id;
	} else {
		// : PREPARE before anything is created at the provider — a
		// matching MPEG-TS or a still passes through, anything else is
		// transcoded to match the ingest, and a movie with no reference yet
		// WAITS for the input. Without a preparer the pre-#330 check runs:
		// a measured mismatch refuses . An adopted content skips
		// both — that attempt already passed this gate.
		let registerSource: SlateSource = args.source;
		if (deps.prepareSlate) {
			const prepared = await deps.prepareSlate({
				label: args.scheduleId,
				source: args.source,
				ingest: deps.ingestMedia ?? null,
				destination: deps.conversionDestination ?? null,
			});
			if (prepared.kind === "WAIT") {
				// Transient by nature: the claim is RELEASED so the next sweep
				// tick retries, and the slate window stays the deadline.
				const reason = `slate not registered yet: ${prepared.note}`;
				await deps.prisma.liveSchedule.updateMany({
					where: { id: args.scheduleId, insertableContentId: null },
					data: { contentClaimedAt: null, note: reason },
				});
				return { outcome: "RELEASED", reason };
			}
			if (prepared.kind === "REFUSED") {
				const reason = `slate cannot be prepared: ${prepared.reason}`;
				await deps.prisma.liveSchedule.updateMany({
					where: { id: args.scheduleId, status: "ARMED" },
					data: { error: reason },
				});
				// Deterministic — keep the claim, exactly like an unsupported driver.
				return { outcome: "FAILED", reason };
			}
			registerSource = prepared.source;
			scope = prepared.note;
		} else {
			const check = await slateIngestMismatch(deps, args.source);
			if (check.error) {
				await deps.prisma.liveSchedule.updateMany({
					where: { id: args.scheduleId, status: "ARMED" },
					data: { error: check.error },
				});
				// Deterministic, exactly like an unsupported driver: retrying
				// cannot make a 25 fps clip 29.97. Keep the claim.
				return { outcome: "FAILED", reason: check.error };
			}
			unverified = check.unverified;
			if (unverified === null && check.compared.length > 0) {
				// An OK is a statement about what was compared — a heartbeat
				// reference cannot see profile, level, pixel format or channels.
				scope = `preflight OK on ${check.compared.join(", ")}${
					check.notComparable.length > 0
						? `; not comparable: ${check.notComparable.join(", ")}`
						: ""
				}`;
			}
		}
		const input = await createSourceInput(
			deps,
			args.scheduleId,
			registerSource,
		);
		if (input.inputId === null) {
			await deps.prisma.liveSchedule.updateMany({
				where: { id: args.scheduleId, status: "ARMED" },
				data: { error: input.reason },
			});
			// Keep the claim: a retry cannot make an unsupported driver
			// supported, and the grace machinery bounds the wait either way.
			return { outcome: "FAILED", reason: input.reason };
		}
		await deps.beforeProviderMutation?.();
		contentId = await deps.sdk.createLiveInsertableContent(args.encodingId, {
			name,
			// The key as the object store names it — the same normalisation the
			// direct route applies to a typed path (C36).
			inputs: [
				{
					inputId: input.inputId,
					inputPath: normalizeSlateInputPath(registerSource.key).path,
				},
			],
		});
	}

	// Wait for READY — the write below is the fire path's readiness gate.
	const timeoutMs =
		deps.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS;
	const startedAt = deps.now().getTime();
	for (;;) {
		const content = await deps.sdk.getLiveInsertableContent(
			args.encodingId,
			contentId,
		);
		if (content.status === "READY") {
			break;
		}
		if (content.status === "ERROR") {
			const reason = `slate content processing failed (${contentId})`;
			await deps.prisma.liveSchedule.updateMany({
				where: { id: args.scheduleId, status: "ARMED" },
				data: { error: reason },
			});
			return { outcome: "FAILED", reason };
		}
		if (deps.now().getTime() - startedAt > timeoutMs) {
			const reason = `slate content not READY after ${Math.round(timeoutMs / 60_000)}m (${contentId})`;
			// RELEASE the claim — the next sweep tick re-registers, and the
			// adopt-by-name above turns that into a resume, not a duplicate.
			await deps.prisma.liveSchedule.updateMany({
				where: { id: args.scheduleId, insertableContentId: null },
				data: { contentClaimedAt: null, note: reason },
			});
			return { outcome: "RELEASED", reason };
		}
		await deps.sleep(deps.pollIntervalMs);
	}

	const linked = await deps.prisma.liveSchedule.updateMany({
		where: { id: args.scheduleId, status: "ARMED" },
		data: {
			insertableContentId: contentId,
			// The stood-down check is written where the fire path reads it
			// back (`preflightUnverifiedReason`) when the insertion fails.
			note:
				unverified !== null
					? `slate content registered (${contentId}); ${PREFLIGHT_UNVERIFIED_MARKER} (${unverified})`
					: scope !== null
						? `slate content registered (${contentId}); ${scope}`
						: `slate content registered (${contentId})`,
		},
	});
	if (linked.count === 0) {
		return {
			outcome: "SKIPPED",
			reason: "row left ARMED while content was processing",
		};
	}
	return { outcome: "REGISTERED", insertableContentId: contentId };
}
