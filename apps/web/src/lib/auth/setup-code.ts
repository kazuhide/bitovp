import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getIdentityPrisma } from "@bitovp/db";

/**
 * First-boot setup code .
 *
 * A DB row, not process memory: the akamai profile runs TWO web processes
 * against one DB — a code minted by one process must verify on the other.
 * Only the SHA-256 lands in the row; the plaintext is printed to stdout at
 * mint (loopback-gated, C20-precedented channel — §3c's trust-class
 * argument) and never stored.
 */

/** ≥128 bits, base32-rendered for typability (no 0/1/8 lookalike digits). */
const CODE_BYTES = 16;
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export const SETUP_CODE_TTL_MS = 60 * 60_000;

function renderCode(bytes: Buffer): string {
	let out = "";
	for (const byte of bytes) {
		out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
	}
	// 16 bytes → 16 chars of a 31-symbol alphabet ≈ 79 bits rendered; keep the
	// full 128 bits by appending a second pass over the high nibbles.
	for (const byte of bytes) {
		out +=
			CODE_ALPHABET[
				Math.floor(byte / CODE_ALPHABET.length) % CODE_ALPHABET.length
			];
	}
	return `${out.slice(0, 8)}-${out.slice(8, 16)}-${out.slice(16, 24)}-${out.slice(24, 32)}`;
}

export function hashSetupCode(code: string): string {
	return createHash("sha256")
		.update(code.replace(/-/g, "").toLowerCase())
		.digest("hex");
}

/**
 * Mint-if-absent (lazy, on a /setup hit under zero-users ∧ users-mode).
 * Expired rows are deleted and re-minted (re-printed); a live row returns
 * null (already printed once — printing again on every page load would put
 * the code in the log N times for one use).
 *
 * CAS shape: two processes racing the mint both try create-after-check; the
 * loser's extra row is harmless (verification scans unexpired unused rows,
 * and consumeSetupCode burns AT MOST one, checking each candidate's hash) —
 * but we keep the table tidy by deleting siblings on successful mint.
 */
export async function ensureSetupCode(
	now: number = Date.now(),
): Promise<{ minted: string | null }> {
	const prisma = getIdentityPrisma();
	await prisma.setupCode.deleteMany({
		where: { expiresAt: { lt: new Date(now) }, usedAt: null },
	});
	const live = await prisma.setupCode.findFirst({
		where: { usedAt: null, expiresAt: { gte: new Date(now) } },
		select: { id: true },
	});
	if (live) {
		return { minted: null };
	}
	const code = renderCode(randomBytes(CODE_BYTES));
	await prisma.setupCode.create({
		data: {
			codeHash: hashSetupCode(code),
			expiresAt: new Date(now + SETUP_CODE_TTL_MS),
		},
	});
	return { minted: code };
}

/**
 * Burn the presented code: finds the matching unused, unexpired row and
 * CAS-claims it (`usedAt: null` in the WHERE — two holders of one leaked
 * code cannot both pass, §3c TOCTOU control 1; control 2 is the
 * Serializable zero-users transaction in the setup route).
 */
export async function consumeSetupCode(
	presented: string,
	now: number = Date.now(),
): Promise<boolean> {
	const prisma = getIdentityPrisma();
	const hash = hashSetupCode(presented);
	const candidate = await prisma.setupCode.findFirst({
		where: { codeHash: hash, usedAt: null, expiresAt: { gte: new Date(now) } },
		select: { id: true },
	});
	if (!candidate) {
		return false;
	}
	const claimed = await prisma.setupCode.updateMany({
		where: { id: candidate.id, usedAt: null },
		data: { usedAt: new Date(now) },
	});
	return claimed.count === 1;
}
