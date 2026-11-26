import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMoqPlayerBundle } from "./moq-player-asset";

let directory: string;
const bytes = Buffer.from("/* synthetic test bundle */ window.test = true;");
const digest = createHash("sha256").update(bytes).digest("hex");
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "bitovp-moq-asset-test-"));
	await writeFile(join(directory, "player.js"), bytes);
});
afterEach(() => rm(directory, { recursive: true, force: true }));
const config = () => ({
	BITOVP_MOQ_PLAYER_BUNDLE_PATH: join(directory, "player.js"),
	BITOVP_MOQ_PLAYER_BUNDLE_SHA256: digest,
});

describe("fixed operator-configured MoQ player asset", () => {
	it("returns only bytes whose SHA256 matches the configured digest", async () => {
		expect(Buffer.from(await readMoqPlayerBundle(config()))).toEqual(bytes);
	});
	it.each([
		{},
		{ BITOVP_MOQ_PLAYER_BUNDLE_PATH: "" },
	])("refuses missing local configuration", async (env) => {
		await expect(readMoqPlayerBundle(env)).rejects.toThrow(
			"MoQ player bundle unavailable",
		);
	});
	it.each([
		"invalid",
		"0".repeat(64),
	])("refuses invalid or mismatched digest %s", async (sha) => {
		await expect(
			readMoqPlayerBundle({
				...config(),
				BITOVP_MOQ_PLAYER_BUNDLE_SHA256: sha,
			}),
		).rejects.toThrow("MoQ player bundle unavailable");
	});
	it("uses the fixed official digest when no digest override is configured", async () => {
		await expect(
			readMoqPlayerBundle({
				BITOVP_MOQ_PLAYER_BUNDLE_PATH: join(directory, "player.js"),
			}),
		).rejects.toThrow("MoQ player bundle unavailable");
	});
	it("rejects non-files, symlinks, oversized bytes and missing paths with the same safe error", async () => {
		await symlink(join(directory, "player.js"), join(directory, "link.js"));
		await writeFile(
			join(directory, "large.js"),
			Buffer.alloc(2 * 1024 * 1024 + 1),
		);
		for (const name of ["", "link.js", "large.js", "secret-missing-file.js"]) {
			await expect(
				readMoqPlayerBundle({
					...config(),
					BITOVP_MOQ_PLAYER_BUNDLE_PATH: join(directory, name),
				}),
			).rejects.toThrow(/^MoQ player bundle unavailable$/);
		}
	});
	it("rejects a real FIFO without waiting for a writer", async () => {
		const fifo = join(directory, "player.fifo");
		execFileSync("mkfifo", [fifo]);
		const read = readMoqPlayerBundle({
			...config(),
			BITOVP_MOQ_PLAYER_BUNDLE_PATH: fifo,
		}).then(
			() => "returned",
			() => "rejected",
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const outcome = await Promise.race([
			read,
			new Promise<string>((resolve) => {
				timer = setTimeout(() => resolve("blocked"), 500);
			}),
		]);
		try {
			expect(outcome).toBe("rejected");
		} finally {
			if (timer) clearTimeout(timer);
			// Unblock the old implementation after proving the defect, so RED exits cleanly.
			if (outcome === "blocked") await writeFile(fifo, "");
			await read;
		}
	});
});
