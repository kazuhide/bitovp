import { randomUUID } from "node:crypto";
import type { SecretCipher } from "@bitovp/core";
import type { BitmovinAccount, Prisma } from "../generated/client";
import type { AppPrismaClient } from "./client";

export type BitmovinAccountSummary = Omit<BitmovinAccount, "encryptedApiKey">;

export type CreateBitmovinAccountInput = {
	label: string;
	apiKey: string;
	tenantOrgId?: string;
	defaults?: Prisma.InputJsonValue;
};

export type UpdateBitmovinAccountInput = {
	label?: string;
	apiKey?: string;
	tenantOrgId?: string | null;
	defaults?: Prisma.InputJsonValue;
};

const aadFor = (id: string) => `bitmovin-account:${id}`;

export function createBitmovinAccountStore(
	prisma: AppPrismaClient,
	cipher: SecretCipher,
) {
	return {
		async create(
			input: CreateBitmovinAccountInput,
		): Promise<BitmovinAccountSummary> {
			const id = randomUUID();
			const encryptedApiKey = await cipher.encrypt(input.apiKey, aadFor(id));
			return prisma.bitmovinAccount.create({
				data: {
					id,
					label: input.label,
					encryptedApiKey,
					tenantOrgId: input.tenantOrgId,
					defaults: input.defaults ?? {},
				},
			});
		},

		async list(): Promise<BitmovinAccountSummary[]> {
			return prisma.bitmovinAccount.findMany({
				orderBy: { createdAt: "desc" },
			});
		},

		async get(id: string): Promise<BitmovinAccountSummary | null> {
			return prisma.bitmovinAccount.findUnique({ where: { id } });
		},

		/** Server-side only — feeds the Bitmovin SDK client, never the browser. */
		async revealApiKey(id: string): Promise<string> {
			const row = await prisma.bitmovinAccount.findUniqueOrThrow({
				where: { id },
				select: { encryptedApiKey: true },
			});
			return cipher.decrypt(row.encryptedApiKey, aadFor(id));
		},

		async update(
			id: string,
			patch: UpdateBitmovinAccountInput,
		): Promise<BitmovinAccountSummary> {
			const data: Prisma.BitmovinAccountUpdateInput = {};
			if (patch.label !== undefined) {
				data.label = patch.label;
			}
			if (patch.tenantOrgId !== undefined) {
				data.tenantOrgId = patch.tenantOrgId;
			}
			if (patch.defaults !== undefined) {
				data.defaults = patch.defaults;
			}
			if (patch.apiKey !== undefined) {
				data.encryptedApiKey = await cipher.encrypt(patch.apiKey, aadFor(id));
			}
			return prisma.bitmovinAccount.update({ where: { id }, data });
		},

		async remove(id: string): Promise<void> {
			await prisma.bitmovinAccount.delete({ where: { id } });
		},
	};
}

export type BitmovinAccountStore = ReturnType<
	typeof createBitmovinAccountStore
>;
