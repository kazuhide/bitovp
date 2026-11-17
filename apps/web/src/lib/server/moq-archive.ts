import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	opendir,
	realpath,
	rename,
	rmdir,
	unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	MOQ_OBSERVATION_LIMITS,
	type MoqArchiveMetadata,
} from "@/lib/moq-player/observations";
import {
	EXPECTED_ORGANIZATION_QUERY,
	passiveOrganizationBinding,
} from "@/lib/passive-request";
import { hasWebmHeader, normalizeMoqArchive } from "./moq-archive-media";
import { writeMoqObservationStore } from "./moq-observation-store";
import {
	assertMoqObservationWritable,
	auditMoqHistory,
	MoqObservationError,
	type MoqObservationParams,
	moqHistoryError,
	moqObservationContext,
	parseMoqObservationStore,
	readMoqBoundedBody,
	readMoqObservationRun,
} from "./moq-observations";

// Admission is per server process: at most two bodies/remuxes, one per scoped session.
const archiveUploads = new Set<string>();

/** Exact metadata proof from a committed run deletion, never a caller-selected path. */
export async function removeMoqArchiveFile(
	organizationId: string,
	params: MoqObservationParams,
	metadata: MoqArchiveMetadata | null,
): Promise<boolean> {
	let directory: string;
	try {
		directory = await archiveDirectory(organizationId, params, false);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return false;
		throw error;
	}
	const path = join(directory, "archive.webm");
	let removed = false;
	try {
		await readArchiveBytes(path, metadata ?? undefined);
		await unlink(/* turbopackIgnore: true */ path);
		removed = true;
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") throw error;
	}
	const entries = await opendir(/* turbopackIgnore: true */ directory);
	for await (const entry of entries) {
		if (
			!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?:\.normalized)?\.part$/.test(
				entry.name,
			)
		)
			continue;
		const temporary = join(directory, entry.name);
		const stat = await lstat(/* turbopackIgnore: true */ temporary);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			(stat.mode & 0o077) !== 0 ||
			(process.getuid && stat.uid !== process.getuid()) ||
			stat.size > 2 * MOQ_OBSERVATION_LIMITS.archiveBytes
		)
			throw new MoqObservationError(409, "MOQ_ARCHIVE_OWNERSHIP_INVALID");
		await unlink(/* turbopackIgnore: true */ temporary);
		removed = true;
	}
	for (let i = 0; i < 4; i++) {
		try {
			await rmdir(/* turbopackIgnore: true */ directory);
		} catch {
			break;
		}
		directory = dirname(directory);
	}
	return removed;
}

