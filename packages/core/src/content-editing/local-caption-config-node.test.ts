import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLocalCaptionTranslationSelection } from "./local-caption-config-node";
import {
	LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
	PLAMO_CAPTION_TEMPLATE_HASH,
} from "./local-caption-translation";
import {
	localCaptionIdentityForConfiguration,
	localStoryIdentityForConfiguration,
} from "./local-semantic-stages";

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const config = {
	url: "https://fixture.invalid",
	token: "fixture-token-not-a-secret-".repeat(2),
	caFile: "/unused/ca.pem",
	profile: "nvidia" as const,
	configId: "00000000-0000-4000-8000-000000000001",
};
const manifest = () => ({
	version: "bitovp-plamo-installed-manifest-v1",
	configId: "00000000-0000-4000-8000-000000000002",
	modelId: "pfnet/plamo-3-translate-31b",
	sourceRevision: "01eac57bf80ef8114decd998f8f3a803ba795557",
	weightSha256: hash("synthetic fixture GGUF, not real model weights"),
	weightBytes: 43,
	quantization: "Q8_0",
	conversionRecipeHash: hash("synthetic fixture conversion"),
	promptTemplateHash: PLAMO_CAPTION_TEMPLATE_HASH,
	contextPolicyFingerprint: LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
	runtimes: {
		nvidia: {
			sourceRevision: "a".repeat(40),
			binarySha256: hash("synthetic CUDA fixture"),
		},
		amd: {
			sourceRevision: "a".repeat(40),
			binarySha256: hash("synthetic HIP fixture"),
		},
	},
});
const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0))
		rmSync(folder, { recursive: true, force: true });
});
function file(value: unknown = manifest()) {
	const folder = mkdtempSync(join(tmpdir(), "caption-manifest-"));
	folders.push(folder);
	const path = join(folder, "installed.json");
	writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
	return path;
}
const env = (path: string) => ({
	BITOVP_LOCAL_CAPTION_PROVIDER: "PLAMO",
	BITOVP_LOCAL_CAPTION_MANIFEST_FILE: path,
});

