import "server-only";
import { randomUUID } from "node:crypto";
import {
	favoriteReferenceKey,
	MAX_VOD_INPUT_FAVORITES,
	parseVodInputFavorites,
	VOD_INPUT_FAVORITES_KEY,
	type VodInputFavorite,
	type VodInputFavorites,
	type VodInputFavoriteWire,
	vodFavoriteInputKind,
	vodInputFavoriteCreateSchema,
} from "@bitovp/core/vod-input-timeline";
import { z } from "zod";
import { roleAtLeast } from "@/lib/auth/roles";
import { AuthContextError } from "@/lib/auth/tenancy";
import { getServerContext, type ServerContext } from "./context";

export class VodInputFavoriteError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
	) {
		super(code);
		this.name = "VodInputFavoriteError";
	}
}
async function context() {
	const ctx = await getServerContext();
	if (
		!ctx.tenant ||
		ctx.tenant.isImpersonating ||
		!roleAtLeast(ctx.tenant.role, "OPERATOR")
	)
		throw new AuthContextError(403, "VOD input editing requires an operator");
	return ctx;
}
async function read(ctx: ServerContext) {
	const row = await ctx.prisma.appSetting.findUnique({
		where: { key: VOD_INPUT_FAVORITES_KEY },
		select: { value: true },
	});
	const raw = row?.value;
	if (raw === null) throw new VodInputFavoriteError(409, "FAVORITES_INVALID");
	try {
		return { raw, document: parseVodInputFavorites(raw) };
	} catch {
		throw new VodInputFavoriteError(409, "FAVORITES_INVALID");
	}
}
async function wire(
	ctx: ServerContext,
	item: VodInputFavorite,
): Promise<VodInputFavoriteWire> {
	const credential = await ctx.credentials.get(item.credentialId);
	const inputKind = credential
		? vodFavoriteInputKind(credential.provider, item.kind)
		: null;
	return {
		...item,
		inputKind,
		availability: !credential
			? "CREDENTIAL_UNAVAILABLE"
			: inputKind
				? "AVAILABLE"
				: "UNSUPPORTED_PROVIDER",
	};
}

export async function listVodInputFavorites() {
	const ctx = await context(),
		{ document } = await read(ctx);
	return {
		favorites: await Promise.all(document.items.map((item) => wire(ctx, item))),
	};
}

/** Atomic JSONB compare-and-swap, including the concurrent first-create case. */
async function change(
	ctx: ServerContext,
	edit: (document: VodInputFavorites) => VodInputFavorites,
) {
	for (let attempt = 0; attempt < 6; attempt++) {
		const { raw, document } = await read(ctx),
			next = edit(document);
		if (next === document) return document;
		if (raw === undefined) {
			try {
				await ctx.prisma.appSetting.create({
					data: { key: VOD_INPUT_FAVORITES_KEY, value: next },
				});
				return next;
			} catch (error) {
				if ((error as { code?: string }).code !== "P2002") throw error;
			}
		} else {
			const result = await ctx.prisma.appSetting.updateMany({
				where: { key: VOD_INPUT_FAVORITES_KEY, value: { equals: raw } },
				data: { value: next },
			});
			if (result.count === 1) return next;
		}
	}
	throw new VodInputFavoriteError(409, "FAVORITES_CONFLICT");
}

export async function addVodInputFavorite(
	value: unknown,
): Promise<VodInputFavorite> {
	const ctx = await context(),
		input = vodInputFavoriteCreateSchema.parse(value);
	const credential = await ctx.credentials.get(input.credentialId);
	if (!credential)
		throw new VodInputFavoriteError(404, "SOURCE_CREDENTIAL_NOT_FOUND");
	if (!vodFavoriteInputKind(credential.provider, input.kind))
		throw new VodInputFavoriteError(422, "FAVORITE_PROVIDER_UNSUPPORTED");
	const item = { ...input, id: randomUUID() };
	const result = await change(ctx, (document) => {
		if (
			document.items.some(
				(candidate) =>
					favoriteReferenceKey(candidate) === favoriteReferenceKey(item),
			)
		)
			return document;
		if (document.items.length >= MAX_VOD_INPUT_FAVORITES)
			throw new VodInputFavoriteError(409, "FAVORITES_LIMIT");
		return { schemaVersion: 1, items: [...document.items, item] };
	});
	const saved = result.items.find(
		(candidate) =>
			favoriteReferenceKey(candidate) === favoriteReferenceKey(item),
	);
	if (!saved) throw new VodInputFavoriteError(409, "FAVORITES_CONFLICT");
	return { ...saved };
}
export async function deleteVodInputFavorite(id: string): Promise<void> {
	const ctx = await context();
	z.uuid().parse(id);
	await change(ctx, (document) =>
		document.items.some((item) => item.id === id)
			? {
					schemaVersion: 1,
					items: document.items.filter((item) => item.id !== id),
				}
			: document,
	);
}
