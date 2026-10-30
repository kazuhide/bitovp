import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const revisionPattern = /^[a-f0-9]{40}$/;

export function sourceRevision(directory) {
	const root = realpathSync(directory);
	let revision;
	if (existsSync(join(root, ".git"))) {
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
		);
		const git = (...args) =>
			execFileSync("git", ["-C", root, ...args], {
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		// A .git file must belong to this checkout, not redirect to another one.
		const worktrees = git("worktree", "list", "--porcelain", "-z").split("\0");
		if (!worktrees.includes(`worktree ${root}`))
			throw new Error("Git metadata does not belong to this checkout.");
		revision = git("rev-parse", "--verify", "HEAD").trim();
	} else {
		// git archive expands this file; do not search any enclosing repository.
		revision = readFileSync(join(root, "SOURCE_REVISION"), "utf8").trim();
	}
	if (!revisionPattern.test(revision))
		throw new Error("A complete source revision is required.");
	return revision;
}

if (
	process.argv[1] &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		console.log(
			sourceRevision(dirname(dirname(fileURLToPath(import.meta.url)))),
		);
	} catch {
		console.error(
			"Source revision unavailable. Use an intact Git checkout or an official source archive.",
		);
		process.exitCode = 1;
	}
}
