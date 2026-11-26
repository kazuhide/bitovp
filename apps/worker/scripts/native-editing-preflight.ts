import { readlink } from "node:fs/promises";
import { readLocalSemanticConfiguration } from "@bitovp/core";
import { readLocalCaptionTranslationSelection } from "@bitovp/core/local-caption-config";
import { probeLocalClipGateway } from "@bitovp/core/local-semantic-diagnostic-probe";
import { probeNativeEditingRuntime } from "../src/library-editing/native-preflight";

async function main() {
	const args = process.argv.slice(2);
	if (args.length > 1 || (args.length === 1 && args[0] !== "--vod-input"))
		throw new Error("INVALID_ARGUMENT");
	const vodInput = args[0] === "--vod-input";
	const uid = process.geteuid?.();
	const mountNamespace = await readlink("/proc/self/ns/mnt").catch(() => null);
	const context = {
		pid: process.pid,
		uid,
		gid: process.getegid?.(),
		umask: process.umask().toString(8).padStart(3, "0"),
		mountNamespace,
	};
	const signal = AbortSignal.timeout(40_000);
	const native = await probeNativeEditingRuntime({
		signal,
		...(vodInput
			? { components: ["MEDIA_TOOLS", "SCRATCH", "VOD_PREVIEW_STORAGE"] }
			: {}),
	});
	let localModel = "NOT_REQUIRED";
	if (!vodInput) {
		try {
			const config = readLocalSemanticConfiguration(process.env);
			localModel = config
				? (
						await probeLocalClipGateway(
							config,
							undefined,
							signal,
							readLocalCaptionTranslationSelection(config),
						)
					).code
				: "DISABLED";
		} catch {
			localModel = "UNAVAILABLE";
		}
	}
	// Root's access is not evidence that a service user can read its models.
	const qualifiedContext =
		uid !== undefined &&
		uid !== 0 &&
		(process.platform !== "linux" || mountNamespace !== null);
	const ready =
		qualifiedContext &&
		native.code === "READY" &&
		(vodInput || localModel === "READY");
	console.log(
		JSON.stringify({
			version: "bitovp-native-preflight-cli-v1",
			ready,
			context,
			native,
			localModel,
		}),
	);
	process.exitCode = ready ? 0 : 1;
}
main().catch(() => {
	console.log(
		JSON.stringify({
			version: "bitovp-native-preflight-cli-v1",
			ready: false,
			code: "PREFLIGHT_FAILED",
		}),
	);
	process.exitCode = 1;
});
