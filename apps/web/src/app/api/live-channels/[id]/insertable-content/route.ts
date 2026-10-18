import { InsertableContent, InsertableContentInput } from "@bitmovin/api-sdk";
import { masterKeyFromEnv } from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { customerErrorDetails } from "@/lib/customer-error";
import { listQuerySchema, sanitizePage } from "@/lib/infrastructure/schemas";
import {
	insertableContentCreateSchema,
	type SlateIncompatibleDetails,
	sanitizeInsertableContent,
	sanitizeSlateNormalization,
} from "@/lib/live-runtime/schemas";
import { auditedBitmovinCall, bitmovinProxyError } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { resolveLiveEncoding } from "@/lib/server/live-channel-encoding";
import { getSlateNormalizeQueue } from "@/lib/server/queue";
import { planSlateInputForCredential } from "@/lib/server/slate-input";
import { runSlatePreflight } from "@/lib/server/slate-preflight";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Insertable content = media Bitmovin pre-downloads so it can be cut into the
 * live stream on demand (slates, ad fillers, "we'll be right back" images).
 * Registering it is a download job: the row goes CREATED → DOWNLOADING → READY
 * (or ERROR) and only READY content can be scheduled.
 *
 * READY means REGISTERED, not playable (C36): measured 2026-09-02, a clip
 * whose frame rate and audio sample rate did not match the live ingest
 * reached READY in one second and its scheduled insertions went to provider
 * ERROR at air time. The POST below therefore runs the compatibility
 * preflight BEFORE anything is created at the provider and refuses a
 * measured mismatch with 422 `SLATE_INCOMPATIBLE`.
 *
 * GET — list registered content for this channel's encoding (C6 paging).
 */
