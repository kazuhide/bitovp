import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../../..");
const USER_GUIDE_PAGES = [
	"INSTALLATION.md",
	"GETTING-STARTED.md",
	"VOD.md",
	"LIVE.md",
	"QUALITY-AND-MONITORING.md",
	"LIBRARY-AND-ADMIN.md",
	"TROUBLESHOOTING.md",
	"GLOSSARY.md",
	"USER-GUIDE.ja.md",
];
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

function markdownFiles(directory: string): string[] {
	return readdirSync(join(REPO, directory), { withFileTypes: true }).flatMap(
		(entry) => {
			const path = `${directory}/${entry.name}`;
			return entry.isDirectory()
				? markdownFiles(path)
				: entry.name.endsWith(".md")
					? [path]
					: [];
		},
	);
}

function links(text: string): string[] {
	return [...text.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)].map(
		(match) => match[1] ?? "",
	);
}

function anchor(heading: string): string {
	return heading
		.toLowerCase()
		.replace(/<[^>]*>/g, "")
		.replace(/[`*_~]/g, "")
		.replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
		.trim()
		.replace(/\s+/g, "-");
}

describe("user documentation navigation", () => {
	it("opens with the graphical application and indexes each task guide", () => {
		expect(read("README.md")).toContain("http://localhost:3100");
		expect(read("README.md")).toContain("./docs/USER-GUIDE.md");
		const indexed = links(read("docs/USER-GUIDE.md"))
			.filter(
				(link) => link.startsWith("./user-guide/") && link.endsWith(".md"),
			)
			.map((link) => link.slice("./user-guide/".length));
		expect([...new Set(indexed)].sort()).toEqual([...USER_GUIDE_PAGES].sort());
		expect(readdirSync(join(REPO, "docs/user-guide")).sort()).toEqual(
			[...USER_GUIDE_PAGES, "bitovp-user-guide-ja.pdf"].sort(),
		);
	});

	it("has no broken local file links or heading anchors", () => {
		const broken: string[] = [];
		for (const source of ["README.md", ...markdownFiles("docs")]) {
			for (const raw of links(read(source))) {
				const [pathAndQuery = "", fragment = ""] = raw.split("#", 2);
				const target = pathAndQuery.split("?", 1)[0] ?? "";
				if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/"))
					continue;
				const absolute = target
					? resolve(dirname(join(REPO, source)), target)
					: join(REPO, source);
				if (!existsSync(absolute)) {
					broken.push(`${source} -> ${raw}`);
					continue;
				}
				if (fragment && absolute.endsWith(".md")) {
					const anchors = readFileSync(absolute, "utf8")
						.split("\n")
						.flatMap((line) => {
							const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1];
							return heading ? [anchor(heading)] : [];
						});
					if (!anchors.includes(decodeURIComponent(fragment)))
						broken.push(`${source} -> ${raw}`);
				}
			}
		}
		expect(broken).toEqual([]);
	});

	it("names only existing application pages in the task guides", () => {
		const missing: string[] = [];
		for (const source of [
			"docs/USER-GUIDE.md",
			...USER_GUIDE_PAGES.map((name) => `docs/user-guide/${name}`),
		]) {
			for (const match of read(source).matchAll(
				/`(\/(?!api(?:\/|`))[a-z0-9[\]-]+(?:\/[a-z0-9[\]-]+)*)`/gi,
			)) {
				const route = match[1] ?? "";
				if (!existsSync(join(REPO, "apps/web/src/app", route, "page.tsx")))
					missing.push(`${source} -> ${route}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("explains the billable Live boundary and independent delivery checks", () => {
		const live = read("docs/user-guide/LIVE.md");
		expect(live).toMatch(
			/Creating a Live channel immediately starts provisioning/,
		);
		for (const term of [
			"charges",
			"RUNNING",
			"CONNECTED",
			"progress",
			"heartbeat",
			"RTMP",
			"redundant RTMP",
			"SRT",
			"Zixi",
			"HLS pull",
		])
			expect(live).toContain(term);
	});

	it("keeps installation prerequisites and authentication modes aligned", () => {
		const installation = read("docs/user-guide/INSTALLATION.md");
		for (const text of [installation, read("README.md")])
			expect(text).toContain("Docker Compose 2.30.0");
		expect(installation).toContain("PUBLIC_BASE_URL=http://localhost:3100");
		for (const mode of ["password", "users", "oidc", "none"]) {
			expect(read("apps/web/src/lib/auth/config.ts")).toContain(`"${mode}"`);
			if (mode !== "oidc") {
				expect(read(".env.example")).toMatch(new RegExp(`\\b${mode}\\b`));
			}
			expect(installation).toContain(`AUTH_MODE=${mode}`);
		}
	});
});
