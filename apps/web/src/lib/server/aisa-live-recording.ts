import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { aisaAnalysisSchema } from "@/lib/aisa-live/contracts";
import { parseAisaRecordingMediaPlaylist } from "@/lib/aisa-live/recording-timeline";
import {
	bindPassiveRequestUrl,
	EXPECTED_ORGANIZATION_QUERY,
	passiveOrganizationBinding,
	requestOrganizationId,
} from "@/lib/passive-request";
import {
	aisaLiveClientForAccount,
	aisaLivePreviewEnabled,
} from "./aisa-live-sdk";
import { getServerContext, type ServerContext } from "./context";
import { readBoundedBody } from "./request-body";

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
const TOKEN_LIFETIME_MS = 5 * 60 * 1000;
const MAX_ASSETS = 4096;
const PLAYLIST_CACHE_LIFETIME_MS = 30_000;
const PLAYLIST_CACHE_MARGIN_MS = 5_000;
const MAX_CACHED_PLAYLIST_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_PLAYLISTS = 8;
const finalizedPlaylists = new Map<
	string,
	{ text: string; bytes: number; expires: number }
>();
let cachedPlaylistBytes = 0;
// One opaque token bounds invalidation state. An unrelated status transition may
// skip an in-flight fill, but leaves existing entries for other scopes intact.
let playlistGeneration = Symbol();
const uuid = z.uuid();
const claimSchema = z.strictObject({
	url: z.string().min(1).max(4096),
	expires: z.number().int().positive(),
	depth: z.number().int().min(0).max(3),
});
type Scope = {
	ctx: ServerContext;
	accountId: string;
	analysisId: string;
	encodingId: string;
	organizationId: string;
};

class RecordingError extends Error {
	constructor(readonly status: number) {
		super("AISA recording unavailable");
	}
}

const headers = {
	"Cache-Control": "private, no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};
const fail = (status: number) =>
	Response.json(
		{
			error:
				status === 403 || status === 410
					? "Recording link is invalid or expired"
					: "AISA recording unavailable",
		},
		{ status, headers },
	);

/** Only the Google recording namespace observed in the provider recording contract is accepted. */
export function validateAisaRecordingUrl(
	value: string,
	analysisId: string,
): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new RecordingError(502);
	}
	let path: string;
	try {
		path = decodeURIComponent(url.pathname);
	} catch {
		throw new RecordingError(502);
	}
	const prefix = `/aisa-live-recordings-prod/live/${analysisId}/`;
	if (
		!uuid.safeParse(analysisId).success ||
		value.length > 4096 ||
		url.protocol !== "https:" ||
		url.hostname !== "storage.googleapis.com" ||
		(url.port && url.port !== "443") ||
		url.username ||
		url.password ||
		url.hash ||
		!path.startsWith(prefix) ||
		path !== url.pathname ||
		path.includes("%") ||
		path.split("/").some((part) => part === "." || part === "..") ||
		!/^[A-Za-z0-9_./-]+\.(?:m3u8|mp4|m4s|ts|aac)$/.test(path)
	)
		throw new RecordingError(502);
	return url;
}

function aad(scope: Scope) {
	return [
		"aisa-recording-v1",
		scope.organizationId,
		scope.accountId,
		scope.analysisId,
		scope.encodingId,
	].join(":");
}

function removePlaylist(key: string) {
	const entry = finalizedPlaylists.get(key);
	if (entry) cachedPlaylistBytes -= entry.bytes;
	finalizedPlaylists.delete(key);
}

function cachedPlaylist(key: string) {
	for (const [candidate, entry] of finalizedPlaylists)
		if (entry.expires <= Date.now()) removePlaylist(candidate);
	const entry = finalizedPlaylists.get(key);
	if (entry) {
		finalizedPlaylists.delete(key);
		finalizedPlaylists.set(key, entry);
	}
	return entry?.text;
}

