import { resolve } from "node:path";
import { createPrismaClient } from "../src/client";
import { databaseUrl, privateEnv } from "../src/runtime-role-setup";
import { readUpgradePreflight } from "../src/upgrade-preflight";

async function main() {
	const args = process.argv.slice(2).filter((arg) => arg !== "--");
	if (args.length !== 2 || args[0] !== "--admin-env" || !args[1])
		throw new Error(
			"Usage: db:upgrade:preflight --admin-env /absolute/path/to/.env.migrate",
		);
	const env = privateEnv(resolve(args[1]));
	const prisma = createPrismaClient(databaseUrl(env.DATABASE_URL).toString());
	try {
		const result = await readUpgradePreflight(prisma);
		console.log(JSON.stringify(result, null, 2));
		if (result.blockingTemplates > 0) process.exitCode = 2;
	} finally {
		await prisma.$disconnect();
	}
}

main().catch(() => {
	console.error(
		"Upgrade preflight failed. Verify private administrator configuration; no application rows were changed.",
	);
	process.exitCode = 1;
});
