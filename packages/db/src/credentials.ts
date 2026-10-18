import { randomUUID } from "node:crypto";
import type { SecretCipher } from "@bitovp/core";
import type {
	Credential,
	CredentialProvider,
	Prisma,
} from "../generated/client";
import type { AppPrismaClient } from "./client";

/** Credential row with the ciphertext stripped — safe for lists/UI. */
export type CredentialSummary = Omit<Credential, "encryptedSecret">;

export type CreateCredentialInput = {
	label: string;
	provider: CredentialProvider;
	/** Non-secret configuration (region, endpoint host, …). */
	config?: Prisma.InputJsonValue;
	/** Provider-specific secret material, serialized by the caller (JSON). */
	secret: string;
};

export type UpdateCredentialInput = {
	label?: string;
	config?: Prisma.InputJsonValue;
	/** When present, the secret is re-encrypted; otherwise left untouched. */
	secret?: string;
};

/**
 * AAD binds the ciphertext to the row id AND the (create-only) provider, so
 * neither swapping blobs between rows nor flipping a row's provider can
 * redirect a decrypted secret to another provider's endpoint semantics.
 * Residual risk (accepted): a DB-write attacker can still edit non-secret
 * `config` (e.g. endpoint host) — defending that requires re-encrypting on
 * every config change; revisit if the threat model grows multi-tenant.
 */
const aadFor = (id: string, provider: CredentialProvider) =>
	`credential:${id}:${provider}`;

/**
 * The only path to credential secrets. Encrypts on write, decrypts on
 * explicit reveal; every read path omits the ciphertext column (also
 * enforced client-wide in createPrismaClient).
 */
