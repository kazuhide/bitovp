import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProcessRunner } from "../feeder/supervisor";
import { verifiedFileIdentity } from "./file-identity";
import { resolveNativeExecutable } from "./native-auto-device";
import { nativeSourceFromVersion } from "./native-contract";

const timeoutMs = 15_000;

/** Linux uptime includes suspend; queued heartbeats carry absolute deadlines. */
export function vmafHeartbeatDeadline(uptime: string): string {
	const match = /^(\d{1,12})(?:\.(\d{1,9}))?\s+\d{1,12}(?:\.\d{1,9})?\s*$/.exec(
		uptime,
	);
	if (!match?.[1]) throw new Error("VMAF_SUPERVISOR_CLOCK_UNAVAILABLE");
	const now =
		BigInt(match[1]) * 1_000_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
	const deadline = now + BigInt(timeoutMs) * 1_000_000n;
	if (deadline > 18_446_744_073_709_551_615n)
		throw new Error("VMAF_SUPERVISOR_CLOCK_UNAVAILABLE");
	return `${deadline}\n`;
}

/** The companion owns one direct executable, never a shell or a process group.
 * Its kernel deadline and parent-death guards outlive a stalled Node event loop. */
export async function createSupervisedVmafRunner(
	deps: {
		runner: ProcessRunner;
		nativePath: string;
		platform?: string;
		readUptime?: () => string;
	},
	signal?: AbortSignal,
) {
	if ((deps.platform ?? process.platform) !== "linux")
		throw new Error("VMAF_SUPERVISOR_REQUIRES_LINUX");
	const executable = await resolveNativeExecutable(deps.nativePath);
	const companion = join(dirname(executable), "bitovp-vmaf-supervisor");
	const binary = await verifiedFileIdentity(executable);
	const guardian = await verifiedFileIdentity(companion);
	const version = await deps.runner.run(executable, ["--version"], {
		signal,
		abortKillAfterMs: 250,
	});
	signal?.throwIfAborted();
	if (version.code !== 0) throw new Error("NATIVE_BINARY_UNAVAILABLE");
	const sourceSha256 = nativeSourceFromVersion(version.stdout);
	const identity = await deps.runner.run(companion, ["--identity"], {
		signal,
		abortKillAfterMs: 250,
	});
	signal?.throwIfAborted();
	if (
		identity.code !== 0 ||
		identity.stdout !==
			`bitovp-vmaf-supervisor-v1-clock=boottime-source=${sourceSha256}\n`
	)
		throw new Error("VMAF_SUPERVISOR_IDENTITY_MISMATCH");
	const read = deps.readUptime ?? (() => readFileSync("/proc/uptime", "utf8"));
	const assertIdentity = async () => {
		const [currentBinary, currentGuardian] = await Promise.all([
			verifiedFileIdentity(executable),
			verifiedFileIdentity(companion),
		]);
		if (
			currentBinary.sha256 !== binary.sha256 ||
			currentGuardian.sha256 !== guardian.sha256
		)
			throw new Error("VMAF_SUPERVISOR_BUILD_CHANGED");
	};
	await assertIdentity();
	vmafHeartbeatDeadline(read());
	const runner: ProcessRunner = {
		spawn() {
			throw new Error("VMAF_SUPERVISOR_REQUIRES_DIRECT_RUN");
		},
		async run(program, args, options) {
			options?.signal?.throwIfAborted();
			if (options?.heartbeat)
				throw new Error("VMAF_SUPERVISOR_NESTED_HEARTBEAT");
			await assertIdentity();
			const result = await deps.runner.run(
				executable,
				[
					"--supervise",
					"--parent-pid",
					String(process.pid),
					"--heartbeat-fd",
					"3",
					"--heartbeat-timeout-ms",
					String(timeoutMs),
					"--",
					program,
					...args,
				],
				{
					...options,
					abortKillAfterMs: options?.abortKillAfterMs ?? 250,
					heartbeat: {
						intervalMs: 5000,
						read: () => vmafHeartbeatDeadline(read()),
					},
				},
			);
			await assertIdentity();
			return result;
		},
	};
	return {
		runner,
		executable,
		sourceSha256,
		binarySha256: binary.sha256,
		supervisorBinarySha256: guardian.sha256,
	};
}
