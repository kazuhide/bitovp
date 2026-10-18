import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "../src/client";
import {
	DEFAULT_RUNTIME_ROLE,
	databaseUrl,
	prepareRuntimeRole,
	privateEnv,
} from "../src/runtime-role-setup";

async function main() {
	const args = process.argv.slice(2);
	const mode = args.shift();
	if (mode !== "dev" && mode !== "deploy")
		throw new Error("Unknown migration mode.");
	let path = join(
		fileURLToPath(new URL("../../..", import.meta.url)),
		".env.migrate",
	);
	const forwarded: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--admin-env") {
			const value = args[++i];
			if (!value) throw new Error("Missing migration configuration path.");
			path = value;
		} else if (args[i] !== "--") forwarded.push(args[i] ?? "");
	}
	const settings = privateEnv(path);
	const url = databaseUrl(
		process.env.MIGRATION_DATABASE_URL ||
			(process.env.BITOVP_MIGRATION_IN_CONTAINER === "1"
				? process.env.COMPOSE_MIGRATION_DATABASE_URL
				: settings.DATABASE_URL),
	);
	const role =
		process.env.RUNTIME_DATABASE_ROLE ||
		settings.RUNTIME_DATABASE_ROLE ||
		DEFAULT_RUNTIME_ROLE;
	const admin = createPrismaClient(url.toString());
	try {
		// Fail before any schema change if application-role preparation was skipped.
		await prepareRuntimeRole(admin, role);
		const prisma = createRequire(import.meta.url).resolve(
			"prisma/build/index.js",
		);
		const code = await new Promise<number>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					prisma,
					"migrate",
					mode,
					"--schema",
					fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)),
					...forwarded,
				],
				{
					env: { ...process.env, DATABASE_URL: url.toString() },
					stdio: ["inherit", "pipe", "pipe"],
				},
			);
			const safe = (chunk: Buffer) => {
				let output = chunk
					.toString()
					.replaceAll(url.toString(), "[private migration URL]");
				if (url.password)
					output = output.replaceAll(
						decodeURIComponent(url.password),
						"[private credential]",
					);
				if (url.password)
					output = output.replaceAll(url.password, "[private credential]");
				return output;
			};
			// Buffer complete lines so an URL/password split across pipe chunks
			// cannot defeat redaction.
			const forward = (
				stream: typeof child.stdout,
				destination: NodeJS.WriteStream,
			) => {
				let pending = "";
				stream.on("data", (chunk: Buffer) => {
					pending += chunk.toString();
					const newline = pending.lastIndexOf("\n");
					if (newline >= 0) {
						destination.write(safe(Buffer.from(pending.slice(0, newline + 1))));
						pending = pending.slice(newline + 1);
					}
				});
				stream.on("end", () => {
					if (pending) destination.write(safe(Buffer.from(pending)));
				});
			};
			forward(child.stdout, process.stdout);
			forward(child.stderr, process.stderr);
			child.on("error", reject);
			child.on("close", (value) => resolve(value ?? 1));
		});
		if (code !== 0) {
			process.exitCode = code;
			return;
		}
		// Fresh migration history tables received default grants; revoke those,
		// and refresh privileges on all new tables after a successful upgrade.
		await prepareRuntimeRole(admin, role);
	} finally {
		await admin.$disconnect();
	}
}

main().catch(() => {
	console.error(
		"Database migration failed. Check private administrator configuration and run db:runtime:prepare first.",
	);
	process.exitCode = 1;
});
