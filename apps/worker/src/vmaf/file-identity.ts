import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";

const identities = new Map<
	string,
	Promise<{ sha256: string; bytes: number }>
>();
/** Deduplicate full-file hashing across model/rendition tasks. Stat changes
 * invalidate the entry; operator cache media is mounted read-only. */
export async function verifiedFileIdentity(path: string) {
	const canonical = await realpath(path);
	const before = await stat(canonical, { bigint: true });
	if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER))
		throw new Error("VMAF media is not a supported regular file");
	const fingerprint = (s: typeof before) =>
		`${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
	const signature = fingerprint(before);
	const key = `${canonical}:${signature}`;
	let pending = identities.get(key);
	if (!pending) {
		pending = (async () => {
			const hash = createHash("sha256");
			for await (const chunk of createReadStream(canonical)) hash.update(chunk);
			if (fingerprint(await stat(canonical, { bigint: true })) !== signature)
				throw new Error("VMAF media changed while hashing");
			return { sha256: hash.digest("hex"), bytes: Number(before.size) };
		})();
		const oldest = identities.keys().next().value;
		if (identities.size >= 128 && oldest) identities.delete(oldest);
		identities.set(key, pending);
		pending.catch(() => {
			if (identities.get(key) === pending) identities.delete(key);
		});
	}
	return pending;
}