function retainPlaylist(key: string, text: string, expires: number) {
	const bytes = Buffer.byteLength(text);
	if (expires <= Date.now() || bytes > MAX_CACHED_PLAYLIST_BYTES) return;
	removePlaylist(key);
	while (
		finalizedPlaylists.size >= MAX_CACHED_PLAYLISTS ||
		cachedPlaylistBytes + bytes > MAX_CACHED_PLAYLIST_BYTES
	) {
		const oldest = finalizedPlaylists.keys().next().value;
		if (oldest === undefined) return;
		removePlaylist(oldest);
	}
	finalizedPlaylists.set(key, { text, bytes, expires });
	cachedPlaylistBytes += bytes;
}

/** Cache eligibility is deliberately narrower than the proxy's accepted HLS. */
function finalPlaylistExpiry(text: string, analysisId: string, now: number) {
	try {
		if (!parseAisaRecordingMediaPlaylist(text).endList) return null;
	} catch {
		// Untrusted timelines remain proxyable, but must not receive a reuse lease.
		return null;
	}
	const lines = text.trimEnd().split(/\r?\n/);
	if (lines[0] !== "#EXTM3U" || lines.at(-1) !== "#EXT-X-ENDLIST") return null;
	let targetDuration = 0;
	let endLists = 0;
	let segments = 0;
	let pendingSegment = false;
	const singletonTags = new Set<string>();
	let expires = now + PLAYLIST_CACHE_LIFETIME_MS;
	for (const [index, line] of lines.entries()) {
		if (!line || (index === 0 && line === "#EXTM3U")) continue;
		const references: string[] = [];
		if (!line.startsWith("#")) {
			if (!pendingSegment) return null;
			pendingSegment = false;
			segments++;
			references.push(line);
		} else if (line.startsWith("#EXTINF:")) {
			const duration = /^#EXTINF:(\d+(?:\.\d+)?),[^\r\n]*$/.exec(line);
			if (
				pendingSegment ||
				!duration ||
				!Number.isFinite(Number(duration[1])) ||
				!(Number(duration[1]) > 0) ||
				Math.round(Number(duration[1])) > targetDuration
			)
				return null;
			pendingSegment = true;
		} else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
			if (targetDuration || !/^#EXT-X-TARGETDURATION:[1-9]\d*$/.test(line))
				return null;
			targetDuration = Number(line.slice(line.indexOf(":") + 1));
			if (!Number.isSafeInteger(targetDuration)) return null;
		} else if (line === "#EXT-X-ENDLIST") {
			if (pendingSegment || index !== lines.length - 1) return null;
			endLists++;
		} else if (line.startsWith("#EXT-X-MAP:")) {
			if (!/^#EXT-X-MAP:URI="[^"]+"(?:,BYTERANGE="\d+(?:@\d+)?")?$/.test(line))
				return null;
		} else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
			const date = line.slice(line.indexOf(":") + 1);
			if (
				!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
					date,
				) ||
				!Number.isFinite(Date.parse(date))
			)
				return null;
		} else if (line.startsWith("#EXT")) {
			if (
				!/^#EXT-X-(?:VERSION:[1-9]\d*|MEDIA-SEQUENCE:\d+|INDEPENDENT-SEGMENTS)$/.test(
					line,
				)
			)
				return null;
			const tag = line.split(":")[0] ?? "";
			if (
				singletonTags.has(tag) ||
				(tag === "#EXT-X-MEDIA-SEQUENCE" && (segments || pendingSegment))
			)
				return null;
			singletonTags.add(tag);
		}
		for (const match of line.matchAll(/\bURI="([^"]*)"/g))
			references.push(match[1] ?? "");
		for (const reference of references) {
			const url = validateAisaRecordingUrl(reference, analysisId);
			if (url.pathname.endsWith(".m3u8")) return null;
			const params = url.searchParams;
			if (
				[
					"X-Goog-Algorithm",
					"X-Goog-Date",
					"X-Goog-Expires",
					"X-Goog-Signature",
				].some((name) => params.getAll(name).length !== 1) ||
				params.get("X-Goog-Algorithm") !== "GOOG4-RSA-SHA256" ||
				!params.get("X-Goog-Signature")
			)
				return null;
			const date = params.get("X-Goog-Date") ?? "";
			const lifetime = params.get("X-Goog-Expires") ?? "";
			if (!/^\d{8}T\d{6}Z$/.test(date) || !/^\d+$/.test(lifetime)) return null;
			const issued = Date.parse(
				`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
			);
			if (
				!Number.isFinite(issued) ||
				new Date(issued)
					.toISOString()
					.replaceAll(/[-:]/g, "")
					.replace(".000", "") !== date ||
				issued > now ||
				!Number.isSafeInteger(Number(lifetime)) ||
				Number(lifetime) < 1 ||
				Number(lifetime) > 604800
			)
				return null;
			const signedUntil =
				issued + Number(lifetime) * 1000 - PLAYLIST_CACHE_MARGIN_MS;
			if (signedUntil <= now) return null;
			expires = Math.min(expires, signedUntil);
		}
	}
	return targetDuration && segments && endLists === 1 && !pendingSegment
		? expires
		: null;
}

async function issue(scope: Scope, url: string, depth: number) {
	if (depth > 3) throw new RecordingError(502);
	validateAisaRecordingUrl(url, scope.analysisId);
	const expires = Date.now() + TOKEN_LIFETIME_MS;
	const encrypted = await scope.ctx.cipher.encrypt(
		JSON.stringify({ url, expires, depth }),
		aad(scope),
	);
	const token = Buffer.from(encrypted).toString("base64url");
	return {
		path: bindPassiveRequestUrl(
			`/api/live/analyses/${scope.analysisId}/recording/media?bitmovinAccountId=${scope.accountId}&encodingId=${scope.encodingId}&token=${token}`,
			scope.organizationId,
		),
		expires,
	};
}

async function open(scope: Scope, token: string) {
	if (token.length > 12000 || !/^[A-Za-z0-9_-]+$/.test(token))
		throw new RecordingError(403);
	try {
		const clear = await scope.ctx.cipher.decrypt(
			Buffer.from(token, "base64url").toString("utf8"),
			aad(scope),
		);
		const claim = claimSchema.parse(JSON.parse(clear));
		if (
			claim.expires <= Date.now() ||
			claim.expires > Date.now() + TOKEN_LIFETIME_MS + 1000
		)
			throw new RecordingError(410);
		validateAisaRecordingUrl(claim.url, scope.analysisId);
		return claim;
	} catch (error) {
		if (error instanceof RecordingError) throw error;
		throw new RecordingError(403);
	}
}

/** URI rewriting accepts provider references only; a browser never supplies an upstream URL. */
async function rewrite(text: string, scope: Scope, depth: number) {
	if (
		!text.startsWith("#EXTM3U") ||
		depth > 3 ||
		Buffer.byteLength(text) > MAX_MANIFEST_BYTES
	)
		throw new RecordingError(502);
	const assets = new Map<string, string>();
	let expires = Number.POSITIVE_INFINITY;
	const path = async (value: string) => {
		if (assets.has(value)) return assets.get(value) as string;
		if (assets.size >= MAX_ASSETS) throw new RecordingError(502);
		const result = await issue(scope, value, depth + 1);
		assets.set(value, result.path);
		expires = Math.min(expires, result.expires);
		return result.path;
	};
	const lines: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) {
			lines.push("");
			continue;
		}
		if (!line.startsWith("#")) {
			lines.push(await path(line));
			continue;
		}
		let replaced = line;
		for (const match of line.matchAll(/\bURI="([^"]*)"/g))
			replaced = replaced.replace(
				match[0],
				`URI="${await path(match[1] ?? "")}"`,
			);
		if (
			/https?:\/\/|(?:^|[^:])\/\//i.test(replaced) ||
			/\bURI=(?!")/.test(replaced)
		)
			throw new RecordingError(502);
		lines.push(replaced);
	}
	return { text: lines.join("\n"), expires };
}

async function scopeFor(
	req: Request,
	analysisId: string,
	media: boolean,
): Promise<{
	scope: Scope;
	token: string | null;
	status: string;
	cacheGeneration: symbol;
}> {
	if (!uuid.safeParse(analysisId).success) throw new RecordingError(400);
	const url = new URL(req.url);
	const allowed = new Set([
		"bitmovinAccountId",
		"encodingId",
		EXPECTED_ORGANIZATION_QUERY,
		...(media ? ["token"] : []),
	]);
	if (
		[...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
		[...allowed].some((key) => url.searchParams.getAll(key).length !== 1)
	)
		throw new RecordingError(400);
	const accountId = url.searchParams.get("bitmovinAccountId");
	const encodingId = url.searchParams.get("encodingId");
	if (
		!accountId ||
		!encodingId ||
		!uuid.safeParse(accountId).success ||
		!uuid.safeParse(encodingId).success
	)
		throw new RecordingError(400);
	const binding = passiveOrganizationBinding(url, req.method);
	if (binding.kind !== "bound") throw new RecordingError(400);
	const ctx = await getServerContext();
	const organizationId = requestOrganizationId(ctx);
	if (binding.organizationId !== organizationId) throw new RecordingError(409);
	const client = await aisaLiveClientForAccount(ctx, accountId);
	if (!client) throw new RecordingError(404);
	const current = aisaAnalysisSchema.safeParse(await client.get(analysisId));
	if (
		!current.success ||
		current.data.analysisId !== analysisId ||
		current.data.encodingId !== encodingId
	)
		throw new RecordingError(502);
	const scope = { ctx, organizationId, accountId, analysisId, encodingId };
	if (current.data.status !== "FINISHED") {
		removePlaylist(aad(scope));
		playlistGeneration = Symbol();
	}
	return {
		scope,
		token: url.searchParams.get("token"),
		status: current.data.status,
		cacheGeneration: playlistGeneration,
	};
}

async function boundedText(response: Response) {
	const bytes = await readBoundedBody(response, MAX_MANIFEST_BYTES);
	if (bytes === null) throw new RecordingError(502);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new RecordingError(502);
	}
}

function upstreamStatus(response: Response) {
	if (!response.ok) {
		void response.body?.cancel().catch(() => {});
		throw new RecordingError(response.status === 404 ? 404 : 502);
	}
}

async function handle(req: Request, run: () => Promise<Response>) {
	if (!aisaLivePreviewEnabled()) return fail(404);
	if (req.method !== "GET" && req.method !== "HEAD") return fail(405);
	if (req.signal.aborted) return fail(408);
	try {
		return await run();
	} catch (error) {
		return fail(
			error instanceof RecordingError
				? error.status
				: req.signal.aborted
					? 408
					: 502,
		);
	}
}

function playlistResponse(req: Request, text: string) {
	return new Response(req.method === "HEAD" ? null : text, {
		headers: {
			...headers,
			"Content-Type": "application/vnd.apple.mpegurl",
			"Content-Length": String(Buffer.byteLength(text)),
		},
	});
}

export function serveAisaRecording(req: Request, analysisId: string) {
	return handle(req, async () => {
		const { scope, status, cacheGeneration } = await scopeFor(
			req,
			analysisId,
			false,
		);
		const account = await scope.ctx.bitmovinAccounts.get(scope.accountId);
		if (!account) throw new RecordingError(404);
		const key = aad(scope);
		const retained = status === "FINISHED" ? cachedPlaylist(key) : undefined;
		if (retained !== undefined) return playlistResponse(req, retained);
		const apiKey = await scope.ctx.bitmovinAccounts.revealApiKey(
			scope.accountId,
		);
		const response = await fetch(
			`https://api.bitmovin.com/v1/ai-scene-analysis/live-analyses/${analysisId}/recording/index.m3u8`,
			{
				method: "GET",
				headers: {
					"X-Api-Key": apiKey,
					"Correlation-Id": randomUUID(),
					...(account.tenantOrgId
						? { "X-Tenant-Org-Id": account.tenantOrgId }
						: {}),
				},
				redirect: "error",
				cache: "no-store",
				signal: AbortSignal.any([req.signal, AbortSignal.timeout(20000)]),
			},
		);
		upstreamStatus(response);
		const source = await boundedText(response);
		const rewritten = await rewrite(source, scope, 0);
		if (status === "FINISHED") {
			const expires = finalPlaylistExpiry(source, analysisId, Date.now());
			if (expires !== null && cacheGeneration === playlistGeneration)
				retainPlaylist(
					key,
					rewritten.text,
					Math.min(expires, rewritten.expires - PLAYLIST_CACHE_MARGIN_MS),
				);
		}
		return playlistResponse(req, rewritten.text);
	});
}

