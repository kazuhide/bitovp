import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import {
	getVodInputTimelineUsedSourceKeys,
	type VodInputPreviewResult,
	type VodInputTimelinePrepareRequest,
	type VodInputTimelineSource,
	type VodInputTimelineSourceFacts,
	vodInputPreviewResultSchema,
} from "@bitovp/core/vod-input-timeline";
import {
	sameTimelineObject,
	verifyTimelineObjectDigest,
} from "@bitovp/storage";
import { MediaOperationError } from "../library-editing/process";
import { probeVodInputSources } from "./media";
import type { VodInputMediaDependencies } from "./media-profile";
import { abortableVodOperation } from "./range-bridge";
import { renderVodInputPreview } from "./render";

export async function prepareVodInputTimeline(
	input: VodInputMediaDependencies & {
		request: VodInputTimelinePrepareRequest;
		sources: VodInputTimelineSource[];
		facts: VodInputTimelineSourceFacts[];
		organizationId: string;
		taskId: string;
		attemptId: string;
		directory: string;
	},
): Promise<NonNullable<VodInputPreviewResult["preparation"]>> {
	const deadline = Date.now() + (input.timeoutMs ?? 180_000);
	const fail = (code: string): never => {
		throw new MediaOperationError(code);
	};
	for (const id of [input.organizationId, input.taskId, input.attemptId])
		if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))
			return fail("INVALID_LOCAL_PATH");
	const source: VodInputTimelineSource = {
		key: `prepared_${input.taskId.replaceAll("-", "")}`,
		credentialId: input.request.output.credentialId,
		bucket: input.request.output.bucket,
		objectKey: [
			input.request.output.prefix.replace(/\/$/, ""),
			"bitovp-generated-inputs",
			input.organizationId,
			input.taskId,
			`${input.attemptId}.mp4`,
		]
			.filter(Boolean)
			.join("/"),
	};
	const browser = await input.browserFor(source.credentialId);
	try {
		if (!browser.putObject || !browser.headObject || !browser.getObject)
			return fail("PREPARATION_OUTPUT_UNSUPPORTED");
		const rendered = await renderVodInputPreview(input);
		if (rendered.path !== join(input.directory, "prepared.mp4"))
			return fail("OUTPUT_INVALID");
		// Check all source versions again after rendering, before publishing a reusable input.
		for (const key of getVodInputTimelineUsedSourceKeys(
			input.request.document,
		)) {
			const ref = input.sources.find((source) => source.key === key),
				fact = input.facts.find((fact) => fact.key === key);
			if (!ref || !fact) return fail("SOURCE_NOT_READY");
			const sourceBrowser = await input.browserFor(ref.credentialId);
			try {
				if (
					!sourceBrowser.headObject ||
					!sameTimelineObject(
						await sourceBrowser.headObject({
							bucket: ref.bucket,
							key: ref.objectKey,
						}),
						fact.identity,
					)
				)
					return fail("SOURCE_CHANGED");
			} finally {
				sourceBrowser.dispose?.();
			}
		}
		input.signal.throwIfAborted();
		await abortableVodOperation(
			browser.putObject({
				bucket: source.bucket,
				key: source.objectKey,
				filePath: rendered.path,
				contentType: "video/mp4",
				signal: input.signal,
				timeoutMs: Math.max(1, deadline - Date.now()),
			}),
			input.signal,
		);
		const head = await browser.headObject({
			bucket: source.bucket,
			key: source.objectKey,
		});
		if (head.size !== rendered.size)
			return fail("PREPARATION_OUTPUT_UNVERIFIED");
		await verifyTimelineObjectDigest({
			browser,
			bucket: source.bucket,
			key: source.objectKey,
			identity: head,
			sha256: rendered.sha256,
			signal: input.signal,
		});
		const [facts] = await probeVodInputSources({ ...input, sources: [source] });
		if (
			!facts ||
			!sameTimelineObject(facts.identity, head) ||
			!facts.video ||
			Math.abs(facts.durationMs - rendered.durationMs) > 100 ||
			!sameTimelineObject(
				await browser.headObject({
					bucket: source.bucket,
					key: source.objectKey,
				}),
				head,
			)
		)
			return fail("PREPARATION_OUTPUT_UNVERIFIED");
		input.signal.throwIfAborted();
		// Rehash local bytes as well: no upload receipt can promote a changed local file.
		const localHash = createHash("sha256");
		for await (const chunk of createReadStream(rendered.path, {
			signal: input.signal,
		}))
			localHash.update(chunk);
		if (localHash.digest("hex") !== rendered.sha256)
			return fail("PREPARATION_OUTPUT_UNVERIFIED");
		return (
			vodInputPreviewResultSchema.parse({
				preparation: {
					source,
					facts,
					durationMs: rendered.durationMs,
					sha256: rendered.sha256,
					profile: "H264_CRF12_AAC320_SDR8_V1",
				},
			}).preparation ?? fail("OUTPUT_INVALID")
		);
	} finally {
		browser.dispose?.();
	}
}