export async function GET(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const url = new URL(req.url);
	const query = listQuerySchema.safeParse({
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? undefined,
		offset: url.searchParams.get("offset") ?? undefined,
		limit: url.searchParams.get("limit") ?? undefined,
	});
	if (!query.success) {
		return validationError(query.error);
	}
	try {
		const ctx = await getServerContext();
		const resolved = await resolveLiveEncoding({
			ctx,
			channelId: id,
			bitmovinAccountId: query.data.bitmovinAccountId,
			// Reads stay available after a stop so an operator can inspect what was
			// registered; only the mutations are RUNNING-gated.
			requireRunning: false,
			subject: "Insertable content",
		});
		if (!resolved.ok) {
			return resolved.response;
		}
		try {
			const page =
				await resolved.api.encoding.encodings.live.insertableContent.list(
					resolved.encodingId,
					{ offset: query.data.offset, limit: query.data.limit },
				);
			return NextResponse.json(sanitizePage(page, sanitizeInsertableContent));
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

const bodySchema = z.strictObject({
	bitmovinAccountId: z.uuid(),
	content: insertableContentCreateSchema,
});

/** The input name for a picker-registered slate — stable, like the worker's. */
function slateInputName(channelId: string, key: string): string {
	return `slate-src:${channelId}:${key.split("/").pop() ?? key}`;
}

/**
 * POST — register content. Bitmovin then downloads it from the named input, so
 * a 201 here means "accepted for download", not "ready to play" — and, since
 * C36, "passed or stood down on the compatibility preflight", which the
 * response's `preflight` says in so many words.
 *
 * : for the picker's `source` shape the preflight's `preparation`
 * decides the path. A still image or an MPEG-TS that already matches the
 * ingest registers inline as before (201). Anything else — an MP4 (its audio
 * plays at half speed as it is), a mismatched attribute, an MKV — is handed
 * to the worker: a `SlateNormalization` row is created and queued, the
 * worker converts the file to an ingest-matching MPEG-TS next to its source
 * and registers THAT, and the row is the operator's view of it (202). A
 * movie with no ingest reference yet parks in WAITING_FOR_INPUT and is
 * picked up once the encoder connects. Only a file that cannot be read or
 * has no video is refused (422). The raw `inputs` shape has no credential to
 * write with, so it keeps the C36 refusal.
 *
 * Two body shapes (`insertableContentCreateSchema`): the picker's `source`
 * triple, for which this route mints the Bitmovin input from the vaulted
 * credential, and the raw `inputs` list. Both are preflighted; a `source`
 * whose inspection is still running is 409 `SLATE_UNINSPECTED` (poll the
 * preflight route, then retry), an `inputs` entry no credential can probe
 * proceeds UNVERIFIED.
 */
export async function POST(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { bitmovinAccountId, content } = parsed.data;
	try {
		const ctx = await getServerContext();
		const resolved = await resolveLiveEncoding({
			ctx,
			channelId: id,
			bitmovinAccountId,
			requireRunning: true,
			subject: "Registering insertable content",
		});
		if (!resolved.ok) {
			return resolved.response;
		}
		const { api, encodingId } = resolved;

		// The preflight (C36). Exactly one of the two shapes parses, and the
		// legacy shape is preflighted on its FIRST input only — one clip is one
		// slate; a multi-input registration is an API-only shape the panel never
		// builds, and its other inputs ride through as before.
		const firstInput = content.inputs?.[0];
		const preflight = await runSlatePreflight({
			ctx,
			api,
			channelId: id,
			request: content.source
				? { kind: "source", source: content.source }
				: {
						kind: "input",
						inputId: firstInput?.inputId ?? "",
						inputPath: firstInput?.inputPath ?? "",
					},
		});
		if (preflight.status === "PENDING") {
			return jsonError(
				409,
				"The clip's inspection is still running — poll the preflight route and retry once it reports a verdict",
				customerErrorDetails("SLATE_UNINSPECTED", {
					inspectionId: preflight.dto.inspectionId ?? null,
				}),
			);
		}
		//  — the picker's shape acts on the preparation verdict.
		const preparation = preflight.dto.preparation;
		if (content.source && preparation?.action === "REFUSE") {
			const details: SlateIncompatibleDetails = {
				code: "SLATE_INCOMPATIBLE",
				differences: preflight.dto.differences ?? [],
				kind: preflight.dto.kind,
				container: preflight.dto.container,
			};
			return jsonError(
				422,
				`Slate clip cannot be registered: ${preparation.reason}`,
				details,
			);
		}
		if (
			content.source &&
			preparation &&
			(preparation.action === "NORMALIZE" ||
				preparation.action === "WAIT_FOR_INPUT")
		) {
			const candidate = preflight.candidate ?? content.source;
			// The worker must decrypt the credential to read and write the
			// object; fail here rather than leave a row QUEUED forever behind a
			// broken MASTER_KEY (the same guard the inspection enqueue has).
			masterKeyFromEnv();
			const waiting = preparation.action === "WAIT_FOR_INPUT";
			const row = await ctx.prisma.slateNormalization.create({
				data: {
					liveChannelId: id,
					bitmovinAccountId,
					name: content.name ?? null,
					credentialId: candidate.credentialId,
					bucket: candidate.bucket,
					sourceKey: candidate.key,
					status: waiting ? "WAITING_FOR_INPUT" : "QUEUED",
					note: waiting
						? `waiting for the live input (${preparation.missing.join(", ")} not known yet)`
						: `will be converted to MPEG-TS to match the live input (${preparation.reasons.join(", ")})${
								preflight.dto.conversionDestination
									? ` → ${preflight.dto.conversionDestination.bucket}/${preflight.dto.conversionDestination.keyPrefix}`
									: ""
							}`,
				},
			});
			if (!waiting) {
				try {
					await getSlateNormalizeQueue().add(
						"slate-normalize",
						{ slateNormalizationId: row.id },
						{
							// The epoch scopes BullMQ's dedupe to this enqueue (the
							// promoter re-queues under its own epoch).
							jobId: `slate-normalize-${row.id}-${Date.now()}`,
							attempts: 1,
							removeOnComplete: 1000,
							removeOnFail: 1000,
						},
					);
				} catch (enqueueErr) {
					await ctx.prisma.slateNormalization.update({
						where: { id: row.id },
						data: {
							status: "ERROR",
							error: "Enqueue failed — register the file again",
						},
					});
					throw enqueueErr;
				}
			}
			return NextResponse.json(
				{
					normalization: sanitizeSlateNormalization(row),
					preflight: { ...preflight.dto, probe: undefined },
				},
				{ status: 202 },
			);
		}
		if (preflight.status === "INCOMPATIBLE") {
			// The raw `inputs` shape (no credential to normalize with), or a
			// picker registration whose preparation could not be decided.
			// Stills are admitted since , so `preflight.image` cannot be
			// set any more; this branch stays as the translator of the refusal
			// code older rows may still carry.
			const details: SlateIncompatibleDetails = {
				code: preflight.image
					? "SLATE_UNSUPPORTED_IMAGE"
					: "SLATE_INCOMPATIBLE",
				differences: preflight.dto.differences ?? [],
				kind: preflight.dto.kind,
				container: preflight.dto.container,
			};
			return jsonError(
				422,
				preflight.image
					? `Slate clip is a still image: ${preflight.dto.note ?? ""}`
					: `Slate clip does not match the live stream, so the insert would fail at air time even though the content would register as READY:\n${preflight.dto.note ?? ""}`,
				details,
			);
		}

		// The inputs to register: minted from the credential for the picker's
		// shape, taken verbatim (path normalised) for the raw shape.
		let inputs: { inputId: string; inputPath: string; description?: string }[];
		if (content.source) {
			const candidate = preflight.candidate ?? content.source;
			const plan = await planSlateInputForCredential(
				ctx,
				candidate.credentialId,
				candidate.bucket,
				slateInputName(id, candidate.key),
			);
			if (plan === null) {
				return jsonError(404, "Storage credential not found");
			}
			if (!plan.ok) {
				return jsonError(
					422,
					plan.reason,
					customerErrorDetails("SLATE_SOURCE_UNSUPPORTED"),
				);
			}
			const minted = await auditedBitmovinCall({
				req,
				ctx,
				bitmovinAccountId,
				method: "POST",
				path: plan.path,
				// Secret-free snapshot: the bucket and the credential's ID name the
				// source; the access keys never enter the audit row.
				request: {
					name: slateInputName(id, candidate.key),
					bucket: candidate.bucket,
					credentialId: candidate.credentialId,
					provider: plan.provider,
				},
				call: () => plan.create(api),
				responseSnapshot: (inputId) => ({ id: inputId }),
			});
			if (!minted.ok) {
				return minted.response;
			}
			inputs = [
				{ inputId: minted.result, inputPath: preflight.dto.inputPath.path },
			];
		} else {
			inputs = (content.inputs ?? []).map((input, index) => ({
				...input,
				inputPath: index === 0 ? preflight.dto.inputPath.path : input.inputPath,
			}));
		}

		// A registration that proceeds UNVERIFIED says so ON THE CONTENT: the
		// provider's `description` is the one field both the panel's list and
		// the worker's fire path can read back, so a later insert failure can
		// name the check that stood down (`preflightUnverifiedReason`). A
		// caller-supplied description wins — it is theirs.
		const description =
			content.description ??
			(preflight.status === "UNVERIFIED" ? preflight.dto.summary : undefined);
		const outcome = await auditedBitmovinCall({
			req,
			ctx,
			bitmovinAccountId,
			method: "POST",
			path: `/encoding/encodings/${encodingId}/live/insertable-content`,
			// No secrets: inputs are referenced by id, never by credentials.
			request: { ...content, inputs, description, source: undefined },
			call: () =>
				api.encoding.encodings.live.insertableContent.create(
					encodingId,
					new InsertableContent({
						...(content.name ? { name: content.name } : {}),
						...(description ? { description } : {}),
						inputs: inputs.map((input) => new InsertableContentInput(input)),
					}),
				),
			responseSnapshot: (result) => sanitizeInsertableContent(result),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json(
			{
				...sanitizeInsertableContent(outcome.result),
				// What the preflight established, so a 201 never reads as "checked"
				// when the check stood down. `probe` is dropped: the summary is the
				// preflight route's job, and the create response stays small.
				preflight: { ...preflight.dto, probe: undefined },
			},
			{ status: 201 },
		);
	} catch (err) {
		return routeError(err);
	}
}
