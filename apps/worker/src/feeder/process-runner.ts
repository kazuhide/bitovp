import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { ReadProcessCommand } from "./orphan-pid";
import type {
	FeederProcess,
	FeederProcessEvents,
	ProcessRunner,
} from "./supervisor";

/**
 * The one real-process implementation of the ProcessRunner boundary
 * (everything else in the feeder is tested against fakes — CI has no
 * ffmpeg). Deliberately thin: line splitting via readline, no shell
 * (argv arrays only — push URLs never meet a shell parser), stdin ignored
 * (ffmpeg also gets -nostdin).
 */
export function createNodeProcessRunner(): ProcessRunner {
	return {
		spawn(bin, argv, events: FeederProcessEvents): FeederProcess {
			const child = spawn(bin, argv, {
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			});
			if (child.stdout) {
				createInterface({ input: child.stdout }).on("line", (line) =>
					events.onStdoutLine(line),
				);
			}
			if (child.stderr) {
				createInterface({ input: child.stderr }).on("line", (line) =>
					events.onStderrLine(line),
				);
			}
			let settled = false;
			const settle = (code: number | null, signal: string | null) => {
				if (!settled) {
					settled = true;
					events.onExit(code, signal);
				}
			};
			// A missing binary emits 'error' (never 'close') — surface it as an
			// exit so the supervisor's backoff/error path engages instead of
			// hanging forever on the exit promise.
			child.on("error", (err) => {
				events.onStderrLine(`[feeder] spawn failed: ${err.message}`);
				settle(null, null);
			});
			// 'close', not 'exit': 'close' fires only after the stdio streams
			// have drained, so the readline interfaces deliver ffmpeg's final
			// stderr lines (the crash reason) into the tail BEFORE the
			// supervisor records the exit. The settled guard keeps this safe
			// alongside the 'error' path above.
			child.on("close", (code, signal) => settle(code, signal));
			return {
				pid: child.pid,
				kill(signal) {
					try {
						child.kill(signal);
					} catch {
						// Already gone — exit handling owns the state transition.
					}
				},
			};
		},

		run(bin, argv, options) {
			return new Promise((resolve) => {
				const abortKillAfterMs = options?.abortKillAfterMs;
				if (
					abortKillAfterMs !== undefined &&
					(!Number.isInteger(abortKillAfterMs) ||
						abortKillAfterMs <= 0 ||
						abortKillAfterMs > 2 ** 31 - 1)
				) {
					throw new RangeError(
						"abortKillAfterMs must be a positive timer-safe integer",
					);
				}
				// Node emits AbortError when it sends SIGTERM, before the child
				// necessarily exits. Keep ownership until close so memory admission
				// cannot start a replacement while that child is still shutting down.
				const child = spawn(bin, argv, {
					stdio: ["ignore", "pipe", "pipe"],
					shell: false,
					...(options?.signal ? { signal: options.signal } : {}),
				});
				let stdout = "";
				let stderr = "";
				let settled = false;
				let aborted = false;
				let exited = false;
				let killScheduled = false;
				let killTimer: ReturnType<typeof setTimeout> | undefined;
				const clearKillTimer = () => {
					if (killTimer !== undefined) clearTimeout(killTimer);
					killTimer = undefined;
				};
				const onExit = () => {
					exited = true;
					clearKillTimer();
				};
				const settle = (result: {
					code: number | null;
					stdout: string;
					stderr: string;
				}) => {
					if (!settled) {
						settled = true;
						clearKillTimer();
						child.removeListener("exit", onExit);
						child.removeListener("error", onError);
						child.removeListener("close", onClose);
						resolve(result);
					}
				};
				const onError = (err: Error) => {
					if (
						child.pid !== undefined &&
						(err.name === "AbortError" ||
							(abortKillAfterMs !== undefined && options?.signal?.aborted))
					) {
						aborted = true;
						stderr += err.message;
						if (
							abortKillAfterMs !== undefined &&
							!killScheduled &&
							!exited &&
							!settled
						) {
							killScheduled = true;
							killTimer = setTimeout(() => {
								killTimer = undefined;
								// killed records signal delivery, not physical exit. Never
								// signal an exited child while its stdio is still draining.
								if (
									settled ||
									exited ||
									child.exitCode !== null ||
									child.signalCode !== null
								)
									return;
								try {
									child.kill("SIGKILL");
								} catch (error) {
									stderr +=
										error instanceof Error ? error.message : String(error);
								}
							}, abortKillAfterMs);
						}
						return;
					}
					if (
						aborted &&
						abortKillAfterMs !== undefined &&
						child.pid !== undefined
					) {
						// Failure to deliver the hard kill does not release ownership.
						stderr += err.message;
						return;
					}
					settle({ code: null, stdout, stderr: `${stderr}${err.message}` });
				};
				const onClose = (code: number | null) =>
					settle({ code: aborted ? null : code, stdout, stderr });
				child.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString("utf8");
				});
				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString("utf8");
				});
				child.on("error", onError);
				child.once("exit", onExit);
				child.once("close", onClose);
			});
		},
	};
}

/**
 * Reads a live pid's command line, for the orphan reclaim's pid-reuse guard.
 *
 * `/proc` FIRST, and that order is load-bearing rather than a preference: the
 * worker image is `node:24-bookworm-slim`, which ships no `procps` — there is
 * no `ps` binary in the container this runs in. `/proc/<pid>/cmdline` is
 * always there on Linux, holds the FULL argv (NUL-separated, never truncated),
 * and costs one read. The `ps -ww` fallback exists for host/dev use on macOS,
 * where /proc does not exist; `-ww` is mandatory there too, because a default
 * `ps` truncates to the terminal width and would cut the spool path — the very
 * part carrying the session id the match depends on.
 *
 * Returns null when the pid is gone or the command cannot be read: "no
 * information", which every caller must treat as "do not kill", never as
 * "not ours".
 *
 * SECRETS: the string contains the push URL, and an RTMP push URL carries the
 * stream key. It is matched in memory and dropped — never logged, never
 * persisted, never handed to anything that stores it.
 */
export function createNodeProcessCommandReader(): ReadProcessCommand {
	return async (pid: number): Promise<string | null> => {
		try {
			const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
			const argv = raw.split("\0").filter((part) => part.length > 0);
			if (argv.length > 0) {
				return argv.join(" ");
			}
		} catch {
			// No /proc (macOS dev host) or the pid is gone — try ps, which
			// distinguishes those two for us by failing on a dead pid.
		}
		return await new Promise<string | null>((resolve) => {
			execFile(
				"ps",
				["-ww", "-p", String(pid), "-o", "command="],
				{ maxBuffer: 1024 * 1024 },
				(err, stdout) => {
					if (err) {
						resolve(null);
						return;
					}
					const line = stdout.trim();
					resolve(line.length > 0 ? line : null);
				},
			);
		});
	};
}