export function serveAisaRecordingMedia(req: Request, analysisId: string) {
	return handle(req, async () => {
		const { scope, token } = await scopeFor(req, analysisId, true);
		if (!token) throw new RecordingError(403);
		const claim = await open(scope, token);
		const url = validateAisaRecordingUrl(claim.url, analysisId);
		const range = req.headers.get("Range");
		if (range) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (!match || (!match[1] && !match[2])) throw new RecordingError(416);
			const start = match[1] ? Number(match[1]) : null;
			const end = match[2] ? Number(match[2]) : null;
			if (
				(start !== null && !Number.isSafeInteger(start)) ||
				(end !== null && !Number.isSafeInteger(end)) ||
				(start !== null &&
					end !== null &&
					(end < start || end - start + 1 > MAX_MEDIA_BYTES)) ||
				(start === null && (end === null || end <= 0 || end > MAX_MEDIA_BYTES))
			)
				throw new RecordingError(416);
		}
		const response = await fetch(url.href, {
			method: req.method,
			headers: range ? { Range: range } : {},
			redirect: "error",
			cache: "no-store",
			signal: AbortSignal.any([req.signal, AbortSignal.timeout(20000)]),
		});
		upstreamStatus(response);
		if (url.pathname.endsWith(".m3u8")) {
			if (req.method === "HEAD") {
				void response.body?.cancel().catch(() => {});
				return new Response(null, {
					headers: {
						...headers,
						"Content-Type": "application/vnd.apple.mpegurl",
					},
				});
			}
			return new Response(
				(await rewrite(await boundedText(response), scope, claim.depth)).text,
				{
					headers: {
						...headers,
						"Content-Type": "application/vnd.apple.mpegurl",
					},
				},
			);
		}
		const type = url.pathname.endsWith(".ts")
			? "video/mp2t"
			: url.pathname.endsWith(".aac")
				? "audio/aac"
				: "video/mp4";
		const safeHeaders: Record<string, string> = {
			...headers,
			"Content-Type": type,
			"Accept-Ranges": "bytes",
		};
		const length = response.headers.get("Content-Length");
		if (length && /^\d+$/.test(length)) safeHeaders["Content-Length"] = length;
		const contentRange = response.headers.get("Content-Range");
		let rangeLength: number | undefined;
		if (response.status === 206) {
			const match = contentRange
				? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange)
				: null;
			if (!match) throw new RecordingError(502);
			const from = Number(match[1]),
				to = Number(match[2]),
				total = Number(match[3]);
			if (
				![from, to, total].every(Number.isSafeInteger) ||
				to < from ||
				total <= to ||
				to - from + 1 > MAX_MEDIA_BYTES
			)
				throw new RecordingError(502);
			rangeLength = to - from + 1;
			safeHeaders["Content-Range"] = contentRange || "";
		}
		if (req.method === "HEAD") {
			void response.body?.cancel().catch(() => {});
			return new Response(null, {
				status: response.status,
				headers: safeHeaders,
			});
		}
		const bytes = await readBoundedBody(response, MAX_MEDIA_BYTES);
		if (
			bytes === null ||
			(rangeLength !== undefined && bytes.length !== rangeLength)
		)
			throw new RecordingError(502);
		safeHeaders["Content-Length"] = String(bytes.length);
		return new Response(Buffer.from(bytes), {
			status: response.status,
			headers: safeHeaders,
		});
	});
}
