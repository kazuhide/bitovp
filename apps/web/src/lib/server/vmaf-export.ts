import "server-only";
import { type RenditionRef, renditionLabel } from "@/app/qc/vmaf-shared";
import { iterateFrames } from "./vmaf-frames";

type ExportJob = {
	id: string;
	model: string;
	results: { id: string; renditionRef: unknown }[];
};
type ReadBlob = (id: string, signal: AbortSignal) => Promise<Uint8Array | null>;

function csvCell(value: string): string {
	const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return /[",\n\r]/.test(guarded)
		? `"${guarded.replace(/"/g, '""')}"`
		: guarded;
}

const indent = (value: unknown, spaces: number) =>
	JSON.stringify(value, null, 2).replace(/^/gm, " ".repeat(spaces));

async function* fragments(
	job: ExportJob,
	format: "csv" | "json",
	readBlob: ReadBlob,
	signal: AbortSignal,
): AsyncGenerator<string> {
	if (format === "csv") yield "rendition,frameNum,vmaf,psnr";
	else
		yield `${JSON.stringify({ vmafJobId: job.id, model: job.model }, null, 2).slice(0, -2)},\n  "renditions": [`;
	for (const [index, result] of job.results.entries()) {
		signal.throwIfAborted();
		const blob = await readBlob(result.id, signal);
		signal.throwIfAborted();
		const ref = result.renditionRef as RenditionRef;
		const label = renditionLabel(ref, index);
		const csvLabel = format === "csv" ? csvCell(label) : "";
		if (format === "json")
			yield `${index ? ",\n" : "\n"}${indent({ id: result.id, label, renditionRef: ref }, 4).slice(0, -6)},\n      "frames": [`;
		let first = true;
		if (blob)
			for await (const frame of iterateFrames(blob, signal)) {
				if (format === "csv")
					yield `\n${csvLabel},${frame.frameNum},${frame.vmaf},${typeof frame.psnr === "number" ? frame.psnr : ""}`;
				else yield `${first ? "\n" : ",\n"}${indent(frame, 8)}`;
				first = false;
			}
		if (format === "json") yield `${first ? "" : "\n      "}]\n    }`;
	}
	if (format === "json") yield `${job.results.length ? "\n  " : ""}]\n}`;
}

async function* encodeChunks(parts: AsyncIterable<string>) {
	const encoder = new TextEncoder();
	let chunk = new Uint8Array(65_536);
	let used = 0;
	for await (const part of parts) {
		const bytes = encoder.encode(part);
		for (let offset = 0; offset < bytes.length; ) {
			const length = Math.min(chunk.length - used, bytes.length - offset);
			chunk.set(bytes.subarray(offset, offset + length), used);
			used += length;
			offset += length;
			if (used === chunk.length) {
				yield chunk;
				chunk = new Uint8Array(65_536);
				used = 0;
			}
		}
	}
	if (used) yield chunk.subarray(0, used);
}

/** No queued output or later result fetches while a download is not being read. */
export function vmafExportStream(
	job: ExportJob,
	format: "csv" | "json",
	readBlob: ReadBlob,
	requestSignal: AbortSignal,
): ReadableStream<Uint8Array> {
	const controller = new AbortController();
	const signal = AbortSignal.any([requestSignal, controller.signal]);
	const iterator = encodeChunks(fragments(job, format, readBlob, signal));
	return new ReadableStream(
		{
			async pull(stream) {
				try {
					signal.throwIfAborted();
					const next = await iterator.next();
					if (next.done) stream.close();
					else stream.enqueue(next.value);
				} catch (error) {
					controller.abort(error);
					stream.error(error);
					await iterator.return(undefined);
				}
			},
			async cancel(reason) {
				controller.abort(reason);
				await iterator.return(undefined);
			},
		},
		{ highWaterMark: 0 },
	);
}
