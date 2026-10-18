import { slateSourceSchema } from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { insertableContentInputSchema } from "@/lib/live-runtime/schemas";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { resolveLiveEncoding } from "@/lib/server/live-channel-encoding";
import { runSlatePreflight } from "@/lib/server/slate-preflight";

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z
	.strictObject({
		bitmovinAccountId: z.uuid(),
		/** The picker's shape. */
		source: slateSourceSchema.optional(),
		/** The raw shape (advanced disclosure / API clients). */
		input: insertableContentInputSchema.optional(),
	})
	.refine(
		(value) => (value.source !== undefined) !== (value.input !== undefined),
		{
			message: "Provide exactly one of source or input",
			path: ["source"],
		},
	);

/**
 * POST — the compatibility PREFLIGHT for a slate clip (C36 / WP-A2), the
 * same check `POST ../insertable-content` runs before registering, exposed
 * so the panel can show the verdict — probe summary plus every difference —
 * BEFORE the register button enables.
 *
 * Idempotent and poll-friendly: the first call adopts the object's latest
 * inspection or starts one and answers `PENDING` with its id; later calls
 * answer `PENDING` while it runs and `DONE` with the verdict once it lands.
 * Nothing is created at Bitmovin. RUNNING-gated like the registration it
 * precedes, because the ingest reference is the running encoder's.
 *
 * `probe` in the DONE body is the raw ffprobe JSON the worker wrote through
 * `redactSecrets` — the same value `GET /api/storage-inspections/[id]` returns.
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
	const { bitmovinAccountId, source, input } = parsed.data;
	try {
		const ctx = await getServerContext();
		const resolved = await resolveLiveEncoding({
			ctx,
			channelId: id,
			bitmovinAccountId,
			requireRunning: true,
			subject: "Slate compatibility checks",
		});
		if (!resolved.ok) {
			return resolved.response;
		}
		const preflight = await runSlatePreflight({
			ctx,
			api: resolved.api,
			channelId: id,
			request: source
				? { kind: "source", source }
				: {
						kind: "input",
						inputId: input?.inputId ?? "",
						inputPath: input?.inputPath ?? "",
					},
		});
		return NextResponse.json(preflight.dto, {
			status: preflight.status === "PENDING" ? 202 : 200,
		});
	} catch (err) {
		return routeError(err);
	}
}
