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
				"WORKER_MEMORY_LIMIT=5g\nVMAF_CONCURRENCY=3\nVMAF_THREADS=4\n",
			);
			const fileConfig = memoryConfig({}, envFile);
			expect(Number(fileConfig.worker?.mem_limit)).toBe(5 * 1024 ** 3);
			expect(fileConfig.worker?.environment).toMatchObject({
				VMAF_CONCURRENCY: "3",
				VMAF_THREADS: "4",
			});
			const shellConfig = memoryConfig(
				{ WORKER_MEMORY_LIMIT: "6g", VMAF_CONCURRENCY: "1" },
				envFile,
			);
			expect(Number(shellConfig.worker?.mem_limit)).toBe(6 * 1024 ** 3);
			expect(shellConfig.worker?.environment).toMatchObject({
				VMAF_CONCURRENCY: "1",
				VMAF_THREADS: "4",
			});
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});