describe("operator-only translation provider selection", () => {
	it("keeps Qwen v2 and old Story identity unchanged when no separate model is selected", () => {
		expect(readLocalCaptionTranslationSelection(config, {})).toEqual({
			provider: "QWEN",
			identity: localCaptionIdentityForConfiguration(config),
		});
		expect(localStoryIdentityForConfiguration(config).schemaHash).toBe(
			"c6e24f37dddb8dbf8ff046f91d82142f130463f3fa6ddecb66a74eadad5c0189",
		);
	});
	it.each([
		{ BITOVP_LOCAL_CAPTION_PROVIDER: "" },
		{ BITOVP_LOCAL_CAPTION_PROVIDER: "GPT" },
		{ BITOVP_LOCAL_CAPTION_MANIFEST_FILE: "/missing" },
		{
			BITOVP_LOCAL_CAPTION_PROVIDER: "QWEN",
			BITOVP_LOCAL_CAPTION_MANIFEST_FILE: "/missing",
		},
		{ BITOVP_LOCAL_CAPTION_PROVIDER: "PLAMO" },
		{
			BITOVP_LOCAL_CAPTION_PROVIDER: "PLAMO",
			BITOVP_LOCAL_CAPTION_MANIFEST_FILE: "/missing",
		},
	])("rejects partial/unknown/unavailable choices without Qwen fallback %#", (value) => {
		expect(() => readLocalCaptionTranslationSelection(config, value)).toThrow(
			/LOCAL_CAPTION_/,
		);
	});
	it("uses actual manifest pins and a separate profile runtime without changing Story config", () => {
		const path = file(),
			nv = readLocalCaptionTranslationSelection(config, env(path)),
			amd = readLocalCaptionTranslationSelection(
				{ ...config, profile: "amd" },
				env(path),
			);
		expect(nv).toMatchObject({
			provider: "PLAMO",
			identity: {
				version: "local-caption-model-v3",
				profile: "nvidia",
				weightSha256: manifest().weightSha256,
				configId: manifest().configId,
			},
		});
		expect(amd).toMatchObject({
			provider: "PLAMO",
			identity: { profile: "amd" },
		});
		expect(nv.identity).not.toEqual(amd.identity);
		expect(Object.isFrozen(nv.identity)).toBe(true);
		const changed = manifest();
		changed.weightSha256 = hash("another synthetic model");
		writeFileSync(path, JSON.stringify(changed));
		expect(
			readLocalCaptionTranslationSelection(config, env(path)).identity,
		).not.toEqual(nv.identity);
	});
	it("rejects unknown paths/options, wrong template and missing current profile", () => {
		for (const value of [
			{ ...manifest(), binaryPath: "/run/anything" },
			{ ...manifest(), promptTemplateHash: "f".repeat(64) },
			{ ...manifest(), runtimes: { amd: manifest().runtimes.amd } },
			{ ...manifest(), weightSha256: "not-a-hash" },
		]) {
			expect(() =>
				readLocalCaptionTranslationSelection(config, env(file(value))),
			).toThrow(/LOCAL_CAPTION_/);
		}
	});
	it("bounds regular UTF8 files and rejects symlinks/writable metadata", () => {
		const path = file(),
			link = `${path}.link`;
		symlinkSync(path, link);
		expect(() =>
			readLocalCaptionTranslationSelection(config, env(link)),
		).toThrow(/LOCAL_CAPTION_/);
		chmodSync(path, 0o666);
		expect(() =>
			readLocalCaptionTranslationSelection(config, env(path)),
		).toThrow(/LOCAL_CAPTION_/);
		chmodSync(path, 0o600);
		writeFileSync(path, " ".repeat(16385));
		expect(() =>
			readLocalCaptionTranslationSelection(config, env(path)),
		).toThrow(/LOCAL_CAPTION_/);
		writeFileSync(path, Buffer.from([0xff]));
		expect(() =>
			readLocalCaptionTranslationSelection(config, env(path)),
		).toThrow(/LOCAL_CAPTION_/);
		const directory = `${path}.directory`;
		mkdirSync(directory);
		expect(() =>
			readLocalCaptionTranslationSelection(config, env(directory)),
		).toThrow(/LOCAL_CAPTION_/);
	});
});

describe("installed PLaMo runtime backends", () => {
	it("projects an explicit AMD Vulkan backend into the selected identity and cache hash", () => {
		const legacy = manifest();
		const selected = {
			...legacy,
			runtimes: {
				amd: { ...legacy.runtimes.amd, backend: "VULKAN" },
				nvidia: legacy.runtimes.nvidia,
			},
		};
		const amd = { ...config, profile: "amd" as const };
		const old = readLocalCaptionTranslationSelection(amd, env(file(legacy)));
		const current = readLocalCaptionTranslationSelection(
			amd,
			env(file(selected)),
		);
		expect(old.identity).not.toHaveProperty("runtimeBackend");
		expect(current.identity).toMatchObject({
			profile: "amd",
			runtimeBackend: "VULKAN",
		});
		expect(current.identity).not.toEqual(old.identity);
	});
	it.each([
		{ amd: { ...manifest().runtimes.amd, backend: "CUDA" } },
		{ nvidia: { ...manifest().runtimes.nvidia, backend: "VULKAN" } },
		{ nvidia: { ...manifest().runtimes.nvidia, backend: "ROCM" } },
		{ amd: { ...manifest().runtimes.amd, backend: "UNKNOWN" } },
	])("rejects unknown or profile-incompatible public backends %#", (runtimes) => {
		expect(() =>
			readLocalCaptionTranslationSelection(
				{ ...config, profile: "amd" in runtimes ? "amd" : "nvidia" },
				env(file({ ...manifest(), runtimes })),
			),
		).toThrow(/LOCAL_CAPTION_/);
	});
});
