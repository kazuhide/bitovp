/**
 * Prints an AUTH_PASSWORD_HASH value for a password typed on stdin.
 *
 * The password is NEVER an argv: argv lands in shell history, `ps` output and
 * CI logs. On a TTY the input is read with echo off; piped input is accepted
 * too (`printf '%s' 'pw' | pnpm --filter @bitovp/web auth:hash`).
 *
 * Prompts and hints go to stderr, the hash alone to stdout, so
 * `... auth:hash >> .env` does something useful.
 *
 * Run: pnpm --filter @bitovp/web auth:hash
 */
import { randomBytes } from "node:crypto";
import { hashPassword } from "../src/lib/auth/password";

const MIN_LENGTH = 12;
const CTRL_C = "\u0003";
const BACKSPACE = "\u007f";

/** Reads one line with echo suppressed (TTY) or the whole of a pipe. */
function readSecret(label: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) {
		return new Promise((resolve, reject) => {
			let data = "";
			stdin.setEncoding("utf8");
			stdin.on("data", (chunk: string) => {
				data += chunk;
			});
			stdin.on("end", () => resolve(data.replace(/\r?\n$/, "")));
			stdin.on("error", reject);
		});
	}
	process.stderr.write(label);
	return new Promise((resolve, reject) => {
		let data = "";
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");
		const finish = () => {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.off("data", onData);
		};
		const onData = (chunk: string) => {
			for (const char of chunk) {
				if (char === "\r" || char === "\n") {
					finish();
					process.stderr.write("\n");
					resolve(data);
					return;
				}
				if (char === CTRL_C) {
					finish();
					reject(new Error("cancelled"));
					return;
				}
				if (char === BACKSPACE || char === "\b") {
					data = data.slice(0, -1);
					continue;
				}
				data += char;
			}
		};
		stdin.on("data", onData);
	});
}

async function main(): Promise<void> {
	const password = await readSecret("Team password: ");
	if (password.length < MIN_LENGTH) {
		process.stderr.write(
			`Refusing: the shared team password must be at least ${MIN_LENGTH} characters ` +
				"(one password guards every /api/* route on this install).\n",
		);
		process.exitCode = 1;
		return;
	}
	if (process.stdin.isTTY) {
		const confirm = await readSecret("Confirm password: ");
		if (confirm !== password) {
			process.stderr.write("Refusing: the two entries differ.\n");
			process.exitCode = 1;
			return;
		}
	}
	const hash = hashPassword(password);
	process.stdout.write(`${hash}\n`);
	process.stderr.write(
		[
			"",
			"Add to your .env (the hash is safe to store; the password is not):",
			"",
			"  AUTH_MODE=password",
			`  AUTH_PASSWORD_HASH=${hash}`,
			`  AUTH_SESSION_SECRET=${randomBytes(48).toString("base64")}`,
			"",
			"AUTH_SESSION_SECRET is generated fresh above — rotating it signs every",
			"existing session out. `openssl rand -base64 48` produces an equivalent.",
			"",
		].join("\n"),
	);
}

main().catch((err: unknown) => {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exitCode = 1;
});
