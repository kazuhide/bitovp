import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { EncodingPlan } from "@bitovp/core";
import {
	getVodInputTimelineDurationMs,
	getVodInputTimelineUsedSourceKeys,
	MAX_VOD_INPUT_PREPARATION_BYTES,
	vodInputPreviewRequestSchema,
	vodInputPreviewResultSchema,
} from "@bitovp/core/vod-input-timeline";
import type { ObjectIdentity, ObjectStorageBrowser } from "./types";

function pendingStorage<T>(
	pending: Promise<T>,
	signal: AbortSignal,
	dispose?: (value: T) => void,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const canceled = () => reject(new Error("PREPARATION_CHECK_CANCELED"));
		signal.addEventListener("abort", canceled, { once: true });
		pending.then(
			(value) => {
				signal.removeEventListener("abort", canceled);
				if (signal.aborted) {
					dispose?.(value);
					canceled();
				} else resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", canceled);
				reject(error);
			},
		);
		if (signal.aborted) canceled();
	});
}

export function sameTimelineObject(a: ObjectIdentity, b: ObjectIdentity) {
	const canonical = (value: ObjectIdentity) =>
		JSON.stringify({
			size: value.size,
			etag: value.etag,
			versionId: value.versionId === "null" ? undefined : value.versionId,
			generation: value.generation,
		});
	return canonical(a) === canonical(b);
}

/** Bounded conditional full-object re-read; a short clean stream is not a verified object. */
export async function verifyTimelineObjectDigest(input: {
	browser: ObjectStorageBrowser;
	bucket: string;
	key: string;
	identity: ObjectIdentity;
	sha256: string;
	signal: AbortSignal;
}) {
	if (!input.browser.getObject)
		throw new Error("PREPARATION_OUTPUT_UNVERIFIED");
	let stream: Readable | undefined;
	const abort = () => stream?.destroy(new Error("PREPARATION_CHECK_CANCELED"));
	input.signal.addEventListener("abort", abort, { once: true });
	try {
		input.signal.throwIfAborted();
		stream = (await pendingStorage(
			input.browser.getObject({
				bucket: input.bucket,
				key: input.key,
				expect: input.identity,
				range: { start: 0, end: input.identity.size - 1 },
			}),
			input.signal,
			(value) => (value as Readable).destroy(),
		)) as Readable;
		input.signal.throwIfAborted();
		const hash = createHash("sha256");
		let size = 0;
		for await (const raw of stream) {
			input.signal.throwIfAborted();
			const bytes = Buffer.from(raw);
			size += bytes.length;
			if (size > input.identity.size)
				throw new Error("PREPARATION_OUTPUT_UNVERIFIED");
			hash.update(bytes);
		}
		if (size !== input.identity.size || hash.digest("hex") !== input.sha256)
			throw new Error("PREPARATION_OUTPUT_UNVERIFIED");
	} finally {
		input.signal.removeEventListener("abort", abort);
		stream?.destroy();
	}
}

export type TimelinePreparationRow = {
	id: string;
	organizationId: string;
	kind: string;
	status: string;
	request: unknown;
	result: unknown;
	requestHash: string;
	expiresAt: Date;
	cancelRequestedAt: Date | null;
};

