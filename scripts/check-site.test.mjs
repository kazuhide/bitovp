import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkSite, MAX_SITE_BYTES } from "./check-site.mjs";

function fixture(t) {
	const parent = mkdtempSync(
		join(realpathSync(tmpdir()), "bitovp-site-check-"),
	);
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "dist");
	mkdirSync(root);
	writeFileSync(
		join(root, "index.html"),
		"<!doctype html><title>bitovp</title>",
	);
	return { parent, root };
}

test("accepts a standalone static bundle and reports the complete byte count", (t) => {
	const { root } = fixture(t);
	mkdirSync(join(root, "assets"));
	writeFileSync(join(root, "assets", "app-123.js"), "console.log('demo');");
	writeFileSync(join(root, "assets", "screen.png"), Buffer.from([1, 2, 3]));
	writeFileSync(join(root, "robots.txt"), "User-agent: *");
	assert.deepEqual(checkSite(root), { files: 4, bytes: 72 });
});

test("requires a nonempty root index.html", (t) => {
	const { root } = fixture(t);
	rmSync(join(root, "index.html"));
	assert.throws(() => checkSite(root), /index\.html/);
	writeFileSync(join(root, "index.html"), "");
	assert.throws(() => checkSite(root), /index\.html/);
});

for (const target of ["file", "directory", "root", "ancestor"]) {
	test(`rejects a symbolic link at the ${target} boundary`, (t) => {
		const { root, parent } = fixture(t);
		const outside = join(parent, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "external.txt"), "not a site asset");
		let input = root;
		if (target === "file") {
			symlinkSync(join(outside, "external.txt"), join(root, "external.txt"));
		} else if (target === "directory") {
			symlinkSync(outside, join(root, "assets"));
		} else if (target === "root") {
			input = join(parent, "linked-dist");
			symlinkSync(root, input);
		} else {
			symlinkSync(parent, join(parent, "alias"));
			input = join(parent, "alias", "dist");
		}
		assert.throws(() => checkSite(input), /symbolic|canonical/);
	});
}

test("rejects hard-linked files before an uploader can dereference them", (t) => {
	const { root, parent } = fixture(t);
	const outside = join(parent, "outside.txt");
	writeFileSync(outside, "not a site asset");
	linkSync(outside, join(root, "linked.txt"));
	assert.throws(() => checkSite(root), /hard link/);
});

test("rejects special files", (t) => {
	const { root } = fixture(t);
	execFileSync("mkfifo", [join(root, "pipe.txt")]);
	assert.throws(() => checkSite(root), /regular file/);
});

for (const name of [
	".env",
	".private/fixture.json",
	"credentials.json",
	"nested/secret.json",
	"private/output.json",
	"vite.config.js",
	"package.json",
	"assets/app.js.map",
	"source.tsx",
	"key.pem",
]) {
	test(`rejects unpublished material: ${name}`, (t) => {
		const { root } = fixture(t);
		const parts = name.split("/");
		mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(root, name), "unpublished");
		assert.throws(
			() => checkSite(root),
			/hidden|private|source map|Unsupported/,
		);
	});
}

test("caps the total artifact at 25 MiB without reading an oversized file", (t) => {
	const { root } = fixture(t);
	const asset = join(root, "large.png");
	writeFileSync(asset, "");
	truncateSync(asset, MAX_SITE_BYTES);
	assert.throws(() => checkSite(root), /25 MiB/);
});

for (const [name, directive] of [
	["app.js", "//# sourceMappingURL=data:application/json;base64,e30="],
	["app.css", "/*# sourceMappingURL=app.css.map */"],
]) {
	test(`rejects a source map directive in ${name}`, (t) => {
		const { root } = fixture(t);
		writeFileSync(join(root, name), directive);
		assert.throws(() => checkSite(root), /source map/);
	});
}

test("the command exits nonzero when the artifact is rejected", (t) => {
	const { root } = fixture(t);
	writeFileSync(join(root, "credentials.json"), "PRIVATE_FIXTURE_VALUE");
	const result = spawnSync(
		process.execPath,
		[new URL("./check-site.mjs", import.meta.url).pathname, root],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Site artifact refused/);
	assert(!`${result.stdout}${result.stderr}`.includes("PRIVATE_FIXTURE_VALUE"));
});
