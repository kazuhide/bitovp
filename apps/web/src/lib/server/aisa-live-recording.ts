import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { aisaAnalysisSchema } from "@/lib/aisa-live/contracts";
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

async function issue(scope: Scope, url: string, depth: number) {
	if (depth > 3) throw new RecordingError(502);
	validateAisaRecordingUrl(url, scope.analysisId);
	const encrypted = await scope.ctx.cipher.encrypt(
		JSON.stringify({ url, expires: Date.now() + TOKEN_LIFETIME_MS, depth }),
		aad(scope),
	);
	const token = Buffer.from(encrypted).toString("base64url");
	return bindPassiveRequestUrl(
		`/api/live/analyses/${scope.analysisId}/recording/media?bitmovinAccountId=${scope.accountId}&encodingId=${scope.encodingId}&token=${token}`,
		scope.organizationId,
	);
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
	const path = async (value: string) => {
		if (assets.has(value)) return assets.get(value) as string;
		if (assets.size >= MAX_ASSETS) throw new RecordingError(502);
		const result = await issue(scope, value, depth + 1);
		assets.set(value, result);
		return result;
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
	return lines.join("\n");
}

async function scopeFor(
	req: Request,
	analysisId: string,
	media: boolean,
): Promise<{ scope: Scope; token: string | null }> {
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
	return {
		scope: { ctx, organizationId, accountId, analysisId, encodingId },
		token: url.searchParams.get("token"),
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

export function serveAisaRecording(req: Request, analysisId: string) {
	return handle(req, async () => {
		const { scope } = await scopeFor(req, analysisId, false);
		const account = await scope.ctx.bitmovinAccounts.get(scope.accountId);
		if (!account) throw new RecordingError(404);
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
		const text = await rewrite(await boundedText(response), scope, 0);
		return new Response(req.method === "HEAD" ? null : text, {
			headers: {
				...headers,
				"Content-Type": "application/vnd.apple.mpegurl",
				"Content-Length": String(Buffer.byteLength(text)),
			},
		});
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
				await rewrite(await boundedText(response), scope, claim.depth),
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
