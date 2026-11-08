import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export class MediaOperationError extends Error {
	constructor(
		public readonly code: string,
		message = code,
		public readonly diagnostic?: string,
	) {
		super(message);
		this.name = "MediaOperationError";
	}
}

/** Owns the process until close, including the hard-kill grace after cancellation. */
export async function runMediaProcess(
	binary: string,
	argv: readonly string[],
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		killAfterMs?: number;
		maxOutputBytes?: number;
	} = {},
): Promise<{ stdout: string; stderr: string }> {
	const timeoutMs = options.timeoutMs ?? 10 * 60_000;
	const killAfterMs = options.killAfterMs ?? 1000;
	const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
	for (const value of [timeoutMs, killAfterMs, maxOutputBytes]) {
		if (!Number.isSafeInteger(value) || value < 1 || value > 2 ** 31 - 1)
			throw new RangeError("Invalid media process bound");
	}
	if (options.signal?.aborted) throw new MediaOperationError("CANCELED");
	return await new Promise((resolve, reject) => {
		const group = process.platform !== "win32";
		const child = spawn(binary, [...argv], {
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
			detached: group,
		});
		let stdout = "";
		let stderr = "";
		let bytes = 0;
		let failure: MediaOperationError | undefined;
		let exited = false;
		let closed = false;
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let hardKill: ReturnType<typeof setTimeout> | undefined;
		const kill = (signal: "SIGTERM" | "SIGKILL") => {
			if (closed || (!group && exited) || child.pid === undefined) return;
			try {
				if (group) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH")
					failure ??= new MediaOperationError("PROCESS_FAILED");
			}
		};
		const stop = (code: string) => {
			if (failure) return;
			failure = new MediaOperationError(code);
			kill("SIGTERM");
			hardKill = setTimeout(() => kill("SIGKILL"), killAfterMs);
		};
		const abort = () => stop("CANCELED");
		const timeout = setTimeout(() => stop("TIMED_OUT"), timeoutMs);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		const collect = (chunk: Buffer, destination: "stdout" | "stderr") => {
			bytes += chunk.length;
			if (bytes > maxOutputBytes) return stop("OUTPUT_LIMIT");
			if (destination === "stdout") stdout += stdoutDecoder.write(chunk);
			else stderr += stderrDecoder.write(chunk);
		};
		child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
		child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
		child.once("error", () => {
			failure ??= new MediaOperationError("PROCESS_FAILED");
		});
		child.once("exit", () => {
			exited = true;
			if (!group && hardKill) clearTimeout(hardKill);
		});
		child.once("close", (code) => {
			closed = true;
			stdout += stdoutDecoder.end();
			stderr += stderrDecoder.end();
			clearTimeout(timeout);
			if (hardKill) clearTimeout(hardKill);
			options.signal?.removeEventListener("abort", abort);
			if (failure || code !== 0)
				reject(
					failure ??
						new MediaOperationError(
							"PROCESS_FAILED",
							"Media processing failed",
							stderr.slice(-4000),
						),
				);
			else resolve({ stdout, stderr });
		});
	});
}
