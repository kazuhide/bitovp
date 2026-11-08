import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
	CompositionError,
	ContentEditingError,
	cfrTimeMapSchema,
	compileEditDocument,
	type EditDocument,
	editingDocumentSchema,
} from "@bitovp/core";
import type { Prisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { EditingMediaView } from "@/lib/library-editing";
import {
	EXPECTED_ORGANIZATION_QUERY,
	requestOrganizationId,
} from "@/lib/passive-request";
import type { ServerContext } from "./context";
import { jsonError, routeError, validationError } from "./http";
import { isClipEditingAvailable } from "./library-editing-feature";
import { readBoundedJson } from "./request-body";

export class EditingRequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
	) {
		super(code);
	}
}
export const json = (value: unknown): Prisma.InputJsonValue =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function editingBody(req: Request) {
	const result = await readBoundedJson(req, 512 * 1024);
	if (result.tooLarge)
		throw new EditingRequestError(413, "EDIT_DOCUMENT_TOO_LARGE");
	return result.value;
}
export async function editingRoute(
	action: () => Promise<unknown>,
	status = 200,
	options: { allowUnavailable?: "ARTIFACT_READ" | "CANCEL" } = {},
): Promise<Response> {
	try {
		const allowedException =
			options.allowUnavailable === "ARTIFACT_READ" ||
			options.allowUnavailable === "CANCEL";
		if (!allowedException && !isClipEditingAvailable())
			throw new EditingRequestError(503, "CLIP_EDITING_UNAVAILABLE");
		const result = await action();
		return result instanceof Response
			? result
			: NextResponse.json(result, { status });
	} catch (error) {
		if (error instanceof z.ZodError) return validationError(error);
		if (error instanceof EditingRequestError)
			return jsonError(error.status, error.code, { code: error.code });
		if (
			error instanceof ContentEditingError ||
			error instanceof CompositionError
		)
			return jsonError(422, error.code, { code: error.code });
		return routeError(error);
	}
}
export function initialEditingDocument(
	media: { id: string; timeMap: unknown },
	variant: "LANDSCAPE" | "PORTRAIT",
): EditDocument {
	const map = cfrTimeMapSchema.parse(media.timeMap);
	const frames = Math.min(900, map.editingEndFrame - map.editingStartFrame);
	return editingDocumentSchema.parse({
		schemaVersion: 1,
		mediaVersionId: media.id,
		timeMapId: map.id,
		analysisRevisionId: null,
		locale: "und",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		canvas:
			variant === "PORTRAIT"
				? { width: 1080, height: 1920 }
				: { width: 1920, height: 1080 },
		fps: { num: 30, den: 1 },
		clips: [
			{
				id: randomUUID(),
				sourceInUs: map.sourceStartUs,
				durationFrames: frames,
				timelineStartFrame: 0,
				framing: [
					{ fromFrame: 0, toFrame: frames, mode: "FIT", origin: "MANUAL" },
				],
				audio: { mode: "SOURCE" },
			},
		],
	});
}
export function assertEditingBinding(
	input: unknown,
	media: { id: string; timeMap: unknown },
	allowProposals = false,
): EditDocument {
	const document = editingDocumentSchema.parse(input);
	if (document.mediaVersionId !== media.id)
		throw new EditingRequestError(422, "MEDIA_VERSION_MISMATCH");
	// Validate every time interval even while preserving an unconfirmed AISA draft.
	const check = allowProposals
		? {
				...document,
				clips: document.clips.map((clip) => ({
					...clip,
					framing: clip.framing.map((f) => ({
						...f,
						origin: "MANUAL" as const,
					})),
				})),
			}
		: document;
	compileEditDocument(check, media.timeMap);
	return document;
}
export function boundMediaUrl(ctx: ServerContext, path: string) {
	return `${path}?${new URLSearchParams({ [EXPECTED_ORGANIZATION_QUERY]: requestOrganizationId(ctx) })}`;
}
export function mediaView(
	ctx: ServerContext,
	row: {
		id: string;
		sourceId: string;
		state: string;
		error: string | null;
		durationUs: bigint | null;
		width: number | null;
		height: number | null;
		timeMap: unknown;
	},
): EditingMediaView {
	const parsed = cfrTimeMapSchema.safeParse(row.timeMap);
	return {
		id: row.id,
		sourceId: row.sourceId,
		state: row.state,
		error: row.error,
		durationUs: row.durationUs === null ? null : Number(row.durationUs),
		width: row.width,
		height: row.height,
		timeMap: parsed.success ? parsed.data : null,
		url:
			row.state === "READY"
				? boundMediaUrl(ctx, `/api/library/media-versions/${row.id}/media`)
				: null,
	};
}
