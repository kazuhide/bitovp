import assert from "node:assert/strict";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_SITE_BYTES = 25 * 1024 * 1024;
const extensions = new Set([
	".html",
	".css",
	".js",
	".png",
	".svg",
	".ico",
	".txt",
	".json",
	".woff2",
	".webp",
	".jpg",
	".jpeg",
]);
const privateName =
	/(?:^|[._-])(?:private|secrets?|credentials?|config|local)(?:[._-]|$)|^(?:package|tsconfig|jsconfig)\.json$/i;

export function checkSite(directory) {
	const root = resolve(directory);
	assert(!lstatSync(root).isSymbolicLink(), "Site root is a symbolic link");
	assert(lstatSync(root).isDirectory(), "Site root must be a directory");
	assert.equal(realpathSync(root), root, "Site root must use a canonical path");
	const result = { files: 0, bytes: 0 };
	let hasIndex = false;
	function visit(dir) {
		for (const name of readdirSync(dir)) {
			assert(!name.startsWith("."), "Site contains a hidden entry");
			assert(
				!privateName.test(name),
				"Site contains a private/configuration entry",
			);
			const path = join(dir, name);
			const stat = lstatSync(path);
			assert(!stat.isSymbolicLink(), "Site contains a symbolic link");
			const rel = relative(root, realpathSync(path));
			assert(
				!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`),
				"Site entry is outside the artifact root",
			);
			if (stat.isDirectory()) {
				visit(path);
				continue;
			}
			assert(stat.isFile(), "Site entry must be a regular file");
			assert.equal(stat.nlink, 1, "Site contains a hard link");
			assert(
				!name.toLowerCase().endsWith(".map"),
				"Site contains a source map",
			);
			assert(
				extensions.has(extname(name).toLowerCase()),
				"Unsupported site file type",
			);
			result.files++;
			result.bytes += stat.size;
			assert(result.bytes <= MAX_SITE_BYTES, "Site exceeds 25 MiB");
			if ([".js", ".css"].includes(extname(name).toLowerCase())) {
				assert(
					!/(?:\/\/|\/\*)[#@]\s*sourceMappingURL\s*=/.test(
						readFileSync(path, "utf8"),
					),
					"Site contains a source map directive",
				);
			}
			if (path === join(root, "index.html") && stat.size > 0) hasIndex = true;
		}
	}
	visit(root);
	assert(hasIndex, "Site requires a nonempty root index.html");
	return result;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		assert(
			process.argv.length <= 3,
			"Usage: node scripts/check-site.mjs [directory]",
		);
		const result = checkSite(
			process.argv[2] ??
				fileURLToPath(new URL("../apps/site/dist", import.meta.url)),
		);
		console.log(
			`Site artifact checked: ${result.files} files, ${result.bytes} bytes.`,
		);
	} catch (error) {
		console.error(
			`Site artifact refused: ${error instanceof Error ? error.message : "Invalid artifact"}`,
		);
		process.exitCode = 1;
	}
}
