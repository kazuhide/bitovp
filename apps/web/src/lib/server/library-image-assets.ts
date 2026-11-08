import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editingMediaStorageSchema, editingObjectSchema } from "@bitovp/core";
import { z } from "zod";
import {
	EXPECTED_ORGANIZATION_QUERY,
	passiveOrganizationBinding,
	requestOrganizationId,
} from "@/lib/passive-request";
import { getServerContext } from "./context";
import { canonicalEditingPng } from "./editing-png";
import {
	boundMediaUrl,
	EditingRequestError,
	json,
} from "./library-editing-common";
import { serveObjectDownload } from "./object-download";
import { readBoundedJson } from "./request-body";
import { browserForCredentialId } from "./storage";

export async function createImageAsset(
	req: Request,
	projectId: string,
	actor: string | null,
) {
	z.uuid().parse(projectId);
	const body = await readBoundedJson(req, 12 * 1024 * 1024);
	if (body.tooLarge) throw new EditingRequestError(413, "IMAGE_TOO_LARGE");
	const input = z
		.strictObject({
			pngBase64: z
				.string()
				.min(1)
				.max(11_184_812)
				.regex(
					/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
				),
		})
		.parse(body.value);
	let image: ReturnType<typeof canonicalEditingPng>;
	try {
		image = canonicalEditingPng(Buffer.from(input.pngBase64, "base64"));
	} catch {
		throw new EditingRequestError(422, "INVALID_EDITING_PNG");
	}
	const ctx = await getServerContext();
	const project = await ctx.prisma.editProject.findUnique({
		where: { id: projectId },
		include: { mediaVersion: true },
	});
	if (!project || project.archived)
		throw new EditingRequestError(404, "PROJECT_NOT_FOUND");
	const storage = editingMediaStorageSchema.parse(project.mediaVersion.storage),
		id = randomUUID();
	const browser = await browserForCredentialId(
		ctx,
		storage.output.credentialId,
	);
	if (!browser?.putObject || !browser.headObject) {
		browser?.dispose?.();
		throw new EditingRequestError(422, "OUTPUT_WRITE_UNSUPPORTED");
	}
	const directory = await mkdtemp(join(tmpdir(), "bitovp-image-"));
	try {
		await chmod(directory, 0o700);
		const path = join(directory, "image.png"),
			key = `${storage.output.prefix.replace(/\/+$/, "")}/images/${projectId}/${id}.png`;
		await writeFile(path, image.bytes, { mode: 0o600 });
		await browser.putObject({
			bucket: storage.output.bucket,
			key,
			filePath: path,
			contentType: "image/png",
		});
		const head = await browser.headObject({
			bucket: storage.output.bucket,
			key,
		});
		const object = editingObjectSchema.parse({
			credentialId: storage.output.credentialId,
			bucket: storage.output.bucket,
			key,
			size: head.size,
			expect: {
				etag: head.etag,
				versionId: head.versionId === "null" ? undefined : head.versionId,
				generation: head.generation,
			},
		});
		if (
			head.size !== image.bytes.length ||
			!(
				object.expect?.etag ||
				object.expect?.versionId ||
				object.expect?.generation
			)
		)
			throw new EditingRequestError(502, "IMAGE_STORAGE_UNVERIFIED");
		await ctx.prisma.$transaction(async (tx) => {
			await tx.libraryImageAsset.create({
				data: {
					id,
					projectId,
					storage: json(object),
					sha256: createHash("sha256").update(image.bytes).digest("hex"),
					size: BigInt(image.bytes.length),
					width: image.width,
					height: image.height,
					createdBy: actor,
				},
			});
			await tx.editProjectResource.create({
				data: { projectId, imageAssetId: id },
			});
		});
		return {
			id,
			width: image.width,
			height: image.height,
			url: boundMediaUrl(ctx, `/api/library/image-assets/${id}/media`),
		};
	} finally {
		browser.dispose?.();
		await rm(directory, { recursive: true, force: true });
	}
}

export async function serveImageAsset(req: Request, id: string) {
	z.uuid().parse(id);
	const ctx = await getServerContext(),
		url = new URL(req.url);
	if (
		passiveOrganizationBinding(url, req.method).kind !== "bound" ||
		url.searchParams.get(EXPECTED_ORGANIZATION_QUERY) !==
			requestOrganizationId(ctx) ||
		[...url.searchParams.keys()].some(
			(key) => key !== EXPECTED_ORGANIZATION_QUERY,
		)
	)
		throw new EditingRequestError(409, "MEDIA_ORGANIZATION_CHANGED");
	const row = await ctx.prisma.libraryImageAsset.findUnique({ where: { id } });
	if (!row) throw new EditingRequestError(404, "IMAGE_NOT_FOUND");
	const target = editingObjectSchema.parse(row.storage);
	if (
		!target.size ||
		!target.expect ||
		BigInt(target.size) !== row.size ||
		target.size > 8 * 1024 * 1024
	)
		throw new EditingRequestError(422, "IMAGE_STORAGE_UNVERIFIED");
	const response = await serveObjectDownload(
		ctx,
		req,
		{
			...target,
			size: target.size,
			expect: { ...target.expect, size: target.size },
			contentType: "image/png",
		},
		id,
	);
	response.headers.set("Content-Disposition", "inline");
	return response;
}