export function createCredentialStore(
	prisma: AppPrismaClient,
	cipher: SecretCipher,
) {
	return {
		async create(input: CreateCredentialInput): Promise<CredentialSummary> {
			const id = randomUUID();
			const encryptedSecret = await cipher.encrypt(
				input.secret,
				aadFor(id, input.provider),
			);
			return prisma.credential.create({
				data: {
					id,
					label: input.label,
					provider: input.provider,
					config: input.config ?? {},
					encryptedSecret,
				},
			});
		},

		async list(): Promise<CredentialSummary[]> {
			return prisma.credential.findMany({
				orderBy: { createdAt: "desc" },
			});
		},

		/**
		 * `list` plus, per row, WHETHER it holds secret material — ledger
		 * #196. The boolean, never the material.
		 *
		 * SEPARATE from `list` rather than folded into it, deliberately.
		 * `list` has three callers and two of them are the worker's preflight,
		 * which wants rows and asked for no decryption; folding this in would
		 * change a shared method's cost and failure modes for one caller's need.
		 * The rule this repo keeps paying for.
		 *
		 * IT DECRYPTS, and the alternative was tempting enough to write down:
		 * exactly two providers' secret schemas accept `{}` (`AWS_S3_ROLE_BASED`
		 * and `AKAMAI_MSL`), so for the other sixteen a stored row implies a
		 * non-empty secret and the answer could come from the shape alone. That
		 * shortcut is an assumption about schema HISTORY, not a fact about the
		 * row — a row written before a provider's secret schema tightened would
		 * turn it into a confident lie, and a guard whose blind spot is the
		 * oldest rows is the wrong kind of cheap.
		 *
		 * A DECRYPT FAILURE READS AS ABSENT, same direction as rail 3b's
		 * resolver and for the same reason: a secret this process cannot read is
		 * not usefully "configured", and throwing would take out the whole
		 * credentials screen over one unreadable row.
		 */
		async listWithSecretPresence(): Promise<
			(CredentialSummary & { hasSecret: boolean })[]
		> {
			/*
			 * ONE round trip, with an explicit `select` — review of PR #319, F7.
			 *
			 * This was two `findMany`s: one for the rows and one for the
			 * ciphertexts, because `CIPHERTEXT_OMIT` strips the column
			 * client-wide (`client.ts`) and an explicit `select` is what
			 * overrides it. Naming the columns gets both in one query and closes
			 * the window where a row deleted between the two reported
			 * `hasSecret: false`. The window was benign; the second query was
			 * not needed to have it.
			 *
			 * The ciphertext is read into a LOCAL and never spread into the
			 * result — the returned object names its fields, so there is no
			 * `...row` that could carry the column out.
			 */
			const rows = await prisma.credential.findMany({
				orderBy: { createdAt: "desc" },
				select: {
					id: true,
					organizationId: true,
					label: true,
					provider: true,
					config: true,
					createdAt: true,
					updatedAt: true,
					encryptedSecret: true,
				},
			});
			return Promise.all(
				rows.map(async ({ encryptedSecret, ...row }) => ({
					...row,
					hasSecret: await (async () => {
						const encrypted = encryptedSecret;
						if (encrypted === undefined) {
							return false;
						}
						try {
							const parsed: unknown = JSON.parse(
								await cipher.decrypt(encrypted, aadFor(row.id, row.provider)),
							);
							// At least one non-empty string VALUE, not just a key: a
							// stored `{"username":""}` is a row with no usable secret,
							// and the schemas refuse it — but a row predating a schema
							// is exactly what this method declines to assume about.
							return (
								typeof parsed === "object" &&
								parsed !== null &&
								Object.values(parsed).some(
									(v) => typeof v === "string" && v.length > 0,
								)
							);
						} catch {
							return false;
						}
					})(),
				})),
			);
		},

		async get(id: string): Promise<CredentialSummary | null> {
			return prisma.credential.findUnique({ where: { id } });
		},

		/** Server-side only — never expose the result to the client. */
		async revealSecret(id: string): Promise<string> {
			const row = await prisma.credential.findUniqueOrThrow({
				where: { id },
				select: { encryptedSecret: true, provider: true },
			});
			return cipher.decrypt(row.encryptedSecret, aadFor(id, row.provider));
		},

		/**
		 * Which `AKAMAI_MSL` credentials carry a COMPLETE MSL5 Digest pair —
		 * , rail 3b's server-side input.
		 *
		 * IDS ONLY. The pair is decrypted here and never leaves: the caller gets
		 * a Set of credential ids and the validator's message names the
		 * credential, not its contents. This is the narrowest thing that answers
		 * "will this MSL5 output publish authenticated", and the only way to
		 * answer it is to look, because the vault stores ciphertext and there is
		 * no non-secret marker of a non-empty secret.
		 *
		 * SCOPED BY PROVIDER, so the common deployment pays one indexed query
		 * returning zero rows and performs zero decryptions. It follows the same
		 * "pay only when it can matter" shape as `submitterValidationOptions`'s
		 * profile short-circuit.
		 *
		 * A DECRYPT FAILURE COUNTS AS ABSENT, deliberately, and the direction
		 * matters: absent means rail 3b WARNS. A credential this process cannot
		 * read is one the executor will not be able to use either, so warning is
		 * the honest outcome — and it is strictly better than throwing, which
		 * would turn an unreadable credential into a blocked submission for
		 * plans that may not even name it. Both halves are required: a row
		 * holding only a username is a half pair the executor refuses, so
		 * counting it as present would suppress the warning for a plan that
		 * cannot run.
		 *
		 * Lives in `@bitovp/db` rather than in the web app because the
		 * watch-folder sweep is a SECOND submitter process — the same reason
		 * `recordUnrestrictedEgress` and `submitEncodingJob` moved here. A
		 * copied loop would drift, and the copy that drifts is the unattended
		 * one.
		 */
		async publishingAuthCredentialIds(): Promise<ReadonlySet<string>> {
			const rows = await prisma.credential.findMany({
				where: { provider: "AKAMAI_MSL" },
				select: { id: true, encryptedSecret: true, provider: true },
			});
			const withPair = new Set<string>();
			for (const row of rows) {
				try {
					const parsed: unknown = JSON.parse(
						await cipher.decrypt(
							row.encryptedSecret,
							aadFor(row.id, row.provider),
						),
					);
					const secret = parsed as { username?: unknown; password?: unknown };
					if (
						typeof secret?.username === "string" &&
						secret.username.length > 0 &&
						typeof secret.password === "string" &&
						secret.password.length > 0
					) {
						withPair.add(row.id);
					}
				} catch {
					// Absent — see the note above on why that is the safe direction.
				}
			}
			return withPair;
		},

		async update(
			id: string,
			patch: UpdateCredentialInput,
		): Promise<CredentialSummary> {
			const data: Prisma.CredentialUpdateInput = {};
			if (patch.label !== undefined) {
				data.label = patch.label;
			}
			if (patch.config !== undefined) {
				data.config = patch.config;
			}
			if (patch.secret !== undefined) {
				const { provider } = await prisma.credential.findUniqueOrThrow({
					where: { id },
					select: { provider: true },
				});
				data.encryptedSecret = await cipher.encrypt(
					patch.secret,
					aadFor(id, provider),
				);
			}
			return prisma.credential.update({ where: { id }, data });
		},

		async remove(id: string): Promise<void> {
			await prisma.credential.delete({ where: { id } });
		},
	};
}

export type CredentialStore = ReturnType<typeof createCredentialStore>;
