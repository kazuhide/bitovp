/** Node-only filesystem boundary; intentionally not exported from the browser entrypoint. */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { z } from "zod";
import type { localCaptionModelIdentityV3Schema } from "./local-caption-translation";
import {
	localPlamoCaptionIdentityForManifest,
	publicPlamoCaptionManifestSchema,
} from "./local-plamo-caption-manifest";
import type { LocalSemanticConfiguration } from "./local-semantic-config";
import { localCaptionIdentityForConfiguration } from "./local-semantic-stages";

export class LocalCaptionConfigurationError extends Error {
	constructor(
		readonly code:
			| "LOCAL_CAPTION_CONFIGURATION_INVALID"
			| "LOCAL_CAPTION_MANIFEST_MISSING"
			| "LOCAL_CAPTION_PROFILE_UNAVAILABLE",
	) {
		super(code);
		this.name = "LocalCaptionConfigurationError";
	}
}
export type LocalCaptionTranslationSelection =
	| {
			provider: "QWEN";
			identity: ReturnType<typeof localCaptionIdentityForConfiguration>;
	  }
	| {
			provider: "PLAMO";
			identity: z.infer<typeof localCaptionModelIdentityV3Schema>;
			manifestHash: string;
	  };

function readManifest(path: string) {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = fstatSync(fd);
		if (!before.isFile() || before.size > 16384 || (before.mode & 0o022) !== 0)
			throw new Error("invalid metadata file");
		const buffer = Buffer.alloc(16385),
			count = readSync(fd, buffer, 0, buffer.length, 0),
			after = fstatSync(fd);
		if (
			count > 16384 ||
			count !== before.size ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs
		)
			throw new Error("changed metadata");
		return publicPlamoCaptionManifestSchema.parse(
			JSON.parse(
				new TextDecoder("utf8", { fatal: true }).decode(
					buffer.subarray(0, count),
				),
			),
		);
	} catch (error) {
		const missing =
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT";
		throw new LocalCaptionConfigurationError(
			missing
				? "LOCAL_CAPTION_MANIFEST_MISSING"
				: "LOCAL_CAPTION_CONFIGURATION_INVALID",
		);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function readLocalCaptionTranslationSelection(
	config: LocalSemanticConfiguration,
	env: Record<string, string | undefined> = process.env,
): LocalCaptionTranslationSelection {
	const provider = env.BITOVP_LOCAL_CAPTION_PROVIDER,
		file = env.BITOVP_LOCAL_CAPTION_MANIFEST_FILE;
	if (provider === undefined || provider === "QWEN") {
		if (file !== undefined)
			throw new LocalCaptionConfigurationError(
				"LOCAL_CAPTION_CONFIGURATION_INVALID",
			);
		return Object.freeze({
			provider: "QWEN",
			identity: Object.freeze(localCaptionIdentityForConfiguration(config)),
		});
	}
	if (provider !== "PLAMO")
		throw new LocalCaptionConfigurationError(
			"LOCAL_CAPTION_CONFIGURATION_INVALID",
		);
	if (!file?.trim())
		throw new LocalCaptionConfigurationError("LOCAL_CAPTION_MANIFEST_MISSING");
	const manifest = readManifest(file);
	if (!manifest.runtimes[config.profile])
		throw new LocalCaptionConfigurationError(
			"LOCAL_CAPTION_PROFILE_UNAVAILABLE",
		);
	const identity = Object.freeze(
		localPlamoCaptionIdentityForManifest(manifest, config.profile),
	);
	return Object.freeze({
		provider: "PLAMO",
		identity,
		manifestHash: identity.manifestHash,
	});
}
