import { readFile, symlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DEFAULT_ORGANIZATION_ID } from "@bitovp/db";
import type { ObjectIdentity } from "@bitovp/storage";
import { currentOrganizationId } from "../tenant/scope";
import type { DownloadProvenance, VmafDownloadArgs } from "./download";
import { verifiedFileIdentity } from "./file-identity";

/** Operator-owned manifest and media must be mounted read-only in the worker. */
export async function cachedVmafInput(
	args: VmafDownloadArgs,
	identity: ObjectIdentity | undefined,
	manifestPath = process.env.VMAF_INPUT_CACHE_FILE,
): Promise<DownloadProvenance | undefined> {
	// Legacy operator-mounted cache is authorized for the original organization only.
	const organizationId = currentOrganizationId();
	if (organizationId && organizationId !== DEFAULT_ORGANIZATION_ID)
		return undefined;
	if (!manifestPath || !identity) return undefined;
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	if (manifest.version !== 1 || !Array.isArray(manifest.entries))
		throw new Error("Invalid VMAF input cache manifest");
	const matches = manifest.entries.filter(
		(entry: Record<string, unknown>) =>
			entry.provider === args.credential.provider &&
			entry.bucket === args.bucket &&
			entry.key === args.key,
	);
	if (!matches.length) return undefined;
	if (matches.length !== 1) throw new Error("Duplicate VMAF input cache entry");
	const entry = matches[0];
	if (
		typeof entry.path !== "string" ||
		!isAbsolute(entry.path) ||
		typeof entry.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(entry.sha256) ||
		!Number.isSafeInteger(entry.bytes) ||
		entry.bytes < 0 ||
		!entry.identity ||
		entry.bytes !== identity.size ||
		entry.identity.size !== identity.size
	)
		throw new Error("Invalid VMAF input cache identity");
	let versionFields = 0;
	for (const field of ["etag", "generation", "versionId"] as const) {
		if (entry.identity[field] === undefined) continue;
		versionFields++;
		if (
			typeof entry.identity[field] !== "string" ||
			entry.identity[field] !== identity[field]
		)
			throw new Error("VMAF input cache object version changed");
	}
	if (!versionFields)
		throw new Error("VMAF input cache requires an object version");
	args.signal?.throwIfAborted();
	const actual = await verifiedFileIdentity(entry.path);
	if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256)
		throw new Error("VMAF input cache file digest mismatch");
	args.signal?.throwIfAborted();
	await symlink(entry.path, args.destPath);
	return {
		bucket: args.bucket,
		key: args.key,
		identity,
		// HEAD + cached digest is verified, but no conditional provider GET occurred.
		pinned: false,
		sha256: entry.sha256,
		bytes: entry.bytes,
	};
}
