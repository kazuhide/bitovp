import { createInterface } from "node:readline";
import { getIdentityPrisma } from "@bitovp/db";
import { hashPassword } from "../src/lib/auth/password";

/**
 * Headless user creation (#32 §3 — the escape hatch behind /setup). Password
 * arrives on STDIN with echo off, never argv (`auth:hash`'s discipline: argv
 * lands in shell history and `ps`).
 *
 *   pnpm --filter @bitovp/web auth:create-user -- --email a@b.c \
 *     --name "Alice" [--role ADMIN|OPERATOR|VIEWER]
 */
function argOf(flag: string): string | null {
	const index = process.argv.indexOf(flag);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	return value === undefined ? null : value;
}

async function readPassword(prompt: string): Promise<string> {
	process.stdout.write(prompt);
	const rl = createInterface({ input: process.stdin, terminal: true });
	const wasRaw = process.stdin.isRaw;
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
	}
	try {
		return await new Promise<string>((resolve) => {
			let buffer = "";
			process.stdin.on("data", function onData(chunk: Buffer) {
				for (const byte of chunk) {
					if (byte === 0x03) {
						process.exit(130);
					}
					if (byte === 0x0d || byte === 0x0a) {
						process.stdin.off("data", onData);
						process.stdout.write("\n");
						resolve(buffer);
						return;
					}
					if (byte === 0x7f || byte === 0x08) {
						buffer = buffer.slice(0, -1);
						continue;
					}
					buffer += String.fromCharCode(byte);
				}
			});
		});
	} finally {
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(wasRaw ?? false);
		}
		rl.close();
	}
}

async function main(): Promise<void> {
	const email = argOf("--email")?.trim().toLowerCase();
	const displayName = argOf("--name")?.trim();
	const organizationId = argOf("--organization-id");
	const platformOwner = process.argv.includes("--platform-owner");
	if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId))
		throw new Error("An explicit --organization-id UUID is required");
	const role = argOf("--role") ?? "OPERATOR";
	if (!email || !displayName) {
		console.error(
			"Usage: auth:create-user -- --email <email> --name <display name> [--role ADMIN|OPERATOR|VIEWER]",
		);
		process.exit(2);
	}
	if (!["ADMIN", "OPERATOR", "VIEWER"].includes(role)) {
		console.error(`Unknown role ${role}`);
		process.exit(2);
	}
	const password = await readPassword("Password (min 12 chars, echo off): ");
	if (password.length < 12) {
		console.error("Password must be at least 12 characters");
		process.exit(2);
	}
	const prisma = getIdentityPrisma();
	const existing = await prisma.user.findUnique({ where: { email } });
	if (existing) {
		console.error(`A user with email ${email} already exists`);
		process.exit(1);
	}
	const created = await prisma.$transaction(async (tx) => {
		const user = await tx.user.create({
			data: {
				email,
				displayName,
				passwordHash: hashPassword(password),
				platformOwner,
				role: role as "ADMIN" | "OPERATOR" | "VIEWER",
			},
			select: { id: true, email: true, role: true },
		});
		await tx.membership.create({
			data: {
				userId: user.id,
				organizationId,
				role: role as "ADMIN" | "OPERATOR" | "VIEWER",
			},
		});
		return user;
	});
	console.log(`Created ${created.role} ${created.email} (${created.id})`);
	process.exit(0);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
