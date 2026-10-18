import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	publishSealedRunReport,
	restoreSealedRunReportExports,
} from "./runner";

describe("publishSealedRunReport — DB-owned bytes before recoverable exports", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		await Promise.all(
			dirs.splice(0).map((dir) => rm(dir, { recursive: true })),
		);
	});

	async function runDir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-seal-publish-"));
		dirs.push(dir);
		return dir;
	}

	it("a rejected DB preseal validation leaves no canonical green report or seal", async () => {
		const dir = await runDir();
		const sealDurably = vi.fn(async () => {});
		await expect(
			publishSealedRunReport({
				runDir: dir,
				reportJson: '{"counts":{"PASS":1}}\n',
				reportMarkdown: "# green\n",
				seal: "hmac-sha256:key:deadbeef",
				validateDurably: async () => {
					expect(existsSync(join(dir, "report.json"))).toBe(false);
					expect(existsSync(join(dir, "report.seal"))).toBe(false);
					expect(
						(await readdir(dir)).some((name) =>
							name.startsWith("report.json.pending."),
						),
					).toBe(true);
					throw new Error("DB preseal refused");
				},
				sealDurably,
			}),
		).rejects.toThrow(/DB preseal refused/);
		expect(sealDurably).not.toHaveBeenCalled();

		for (const name of ["report.json", "report.md", "report.seal"]) {
			expect(existsSync(join(dir, name)), name).toBe(false);
		}
		expect(
			(await readdir(dir)).filter((name) => name.includes(".pending.")),
		).toEqual([]);
	});

	it("commits the self-contained DB authority before publishing exact exports with report.seal last", async () => {
		const dir = await runDir();
		const events: string[] = [];
		await publishSealedRunReport({
			runDir: dir,
			reportJson: '{"counts":{"PASS":0,"SKIP":1}}\n',
			reportMarkdown: "# dry validation\n",
			seal: "sha256:cafe",
			validateDurably: async () => {
				events.push("DB PRESEAL");
			},
			publishFile: async (pending, published) => {
				events.push(`PUBLISH ${published.split("/").at(-1)}`);
				await rename(pending, published);
			},
			sealDurably: async () => {
				events.push("DB SEALED");
			},
		});

		expect(events).toEqual([
			"DB PRESEAL",
			"DB SEALED",
			"PUBLISH report.json",
			"PUBLISH report.md",
			"PUBLISH report.seal",
		]);
		expect(await readFile(join(dir, "report.json"), "utf8")).toBe(
			'{"counts":{"PASS":0,"SKIP":1}}\n',
		);
		expect(await readFile(join(dir, "report.md"), "utf8")).toBe(
			"# dry validation\n",
		);
		expect(await readFile(join(dir, "report.seal"), "utf8")).toBe(
			"sha256:cafe\n",
		);
	});

	it("an export failure keeps DB authority SEALED, leaves no seal receipt, and retains its unique pending bytes", async () => {
		const dir = await runDir();
		let publishCount = 0;
		const sealDurably = vi.fn(async () => {
			expect(existsSync(join(dir, "report.json"))).toBe(false);
			expect(existsSync(join(dir, "report.seal"))).toBe(false);
		});
		const result = await publishSealedRunReport({
			runDir: dir,
			reportJson: '{"counts":{"PASS":1}}\n',
			reportMarkdown: "# green\n",
			seal: "hmac-sha256:key:deadbeef",
			validateDurably: async () => {},
			sealDurably,
			publishFile: async (pending, published) => {
				publishCount += 1;
				if (publishCount === 2) throw new Error("filesystem rename refused");
				await rename(pending, published);
			},
		});
		expect(result).toMatchObject({ exported: false });
		expect(result.error).toMatch(/filesystem rename refused/);
		expect(sealDurably).toHaveBeenCalledTimes(1);

		expect(await readFile(join(dir, "report.json"), "utf8")).toBe(
			'{"counts":{"PASS":1}}\n',
		);
		expect(existsSync(join(dir, "report.md"))).toBe(false);
		expect(existsSync(join(dir, "report.seal"))).toBe(false);
		const pending = await readdir(dir);
		const markdownPending = pending.find((name) =>
			name.startsWith("report.md.pending."),
		);
		const sealPending = pending.find((name) =>
			name.startsWith("report.seal.pending."),
		);
		expect(markdownPending).toBeTypeOf("string");
		expect(sealPending).toBeTypeOf("string");
		expect(await readFile(join(dir, markdownPending as string), "utf8")).toBe(
			"# green\n",
		);
		expect(await readFile(join(dir, sealPending as string), "utf8")).toBe(
			"hmac-sha256:key:deadbeef\n",
		);
	});

	it("a DB seal failure happens before any canonical export exists", async () => {
		const dir = await runDir();
		await expect(
			publishSealedRunReport({
				runDir: dir,
				reportJson: '{"counts":{"PASS":1}}\n',
				reportMarkdown: "# green\n",
				seal: "hmac-sha256:key:deadbeef",
				validateDurably: async () => {},
				sealDurably: async () => {
					expect(existsSync(join(dir, "report.json"))).toBe(false);
					expect(existsSync(join(dir, "report.md"))).toBe(false);
					expect(existsSync(join(dir, "report.seal"))).toBe(false);
					throw new Error("DB final seal refused");
				},
			}),
		).rejects.toThrow(/DB final seal refused/);

		for (const name of ["report.json", "report.md", "report.seal"]) {
			expect(existsSync(join(dir, name)), name).toBe(false);
		}
		expect(
			(await readdir(dir)).filter((name) => name.includes(".pending.")),
		).toEqual([]);
	});

	it("rebuilds missing local exports directly from self-contained DB bytes", async () => {
		const dir = await runDir();
		await expect(
			restoreSealedRunReportExports({
				runDir: dir,
				reportJson: '{"runId":"sealed"}\n',
				reportMarkdown: "# sealed\n",
				seal: "hmac-sha256:key:cafe",
			}),
		).resolves.toEqual({ exported: true });
		expect(await readFile(join(dir, "report.json"), "utf8")).toBe(
			'{"runId":"sealed"}\n',
		);
		expect(await readFile(join(dir, "report.md"), "utf8")).toBe("# sealed\n");
		expect(await readFile(join(dir, "report.seal"), "utf8")).toBe(
			"hmac-sha256:key:cafe\n",
		);
	});

	it("keeps concurrent repairs idempotent and never deletes another repair's exports", async () => {
		const dir = await runDir();
		let firstPublishArrivals = 0;
		let releaseFirstPublishes: (() => void) | undefined;
		const bothAtFirstPublish = new Promise<void>((resolve) => {
			releaseFirstPublishes = resolve;
		});
		const publishFile = async (pending: string, published: string) => {
			if (published.endsWith("report.json")) {
				firstPublishArrivals += 1;
				if (firstPublishArrivals === 2) releaseFirstPublishes?.();
				await bothAtFirstPublish;
			}
			await rename(pending, published);
		};
		const input = {
			runDir: dir,
			reportJson: '{"runId":"sealed"}\n',
			reportMarkdown: "# sealed\n",
			seal: "hmac-sha256:key:cafe",
			publishFile,
		};
		const results = await Promise.all([
			restoreSealedRunReportExports(input),
			restoreSealedRunReportExports(input),
		]);
		expect(results).toEqual([{ exported: true }, { exported: true }]);
		expect(await readFile(join(dir, "report.json"), "utf8")).toBe(
			input.reportJson,
		);
		expect(await readFile(join(dir, "report.md"), "utf8")).toBe(
			input.reportMarkdown,
		);
		expect(await readFile(join(dir, "report.seal"), "utf8")).toBe(
			`${input.seal}\n`,
		);
	});
});