/** One admission contract for create, rerun, retry and delayed Worker execution. */
export async function verifyInputTimelinePreparation(input: {
	plan: EncodingPlan;
	organizationId: string;
	allowExpired?: boolean;
	findTask: (id: string) => Promise<TimelinePreparationRow | null>;
	browserFor: (credentialId: string) => Promise<ObjectStorageBrowser>;
	signal: AbortSignal;
	now?: Date;
}) {
	const ref = input.plan.inputTimelinePreparation;
	if (!ref) return;
	const fail = (): never => {
		throw new Error("INPUT_PREPARATION_INVALID");
	};
	const row = await input.findTask(ref.taskId);
	if (
		!row ||
		row.organizationId !== input.organizationId ||
		row.kind !== "TIMELINE_PREPARE" ||
		row.status !== "SUCCEEDED" ||
		row.cancelRequestedAt ||
		row.requestHash !== ref.requestHash ||
		(!input.allowExpired && row.expiresAt <= (input.now ?? new Date()))
	)
		return fail();
	const request = vodInputPreviewRequestSchema.parse(row.request);
	if (
		request.kind !== "TIMELINE_PREPARE" ||
		createHash("sha256").update(JSON.stringify(request)).digest("hex") !==
			ref.requestHash
	)
		return fail();
	const prepared = vodInputPreviewResultSchema.parse(row.result).preparation;
	if (
		!prepared ||
		prepared.source.credentialId !== request.output.credentialId ||
		prepared.source.bucket !== request.output.bucket ||
		prepared.durationMs !== getVodInputTimelineDurationMs(request.document) ||
		prepared.facts.identity.size > MAX_VOD_INPUT_PREPARATION_BYTES
	)
		return fail();
	const prefix = `${[
		request.output.prefix.replace(/\/$/, ""),
		"bitovp-generated-inputs",
		input.organizationId,
		row.id,
	]
		.filter(Boolean)
		.join("/")}/`;
	if (
		!prepared.source.objectKey.startsWith(prefix) ||
		!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.mp4$/.test(
			prepared.source.objectKey.slice(prefix.length),
		)
	)
		return fail();
	const { plan } = input;
	// No residual trim, alternate source graph, or rendition may escape the baked program.
	if (
		plan.encodings?.length ||
		plan.ingest.length !== 1 ||
		plan.trimmingStreams.length ||
		plan.concatenationStreams.length ||
		plan.fileStreams.length ||
		plan.dolbyStreams.length ||
		plan.hdr10PlusStreams.length ||
		plan.audioMixStreams.length
	)
		return fail();
	const ingest = plan.ingest[0];
	if (
		ingest?.selectionMode !== "AUTO" ||
		ingest.inputPath !== prepared.source.objectKey ||
		plan.renditions.some((rendition) => rendition.ingestKey !== ingest.key)
	)
		return fail();
	const declared = plan.inputs.find((source) => source.key === ingest.inputKey);
	if (
		!declared ||
		!("bucket" in declared) ||
		declared.bucket !== prepared.source.bucket ||
		!("credentialId" in declared) ||
		declared.credentialId !== prepared.source.credentialId
	)
		return fail();
	const probe = await input.findTask(request.probeId);
	if (
		!probe ||
		probe.organizationId !== input.organizationId ||
		probe.kind !== "PROBE" ||
		probe.status !== "SUCCEEDED" ||
		probe.cancelRequestedAt
	)
		return fail();
	const sourceRequest = vodInputPreviewRequestSchema.parse(probe.request);
	const facts = vodInputPreviewResultSchema.parse(probe.result).sources;
	if (sourceRequest.kind !== "PROBE" || !facts) return fail();
	const browsers = new Set<ObjectStorageBrowser>();
	try {
		for (const key of getVodInputTimelineUsedSourceKeys(request.document)) {
			const source = sourceRequest.sources.find((source) => source.key === key),
				fact = facts.find((fact) => fact.key === key);
			if (!source || !fact) return fail();
			input.signal.throwIfAborted();
			const browser = await pendingStorage(
				input.browserFor(source.credentialId),
				input.signal,
				(value) => value.dispose?.(),
			);
			browsers.add(browser);
			if (
				!browser.headObject ||
				!sameTimelineObject(
					await pendingStorage(
						browser.headObject({
							bucket: source.bucket,
							key: source.objectKey,
						}),
						input.signal,
					),
					fact.identity,
				)
			)
				return fail();
		}
		const browser = await pendingStorage(
			input.browserFor(prepared.source.credentialId),
			input.signal,
			(value) => value.dispose?.(),
		);
		browsers.add(browser);
		if (!browser.headObject) return fail();
		const head = await pendingStorage(
			browser.headObject({
				bucket: prepared.source.bucket,
				key: prepared.source.objectKey,
			}),
			input.signal,
		);
		if (!sameTimelineObject(head, prepared.facts.identity)) return fail();
		// An immutable version can be checked by HEAD. ETag-only storage needs a current full SHA reread.
		if ((!head.versionId || head.versionId === "null") && !head.generation)
			await verifyTimelineObjectDigest({
				browser,
				bucket: prepared.source.bucket,
				key: prepared.source.objectKey,
				identity: head,
				sha256: prepared.sha256,
				signal: input.signal,
			});
		if (
			!sameTimelineObject(
				await pendingStorage(
					browser.headObject({
						bucket: prepared.source.bucket,
						key: prepared.source.objectKey,
					}),
					input.signal,
				),
				head,
			)
		)
			return fail();
		input.signal.throwIfAborted();
	} finally {
		for (const browser of browsers) browser.dispose?.();
	}
}
