import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifiedFileIdentity } from "./file-identity";

it("shares hashing across concurrent model/rendition paths and invalidates changed bytes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "vmaf-identity-"));
	try {
		const source = join(dir, "source"),
			link = join(dir, "link");
		await writeFile(source, "video");
		await symlink(source, link);
		const [a, b] = await Promise.all([
			verifiedFileIdentity(source),
			verifiedFileIdentity(link),
		]);
		expect(a).toBe(b);
		await writeFile(source, "different");
		const changed = await verifiedFileIdentity(link);
		expect(changed.sha256).not.toBe(a.sha256);
		expect(changed.bytes).toBe(9);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
