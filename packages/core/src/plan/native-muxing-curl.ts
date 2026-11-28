import { z } from "zod";
import { REDACTED } from "../crypto/url-userinfo";
import type { StepLogEntry } from "./steplog";

const nativeMuxingTypes = new Map([
	["CREATE_MUXING_BROADCAST_TS", "BROADCAST_TS"],
	["CREATE_MUXING_MP3", "MP3"],
	["CREATE_MUXING_MXF", "MXF"],
	["CREATE_MUXING_PACKED_AUDIO", "PACKED_AUDIO"],
	["CREATE_MUXING_SEGMENTED_RAW", "SEGMENTED_RAW"],
]);

const acl = z.enum(["PRIVATE", "PUBLIC_READ"]);
const outputPath = z.string().refine((value) => !value.includes(REDACTED));
const muxingRequest = z.object({
	refs: z.object({
		encodingId: z.uuid(),
		streamId: z.uuid(),
		additionalStreamIds: z.array(z.uuid()).optional(),
		outputId: z.uuid().optional(),
		mirrorOutputIds: z.array(z.uuid()).optional(),
	}),
	name: z.string().optional(),
	filename: z.string().min(1).optional(),
	segmentLength: z.number().positive().optional(),
	segmentNaming: z.string().min(1).optional(),
	outputPath: outputPath.optional(),
	acl: acl.optional(),
	mirrorOutputPaths: z.array(outputPath).optional(),
	mirrorOutputAcls: z.array(acl.nullable()).optional(),
});

function wireOutput(
	outputId: string,
	path: string,
	permission?: z.infer<typeof acl> | null,
) {
	return {
		outputId,
		outputPath: path,
		...(permission ? { acl: [{ permission }] } : {}),
	};
}

function refCount(value: string | string[] | undefined): number {
	return typeof value === "string" ? 1 : (value?.length ?? 0);
}

/** Rebuild the SDK body from the saved dispatch fields and resolved provider IDs. */
export function nativeMuxingCurlSnapshot(entry: StepLogEntry) {
	const type = nativeMuxingTypes.get(entry.kind);
	if (!type) return undefined;
	const parsed = muxingRequest.safeParse(entry.request);
	if (!parsed.success) return false;
	const request = parsed.data;
	const { refs } = request;
	const extraStreams = refs.additionalStreamIds ?? [];
	const mirrors = refs.mirrorOutputIds ?? [];
	if (
		extraStreams.length !== refCount(entry.refs.additionalStreamIds) ||
		mirrors.length !== refCount(entry.refs.mirrorOutputIds) ||
		Boolean(refs.outputId) !== Boolean(entry.refs.outputId)
	)
		return false;

	const { outputId } = refs;
	const path = request.outputPath;
	if (
		(outputId && path === undefined) ||
		(!outputId && (type !== "PACKED_AUDIO" || mirrors.length > 0))
	)
		return false;
	const segmented = type === "PACKED_AUDIO" || type === "SEGMENTED_RAW";
	if (
		(segmented &&
			(request.segmentLength === undefined || !request.segmentNaming)) ||
		(!segmented && !request.filename)
	)
		return false;
	return {
		refs: { encodingId: refs.encodingId },
		request: {
			type,
			name: request.name,
			streams: [refs.streamId, ...extraStreams].map((streamId) => ({
				streamId,
			})),
			...(outputId &&
				path !== undefined && {
					outputs: [
						wireOutput(outputId, path, request.acl),
						...mirrors.map((id, i) =>
							wireOutput(
								id,
								request.mirrorOutputPaths?.[i] ?? path,
								request.mirrorOutputAcls
									? request.mirrorOutputAcls[i]
									: request.acl,
							),
						),
					],
				}),
			...(segmented
				? {
						segmentLength: request.segmentLength,
						segmentNaming: request.segmentNaming,
					}
				: { filename: request.filename }),
		},
	};
}