/** Every descendant is an application-generated UUID, inside a private configured root. */
async function archiveDirectory(
	organizationId: string,
	params: MoqObservationParams,
	create: boolean,
) {
	const root = process.env.BITOVP_MOQ_ARCHIVE_DIR;
	if (
		!root ||
		!isAbsolute(root) ||
		(await realpath(/* turbopackIgnore: true */ root)) !== resolve(root)
	)
		throw new MoqObservationError(503, "MOQ_ARCHIVE_STORAGE_UNAVAILABLE");
	const rootStat = await lstat(/* turbopackIgnore: true */ root);
	if (
		!rootStat.isDirectory() ||
		rootStat.isSymbolicLink() ||
		(rootStat.mode & 0o077) !== 0 ||
		(process.getuid && rootStat.uid !== process.getuid())
	)
		throw new MoqObservationError(503, "MOQ_ARCHIVE_STORAGE_UNAVAILABLE");
	let directory = resolve(root);
	for (const id of [
		organizationId,
		params.id,
		params.runId,
		params.sessionId,
	]) {
		if (!id || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))
			throw new MoqObservationError(400, "MOQ_HISTORY_INVALID_REQUEST");
		directory = join(directory, id.toLowerCase());
		if (create)
			await mkdir(/* turbopackIgnore: true */ directory, { mode: 0o700 }).catch(
				(error: unknown) => {
					if ((error as { code?: string }).code !== "EEXIST") throw error;
				},
			);
		const stat = await lstat(/* turbopackIgnore: true */ directory);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			(stat.mode & 0o077) !== 0 ||
			stat.uid !== rootStat.uid ||
			(await realpath(/* turbopackIgnore: true */ directory)) !== directory
		)
			throw new MoqObservationError(503, "MOQ_ARCHIVE_STORAGE_UNAVAILABLE");
	}
	return directory;
}
export async function putMoqArchive(
	req: Request,
	params: MoqObservationParams,
) {
	let temporary: string | undefined;
	let normalized: string | undefined;
	let uploadKey: string | undefined;
	try {
		const ctx = await moqObservationContext(req, params, true);
		if (!params.sessionId || !ctx.tenant)
			throw new MoqObservationError(400, "MOQ_HISTORY_INVALID_REQUEST");
		const run = await readMoqObservationRun(ctx, params);
		const previous = parseMoqObservationStore(
			run.moqObservations,
		).sessions.find((session) => session.id === params.sessionId);
		if (!previous)
			throw new MoqObservationError(404, "MOQ_HISTORY_SESSION_NOT_FOUND");
		await assertMoqObservationWritable(ctx, params, run, previous);
		if (
			!/^video\/webm(?:\s*;[^\r\n]*)?$/i.test(
				req.headers.get("content-type") ?? "",
			)
		)
			throw new MoqObservationError(415, "MOQ_ARCHIVE_WEBM_REQUIRED");
		const declared = req.headers.get("x-bitovp-moq-duration-ms") ?? "";
		if (
			!/^\d+$/.test(declared) ||
			Number(declared) < 1 ||
			Number(declared) > MOQ_OBSERVATION_LIMITS.archiveDurationMs
		)
			throw new MoqObservationError(400, "MOQ_ARCHIVE_DURATION_INVALID");
		const key = `${ctx.tenant.organizationId}:${run.id}:${previous.id}`;
		if (archiveUploads.has(key))
			throw new MoqObservationError(409, "MOQ_ARCHIVE_SESSION_BUSY");
		if (archiveUploads.size >= 2)
			throw new MoqObservationError(429, "MOQ_ARCHIVE_UPLOAD_BUSY");
		archiveUploads.add(key);
		uploadKey = key;
		const bytes = await readMoqBoundedBody(
			req,
			MOQ_OBSERVATION_LIMITS.archiveBytes,
		);
		if (!hasWebmHeader(bytes))
			throw new MoqObservationError(400, "MOQ_ARCHIVE_WEBM_REQUIRED");
		const uploadSha256 = createHash("sha256").update(bytes).digest("hex");
		if (previous.archive) {
			if (previous.archiveUploadSha256 !== uploadSha256)
				throw new MoqObservationError(409, "MOQ_ARCHIVE_ALREADY_SAVED");
			const directory = await archiveDirectory(
				ctx.tenant.organizationId,
				params,
				false,
			);
			await readArchiveBytes(join(directory, "archive.webm"), previous.archive);
			await auditMoqHistory(ctx, req, params, 200);
			return Response.json(
				{ runId: run.id, sessionId: previous.id, archive: previous.archive },
				{ headers: { "Cache-Control": "private, no-store" } },
			);
		}
		const directory = await archiveDirectory(
			ctx.tenant.organizationId,
			params,
			true,
		);
		temporary = join(directory, `${randomUUID()}.part`);
		const file = await open(
			/* turbopackIgnore: true */ temporary,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await file.writeFile(bytes);
			await file.sync();
		} finally {
			await file.close();
		}
		normalized = join(directory, `${randomUUID()}.normalized.part`);
		const normalizedFile = await open(
			/* turbopackIgnore: true */ normalized,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		await normalizedFile.close();
		let durationMs: number;
		try {
			durationMs = await normalizeMoqArchive(temporary, normalized);
		} catch (error) {
			throw new MoqObservationError(
				(error as { code?: string }).code === "ENOENT" ? 503 : 400,
				"MOQ_ARCHIVE_MEDIA_INVALID",
			);
		}
		if (
			!Number.isFinite(durationMs) ||
			durationMs < 1 ||
			durationMs > MOQ_OBSERVATION_LIMITS.archiveDurationMs
		)
			throw new MoqObservationError(400, "MOQ_ARCHIVE_DURATION_INVALID");
		const normalizedBytes = await readArchiveBytes(normalized);
		const sha256 = createHash("sha256").update(normalizedBytes).digest("hex");
		const metadata: MoqArchiveMetadata = {
			contentType: "video/webm",
			bytes: normalizedBytes.length,
			sha256,
			durationMs,
			recordedAt: new Date().toISOString(),
		};
		const saved = await ctx.prisma.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "LiveChannelRun" WHERE id = ${params.runId}::uuid FOR UPDATE`;
			const fresh = await readMoqObservationRun(ctx, params, tx);
			const store = parseMoqObservationStore(fresh.moqObservations);
			const session = store.sessions.find(
				(entry) => entry.id === params.sessionId,
			);
			if (!session)
				throw new MoqObservationError(404, "MOQ_HISTORY_SESSION_NOT_FOUND");
			await assertMoqObservationWritable(ctx, params, fresh, session, tx);
			if (session.archive) {
				if (session.archiveUploadSha256 !== uploadSha256)
					throw new MoqObservationError(409, "MOQ_ARCHIVE_ALREADY_SAVED");
				return session.archive;
			}
			const checkedDirectory = await archiveDirectory(
				ctx.tenant?.organizationId ?? "",
				params,
				false,
			);
			await rename(
				/* turbopackIgnore: true */ normalized as string,
				join(checkedDirectory, "archive.webm"),
			);
			normalized = undefined;
			session.archive = metadata;
			session.archiveUploadSha256 = uploadSha256;
			session.updatedAt = new Date().toISOString();
			await writeMoqObservationStore(
				tx,
				{ runId: fresh.id, organizationId: ctx.tenant?.organizationId },
				store,
			);
			return metadata;
		});
		await auditMoqHistory(ctx, req, params, 200);
		return Response.json(
			{ runId: run.id, sessionId: params.sessionId, archive: saved },
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (error) {
		return moqHistoryError(error);
	} finally {
		try {
			for (const path of [temporary, normalized])
				if (path)
					await unlink(/* turbopackIgnore: true */ path).catch(() => {});
		} finally {
			if (uploadKey) archiveUploads.delete(uploadKey);
		}
	}
}
async function readArchiveBytes(path: string, expected?: MoqArchiveMetadata) {
	const file = await open(
		/* turbopackIgnore: true */ path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = await file.stat();
		if (!expected && stat.size > MOQ_OBSERVATION_LIMITS.archiveBytes)
			throw new MoqObservationError(413, "MOQ_ARCHIVE_TOO_LARGE");
		if (
			!stat.isFile() ||
			stat.size < 1 ||
			(stat.mode & 0o077) !== 0 ||
			(expected && stat.size !== expected.bytes) ||
			stat.size > MOQ_OBSERVATION_LIMITS.archiveBytes
		)
			throw new MoqObservationError(404, "MOQ_ARCHIVE_NOT_FOUND");
		const buffer = Buffer.alloc(stat.size + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = await file.read(
				buffer,
				length,
				buffer.length - length,
				length,
			);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		const bytes = buffer.subarray(0, length);
		if (
			length !== stat.size ||
			!hasWebmHeader(bytes) ||
			(expected &&
				createHash("sha256").update(bytes).digest("hex") !== expected.sha256)
		)
			throw new MoqObservationError(404, "MOQ_ARCHIVE_NOT_FOUND");
		return bytes;
	} finally {
		await file.close();
	}
}
export async function getMoqArchive(
	req: Request,
	params: MoqObservationParams,
) {
	try {
		const url = new URL(req.url),
			binding = passiveOrganizationBinding(url, req.method);
		if (
			binding.kind === "invalid" ||
			(url.searchParams.size > 0 && binding.kind !== "bound")
		)
			throw new MoqObservationError(400, "MOQ_HISTORY_INVALID_REQUEST");
		const ctx = await moqObservationContext(req, params, false, [
			EXPECTED_ORGANIZATION_QUERY,
		]);
		if (
			binding.kind === "bound" &&
			binding.organizationId !== ctx.tenant?.organizationId
		)
			throw new MoqObservationError(409, "MOQ_HISTORY_ORGANIZATION_CHANGED");
		const run = await readMoqObservationRun(ctx, params);
		const session = parseMoqObservationStore(run.moqObservations).sessions.find(
			(entry) => entry.id === params.sessionId,
		);
		if (!session?.archive || !ctx.tenant)
			throw new MoqObservationError(404, "MOQ_ARCHIVE_NOT_FOUND");
		let bytes: Buffer;
		try {
			const directory = await archiveDirectory(
				ctx.tenant.organizationId,
				params,
				false,
			);
			bytes = await readArchiveBytes(
				join(directory, "archive.webm"),
				session.archive,
			);
		} catch (error) {
			if (error instanceof MoqObservationError) throw error;
			throw new MoqObservationError(404, "MOQ_ARCHIVE_NOT_FOUND");
		}
		const size = bytes.length,
			range = req.headers.get("range");
		let start = 0,
			end = size - 1;
		const invalidRange = () =>
			new Response(null, {
				status: 416,
				headers: {
					"Content-Range": `bytes */${size}`,
					"Cache-Control": "private, no-store",
				},
			});
		if (range) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (!match || (!match[1] && !match[2])) return invalidRange();
			if (!match[1]) {
				const suffix = Number(match[2]);
				if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalidRange();
				start = Math.max(0, size - suffix);
			} else {
				start = Number(match[1]);
				if (match[2]) end = Math.min(Number(match[2]), end);
			}
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start < 0 ||
				start > end ||
				start >= size
			)
				return invalidRange();
		}
		await auditMoqHistory(ctx, req, params, range ? 206 : 200);
		return new Response(
			req.method === "HEAD"
				? null
				: Uint8Array.from(bytes.subarray(start, end + 1)),
			{
				status: range ? 206 : 200,
				headers: {
					"Content-Type": "video/webm",
					"Content-Length": String(end - start + 1),
					"Cache-Control": "private, no-store",
					"X-Content-Type-Options": "nosniff",
					"Accept-Ranges": "bytes",
					...(range
						? { "Content-Range": `bytes ${start}-${end}/${size}` }
						: {}),
				},
			},
		);
	} catch (error) {
		return moqHistoryError(error);
	}
}
