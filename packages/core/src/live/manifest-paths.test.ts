import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileLiveChannel } from "./compiler";
import { liveManifestPathIssues } from "./manifest-paths";
import { liveChannelPlanSchema } from "./schema";

function fixture() {
	return liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(__dirname, "__fixtures__/live-rtmp-simple.plan.json"),
				"utf8",
			),
		),
	);
}

describe("Live physical output file reservations", () => {
	it.each([
		[24, 48, false],
		[300, 700, true],
	] as const)(
		"bounds numeric-token matching and denies exhausted searches (%s tokens)",
		(tokens, digits, denied) => {
			const plan = fixture();
			const first = plan.muxings[0];
			const manifest = plan.liveManifests.find((m) => m.kind === "HLS");
			if (!first || first.kind === "MP4" || !manifest)
				throw new Error("Missing fixtures");
			plan.muxings = [first];
			plan.liveManifests = [manifest];
			first.destination = { ...manifest.destination };
			first.segmentNaming = `${"%number%".repeat(tokens)}.ts`;
			manifest.manifestName = `${"1".repeat(digits)}.m3u8`;
			const loader = createRequire(
				new URL("../../../../apps/worker/package.json", import.meta.url),
			).resolve("tsx");
			const script = `import { liveManifestPathIssues } from ${JSON.stringify(new URL("./manifest-paths.ts", import.meta.url).href)}; process.stdout.write(JSON.stringify(liveManifestPathIssues(JSON.parse(process.argv[1]))));`;
			const result = execFileSync(
				process.execPath,
				[
					"--import",
					loader,
					"--input-type=module",
					"--eval",
					script,
					JSON.stringify(plan),
				],
				{ encoding: "utf8", timeout: 3000 },
			);
			const issues = JSON.parse(result) as { code: string }[];
			expect(
				issues.some((i) => i.code === "LIVE_OUTPUT_NAMESPACE_COLLISION"),
			).toBe(denied);
		},
		5000,
	);
	it.each([
		"literal/%number%",
		"literal/{rand_chars:8}",
	])("keeps output directory tokens literal in %s", (folder) => {
		const p = fixture();
		const first = p.muxings[0];
		const manifest = p.liveManifests.find((m) => m.kind === "HLS");
		if (!first || first.kind === "MP4" || !manifest)
			throw new Error("Missing fixtures");
		p.muxings = [first];
		p.liveManifests = [manifest];
		first.destination = { ...manifest.destination, path: folder };
		manifest.destination = { ...manifest.destination, path: folder };
		first.segmentNaming = "%number%.m3u8";
		manifest.manifestName = "1.m3u8";
		expect(
			liveManifestPathIssues(p).some(
				(i) => i.code === "LIVE_OUTPUT_NAMESPACE_COLLISION",
			),
		).toBe(true);
		manifest.manifestName = "index.m3u8";
		expect(liveManifestPathIssues(p)).toEqual([]);
	});
	it("reserves an archive on the storage mirror that the compiler also writes", () => {
		const plan = fixture();
		const origin = plan.outputs[0];
		const manifest = plan.liveManifests.find((entry) => entry.kind === "HLS");
		if (origin?.kind !== "S3" || !manifest)
			throw new Error("Missing storage and manifest fixtures");
		plan.outputs.push(
			{ ...origin, key: "recording", bucket: "recording-storage" },
			{ ...origin, key: "mirror", bucket: "shared-storage" },
		);
		plan.deliveryMirrors = [{ outputKey: "mirror" }];
		plan.muxings.push({
			key: "archive",
			kind: "MP4",
			streamKey: "v1080",
			additionalStreamKeys: ["a128"],
			filename: manifest.manifestName,
			destination: {
				outputKey: "recording",
				path: manifest.destination.path,
			},
		});
		const archive = compileLiveChannel(plan).find(
			(operation) => operation.step === "muxing:archive",
		);
		expect(archive?.refs).toMatchObject({
			outputId: "output:recording",
			mirrorOutputIds: ["output:mirror"],
		});
		expect(liveManifestPathIssues(plan)).toContainEqual(
			expect.objectContaining({
				code: "LIVE_OUTPUT_NAMESPACE_COLLISION",
				path: "muxings[4].destination",
			}),
		);
		const recording = plan.muxings.at(-1);
		if (!recording?.destination) throw new Error("Missing archive fixture");
		recording.destination.path += "/archive";
		expect(liveManifestPathIssues(plan)).toEqual([]);
	});

	it("permits the same writer through an output alias and a mirror", () => {
		const plan = fixture();
		const origin = plan.outputs[0];
		if (!origin) throw new Error("Missing output fixture");
		plan.outputs.push({ ...origin, key: "alias" });
		plan.deliveryMirrors = [{ outputKey: "alias" }];
		expect(liveManifestPathIssues(plan)).toEqual([]);
	});
});
