import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..", "..", "..");
function memoryConfig(
	overrides: Record<string, string> = {},
	envFile = "/dev/null",
) {
	const parsed = JSON.parse(
		execFileSync(
			"docker",
			[
				"compose",
				"--env-file",
				envFile,
				"--profile",
				"*",
				"config",
				"--no-env-resolution",
				"--format",
				"json",
			],
			{
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					NODE_ENV: "test",
					...overrides,
				},
			},
		),
	) as {
		services: Record<
			string,
			{
				mem_limit?: string;
				memswap_limit?: string;
				environment?: Record<string, string>;
			}
		>;
	};
	return parsed.services;
}

describe("Compose memory containment (row #93)", () => {
	it("defaults profiles but preserves explicit values for startup rejection", () => {
		for (const profile of [
			"",
			"UNRESTRICTED",
			"AKAMAI_ONLY",
			"UNKNOWN_PROFILE",
		]) {
			const services = memoryConfig({ DEPLOYMENT_PROFILE: profile });
			for (const name of ["web", "worker"])
				expect(services[name]?.environment?.DEPLOYMENT_PROFILE).toBe(
					profile || "UNRESTRICTED",
				);
		}
	});
	it("bounds every service, including optional profiles, within the 8 GiB host budget", () => {
		const services = memoryConfig();
		expect(Object.keys(services).sort()).toEqual([
			"ingress",
			"ingress-named",
			"migrate",
			"postgres",
			"redis",
			"web",
			"worker",
		]);
		let total = 0;
		for (const service of Object.values(services)) {
			expect(Number(service.mem_limit)).toBeGreaterThan(0);
			expect(service.memswap_limit).toBe(service.mem_limit);
			total += Number(service.mem_limit);
		}
		expect(total).toBeLessThanOrEqual(7 * 1024 ** 3);
	});

	it("keeps the worker memory and swap ceiling consistent when explicitly sized", () => {
		const services = memoryConfig({ WORKER_MEMORY_LIMIT: "3g" });
		expect(Number(services.worker?.mem_limit)).toBe(3 * 1024 ** 3);
		expect(Number(services.worker?.memswap_limit)).toBe(3 * 1024 ** 3);
	});

	it("gives Web a 1 GiB default without changing explicit memory overrides", () => {
		const defaults = memoryConfig().web;
		expect(Number(defaults?.mem_limit)).toBe(1024 ** 3);
		expect(defaults?.memswap_limit).toBe(defaults?.mem_limit);
		const tuned = memoryConfig({ WEB_MEMORY_LIMIT: "1536m" }).web;
		expect(Number(tuned?.mem_limit)).toBe(1536 * 1024 ** 2);
		expect(tuned?.memswap_limit).toBe(tuned?.mem_limit);
	});

	it("pairs the memory ceiling with measured VMAF defaults and preserves explicit tuning", () => {
		expect(memoryConfig().worker?.environment).toMatchObject({
			VMAF_CONCURRENCY: "1",
			VMAF_THREADS: "2",
		});
		expect(
			memoryConfig({ VMAF_CONCURRENCY: "2", VMAF_THREADS: "4" }).worker
				?.environment,
		).toMatchObject({ VMAF_CONCURRENCY: "2", VMAF_THREADS: "4" });
	});

	it("uses explicit env-file tuning while shell values take precedence", () => {
		const dir = mkdtempSync(join(tmpdir(), "compose-memory-"));
		const envFile = join(dir, "fixture.env");
		try {
			writeFileSync(
				envFile,
				"WORKER_MEMORY_LIMIT=5g\nWEB_MEMORY_LIMIT=1536m\nVMAF_CONCURRENCY=3\nVMAF_THREADS=4\n",
			);
			const fileConfig = memoryConfig({}, envFile);
			expect(Number(fileConfig.worker?.mem_limit)).toBe(5 * 1024 ** 3);
			expect(Number(fileConfig.web?.mem_limit)).toBe(1536 * 1024 ** 2);
			expect(fileConfig.web?.memswap_limit).toBe(fileConfig.web?.mem_limit);
			expect(fileConfig.worker?.environment).toMatchObject({
				VMAF_CONCURRENCY: "3",
				VMAF_THREADS: "4",
			});
			const shellConfig = memoryConfig(
				{
					WORKER_MEMORY_LIMIT: "6g",
					WEB_MEMORY_LIMIT: "2g",
					VMAF_CONCURRENCY: "1",
				},
				envFile,
			);
			expect(Number(shellConfig.worker?.mem_limit)).toBe(6 * 1024 ** 3);
			expect(Number(shellConfig.web?.mem_limit)).toBe(2 * 1024 ** 3);
			expect(shellConfig.web?.memswap_limit).toBe(shellConfig.web?.mem_limit);
			expect(shellConfig.worker?.environment).toMatchObject({
				VMAF_CONCURRENCY: "1",
				VMAF_THREADS: "4",
			});
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});
