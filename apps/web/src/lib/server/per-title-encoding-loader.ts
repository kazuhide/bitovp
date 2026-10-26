import "server-only";
import { CODEC_CONFIG_API_PATH, isPerTitleTemplateMode } from "@bitovp/core";
import { z } from "zod";
import type { PerTitleEncodingSnapshot } from "@/app/vod/new/per-title-encoding-import";

type Reader = { get(id: string): Promise<unknown> };
export type PerTitleEncodingReadPort = {
	encoding: {
		encodings: {
			getStartRequest(id: string): Promise<unknown>;
			streams: {
				list(
					id: string,
					page: { limit: number; offset: number },
				): Promise<{
					items?: unknown[];
					totalCount?: number;
				}>;
			};
		};
		configurations: {
			type: { get(id: string): Promise<{ type?: unknown }> };
			video: Partial<
				Record<"h264" | "h265" | "h265v2" | "vp9" | "av1", Reader>
			>;
		};
	};
};

const PAGE_SIZE = 100;
const MAX_STREAMS = 1000;
const MAX_TEMPLATES = 5 * 64;
const uuid = z.uuid();
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const failures = {
	IMPORT_LIMIT_EXCEEDED: {
		status: 422,
		message: "Encoding import exceeds the supported resource limit",
	},
	UPSTREAM_UNAVAILABLE: {
		status: 502,
		message: "Encoding settings could not be read completely",
	},
} as const;

export class PerTitleEncodingLoaderError extends Error {
	readonly status: number;
	constructor(readonly code: keyof typeof failures) {
		super(failures[code].message);
		this.name = "PerTitleEncodingLoaderError";
		this.status = failures[code].status;
	}
}

/** Stop awaiting a canceled provider read even if its promise does not settle. */
function read<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const canceled = () => reject(signal.reason);
		signal.addEventListener("abort", canceled, { once: true });
		Promise.resolve()
			.then(() => {
				signal.throwIfAborted();
				return operation();
			})
			.then(
				(value) => {
					signal.removeEventListener("abort", canceled);
					if (signal.aborted) reject(signal.reason);
					else resolve(value);
				},
				(error: unknown) => {
					signal.removeEventListener("abort", canceled);
					reject(error);
				},
			);
	});
}

/** Collect only source templates. No start, mutation, output, or DRM calls exist here. */
export async function loadPerTitleEncodingSnapshot(
	api: PerTitleEncodingReadPort,
	encodingId: string,
	{ signal }: { signal: AbortSignal },
): Promise<PerTitleEncodingSnapshot> {
	if (!uuid.safeParse(encodingId).success)
		throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
	const encodings = api.encoding.encodings;
	const startRequest = await read(signal, () =>
		encodings.getStartRequest(encodingId),
	);
	const seen = new Map<string, string>();
	const templates: Record<string, unknown>[] = [];
	let complete = false;
	let reportedTotal: number | undefined;
	// An extra empty page can confirm an exact-limit list without accepting more records.
	for (let offset = 0; offset <= MAX_STREAMS; offset += PAGE_SIZE) {
		const page = await read(signal, () =>
			encodings.streams.list(encodingId, { limit: PAGE_SIZE, offset }),
		);
		if (
			!record(page) ||
			!Array.isArray(page.items) ||
			page.items.length > PAGE_SIZE
		)
			throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
		if (
			page.totalCount !== undefined &&
			(!Number.isSafeInteger(page.totalCount) || page.totalCount < 0)
		)
			throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
		if ((page.totalCount ?? 0) > MAX_STREAMS)
			throw new PerTitleEncodingLoaderError("IMPORT_LIMIT_EXCEEDED");
		if (page.totalCount !== undefined) {
			if (reportedTotal !== undefined && reportedTotal !== page.totalCount)
				throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
			reportedTotal = page.totalCount;
		}
		const before = seen.size;
		for (const stream of page.items) {
			if (
				!record(stream) ||
				!uuid.safeParse(stream.id).success ||
				typeof stream.mode !== "string"
			)
				throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
			const id = stream.id as string;
			const fingerprint = JSON.stringify({
				mode: stream.mode,
				codecConfigId: stream.codecConfigId,
				perTitleSettings: stream.perTitleSettings,
			});
			const previous = seen.get(id);
			if (previous !== undefined) {
				if (previous !== fingerprint)
					throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
				continue;
			}
			seen.set(id, fingerprint);
			if (seen.size > MAX_STREAMS)
				throw new PerTitleEncodingLoaderError("IMPORT_LIMIT_EXCEEDED");
			if (!isPerTitleTemplateMode(stream.mode)) continue;
			if (!uuid.safeParse(stream.codecConfigId).success)
				throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
			templates.push(stream);
			if (templates.length > MAX_TEMPLATES)
				throw new PerTitleEncodingLoaderError("IMPORT_LIMIT_EXCEEDED");
		}
		if (reportedTotal !== undefined && seen.size > reportedTotal)
			throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
		if (page.items.length < PAGE_SIZE) {
			if (reportedTotal !== undefined && seen.size !== reportedTotal)
				throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
			complete = true;
			break;
		}
		if (seen.size === before)
			throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
	}
	if (!complete) throw new PerTitleEncodingLoaderError("IMPORT_LIMIT_EXCEEDED");
	const configs = new Map<
		string,
		{ codecType: string; configuration: unknown }
	>();
	const streams: Array<PerTitleEncodingSnapshot["streams"][number]> = [];
	for (const stream of templates) {
		const configurationId = stream.codecConfigId as string;
		let config = configs.get(configurationId);
		if (!config) {
			const typed = await read(signal, () =>
				api.encoding.configurations.type.get(configurationId),
			);
			if (
				!record(typed) ||
				typeof typed.type !== "string" ||
				!/^[A-Z0-9_]{1,80}$/.test(typed.type)
			)
				throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
			const path = CODEC_CONFIG_API_PATH[typed.type];
			if (path && path[0] !== "video") {
				configs.set(configurationId, {
					codecType: typed.type,
					configuration: null,
				});
				continue;
			}
			const endpoint = path
				? api.encoding.configurations.video[
						path[1] as keyof typeof api.encoding.configurations.video
					]
				: undefined;
			if (path && typeof endpoint?.get !== "function")
				throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
			config = {
				codecType: typed.type,
				configuration: endpoint
					? await read(signal, () => endpoint.get(configurationId))
					: null,
			};
			configs.set(configurationId, config);
		}
		const path = CODEC_CONFIG_API_PATH[config.codecType];
		if (path && path[0] !== "video") continue;
		streams.push({ stream, ...config });
	}
	signal.throwIfAborted();
	return { startRequest, streams };
}
