import { spawn } from "node:child_process";

export class ExperimentRunnerError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "ExperimentRunnerError";
	}
}

/** The runner and its FFmpeg children inherit this dedicated Linux process group. */
export function runExperimentProcess(
	bin: string,
	args: string[],
	options: { timeoutMs: number; signal: AbortSignal; tmpDir?: string },
): Promise<unknown> {
	options.signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const env: NodeJS.ProcessEnv = {};
		for (const key of [
			"PATH",
			"LANG",
			"LD_LIBRARY_PATH",
			"CUDA_DEVICE_ORDER",
			"CUDA_VISIBLE_DEVICES",
			"BITOVP_NVENC_FFMPEG",
			"BITOVP_NVENC_FFPROBE",
			"BITOVP_NVENC_VMAF_MODEL",
			"BITOVP_NVENC_SDK_PROBE",
			"BITOVP_NVENC_GPU_INDEX",
			"VMAF_NATIVE_PATH",
			"VMAF_MODEL_DIR",
		]) {
			if (process.env[key] !== undefined) env[key] = process.env[key];
		}
		if (options.tmpDir) env.TMPDIR = options.tmpDir;
		const child = spawn(bin, args, {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});
		let failure: string | undefined;
		const chunks: Buffer[] = [];
		let size = 0;
		let stderr = "";
		const terminate = (code: string) => {
			failure ??= code;
			if (child.pid === undefined) return;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH")
					child.kill("SIGKILL");
			}
		};
		const abort = () => terminate("RUNNER_ABORTED");
		options.signal.addEventListener("abort", abort, { once: true });
		if (options.signal.aborted) abort();
		const timer = setTimeout(
			() => terminate("RUNNER_TIMEOUT"),
			options.timeoutMs,
		);
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > 64 * 1024) terminate("RUNNER_OUTPUT_TOO_LARGE");
			else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-128);
		});
		child.once("error", () => {
			failure ??= "RUNNER_SPAWN_FAILED";
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			options.signal.removeEventListener("abort", abort);
			if (failure || code !== 0) {
				const reported = stderr.trim();
				reject(
					new ExperimentRunnerError(
						failure ??
							(code === 75
								? "GPU_BUSY"
								: /^[A-Z][A-Z_0-9]{1,63}$/.test(reported)
									? reported
									: "RUNNER_FAILED"),
					),
				);
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new ExperimentRunnerError("RUNNER_INVALID_JSON"));
			}
		});
	});
}
