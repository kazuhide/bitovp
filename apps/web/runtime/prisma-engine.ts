import { readdirSync } from "node:fs";
import { resolve } from "node:path";

/** Bind the native engine before Next bundles the generated client's dirname. */
export function prismaEngineEnvironment(
	clientDirectory: string,
	environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	if (environment.PRISMA_QUERY_ENGINE_LIBRARY) return { ...environment };
	let engines: string[];
	try {
		engines = readdirSync(clientDirectory, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isFile() &&
					/^(?:libquery_engine-.+\.(?:so|dylib)|query_engine-windows\.dll)\.node$/.test(
						entry.name,
					),
			)
			.map((entry) => resolve(clientDirectory, entry.name));
	} catch {
		throw new Error(
			"Prisma query engine is missing. Run the database client build before starting Web.",
		);
	}
	if (engines.length !== 1) {
		throw new Error(
			"Prisma query engine must be packaged for this host. Set PRISMA_QUERY_ENGINE_LIBRARY when shipping multiple engines.",
		);
	}
	return { ...environment, PRISMA_QUERY_ENGINE_LIBRARY: engines[0] };
}
