import { constants } from "node:fs";
import {
	access,
	copyFile,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CAPTION_ALIGNMENT_POLICY,
	DEFAULT_ASR_MODEL_SHA256,
	type GenerationTaskParameters,
	NATIVE_EDITING_COMPONENTS,
	type NativeEditingComponent,
	type NativeEditingPreflight,
	nativeEditingPreflightSchema,
	TRANSCRIPTION_QUALITY_POLICY,
	usesGeneratedCaptions,
} from "@bitovp/core";
import {
	type AnalysisBudget,
	analysisBudget,
	verifyAnalysisFile,
	verifyAsrModelFile,
} from "./analysis-io";
import { MediaOperationError, runMediaProcess } from "./process";
import { WHISPER_CPP_VERSION } from "./transcription";

const alignmentProbe = `import hashlib, importlib, importlib.metadata, json, platform, runpy, sys
from pathlib import Path
try:
    module = runpy.run_path(sys.argv[1])
    manifest = json.loads(Path(sys.argv[2]).read_text())
    assert hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest() == sys.argv[4]
    assert manifest["revision"] == module["REVISION"]
    assert manifest["runtime"]["scriptSha256"] == module["digest"](Path(sys.argv[1]))
    assert platform.python_version_tuple()[:2] == ("3", "11")
    for name, package in [("torch", "torch"), ("qwen-asr", "qwen_asr"), ("transformers", "transformers"), ("nagisa", "nagisa"), ("accelerate", "accelerate")]:
        assert importlib.metadata.version(name) == manifest["runtime"][name]
        importlib.import_module(package)
    module["verify_files"](Path(sys.argv[3]), manifest["files"])
    print("READY")
except (AssertionError, module["AlignmentError"] if "module" in globals() else AssertionError):
    print(json.dumps({"code": "MISMATCH"}))
except PermissionError:
    print(json.dumps({"code": "ACCESS_DENIED"}))
except (FileNotFoundError, ModuleNotFoundError):
    print(json.dumps({"code": "MISSING"}))
except Exception:
    print(json.dumps({"code": "FAILED"}))`;

const fontSha256 =
	"68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5";
const assProbe = `[Script Info]
ScriptType: v4.00+
PlayResX: 64
PlayResY: 64
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,Italic,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Noto Sans CJK JP,16,&H00FFFFFF,&H00000000,&H00000000,0,0,1,0,0,2,0,0,0,1
[Events]
Format: Layer,Start,End,Style,Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,字幕A
`;

/** Match the calling process's executable lookup, then bind every probe to it. */
async function resolveExecutable(binary: string) {
	const candidates =
		isAbsolute(binary) || binary.includes("/")
			? [resolve(binary)]
			: (process.env.PATH ?? "")
					.split(":")
					.map((directory) => resolve(directory, binary));
	let accessDenied = false;
	for (const path of candidates) {
		try {
			await access(path, constants.X_OK);
			if ((await stat(path)).isFile()) return path;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (["ENOENT", "ENOTDIR"].includes(code ?? "")) continue;
			if (["EACCES", "EPERM"].includes(code ?? "")) {
				accessDenied = true;
				continue;
			}
			throw error;
		}
	}
	throw new MediaOperationError(accessDenied ? "ACCESS_DENIED" : "MISSING");
}

/** Detect the fixed quality adapter in the executable selected for the command probes. */
async function requireQualityAdapter(binary: string, budget: AnalysisBudget) {
	const file = await open(binary, "r");
	try {
		const marker = "bitovp-mapped-quality-v1";
		const buffer = Buffer.alloc(65536);
		let tail = "",
			total = 0;
		for (;;) {
			budget.check();
			const { bytesRead } = await file.read(buffer);
			if (!bytesRead) break;
			total += bytesRead;
			if (total > 64 * 1024 ** 2) throw new MediaOperationError("MISMATCH");
			const text = tail + buffer.subarray(0, bytesRead).toString("latin1");
			if (text.includes(marker)) return;
			tail = text.slice(-marker.length);
		}
		throw new MediaOperationError("MISMATCH");
	} finally {
		await file.close();
	}
}

/** These checks run as the calling process, including its real mount restrictions. */
async function writableDirectory(root: string, createRoot: boolean) {
	if (!isAbsolute(root)) throw new MediaOperationError("MISMATCH");
	if (createRoot) await mkdir(root, { recursive: true, mode: 0o700 });
	const directory = await mkdtemp(join(root, ".bitovp-preflight-"));
	try {
		const path = join(directory, "probe");
		const file = await open(path, "wx", 0o600);
		try {
			await file.writeFile("bitovp-preflight");
		} finally {
			await file.close();
		}
		if ((await readFile(path, "utf8")) !== "bitovp-preflight")
			throw new MediaOperationError("MISMATCH");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
async function readableFile(path: string) {
	if (!isAbsolute(path)) throw new MediaOperationError("MISMATCH");
	const file = await open(path, "r");
	try {
		const facts = await file.stat();
		if (
			!facts.isFile() ||
			facts.size < 1 ||
			!(await file.read(Buffer.alloc(1), 0, 1, 0)).bytesRead
		)
			throw new MediaOperationError("MISMATCH");
	} finally {
		await file.close();
	}
}
function failureCode(
	error: unknown,
): NativeEditingPreflight["checks"][number]["code"] {
	const code = (error as { code?: unknown } | undefined)?.code;
	if (code === "ENOENT" || code === "MISSING") return "MISSING";
	if (
		code === "EACCES" ||
		code === "EPERM" ||
		code === "EROFS" ||
		code === "ACCESS_DENIED"
	)
		return "ACCESS_DENIED";
	if (
		code === "MISMATCH" ||
		code === "MODEL_CHANGED" ||
		code === "FONT_CHANGED" ||
		code === "VAD_MODEL_CHANGED"
	)
		return "MISMATCH";
	return "FAILED";
}

export async function probeNativeEditingRuntime(
	input: {
		env?: Record<string, string | undefined>;
		signal?: AbortSignal;
		components?: readonly NativeEditingComponent[];
		scratchRoot?: string;
		run?: typeof runMediaProcess;
	} = {},
): Promise<NativeEditingPreflight> {
	const env = input.env ?? process.env;
	const budget = analysisBudget(input.signal, 35_000);
	const run = (binary: string, args: readonly string[]) =>
		(input.run ?? runMediaProcess)(binary, args, {
			signal: input.signal,
			timeoutMs: Math.min(25_000, budget.remaining()),
			maxOutputBytes: 65536,
		});
	const checks: Record<NativeEditingComponent, () => Promise<void>> = {
		MEDIA_TOOLS: async () => {
			await run(env.FFMPEG_PATH ?? "ffmpeg", [
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=s=16x16:r=1:d=1",
				"-f",
				"lavfi",
				"-i",
				"anullsrc=r=48000:cl=stereo",
				"-t",
				"0.04",
				"-vf",
				"scale=16:16,format=yuv420p",
				"-c:v",
				"libx264",
				"-c:a",
				"aac",
				"-f",
				"null",
				"-",
			]);
			await run(env.FFPROBE_PATH ?? "ffprobe", ["-version"]);
		},
		ASR_RUNTIME: async () => {
			const binary = await resolveExecutable(
				env.WHISPER_CLI_PATH ?? "whisper-cli",
			);
			const result = await run(binary, ["--version"]);
			if (
				result.stdout.trim() !== `whisper.cpp version: ${WHISPER_CPP_VERSION}`
			)
				throw new MediaOperationError("MISMATCH");
			const help = await run(binary, ["--help"]);
			for (const flag of [
				"--vad",
				"-vm",
				"-vt",
				"-vspd",
				"-vsd",
				"-vp",
				"-vo",
				"-nth",
				"-lpt",
				"-ng",
				"-nf",
				"-tp",
				"-bs",
				"-bo",
				"-ojf",
			])
				if (
					!new RegExp(`(^|[\\s,])${flag}(?=[\\s,]|$)`).test(
						`${help.stdout}\n${help.stderr}`,
					)
				)
					throw new MediaOperationError("MISMATCH");
			await requireQualityAdapter(binary, budget);
		},
		ASR_MODEL: async () => {
			if (!env.WHISPER_MODEL_PATH) throw new MediaOperationError("MISSING");
			await verifyAsrModelFile(
				env.WHISPER_MODEL_PATH,
				env.WHISPER_MODEL_SHA256 ?? DEFAULT_ASR_MODEL_SHA256,
				"MODEL_CHANGED",
				budget,
			);
		},
		VAD_MODEL: async () =>
			verifyAnalysisFile(
				env.WHISPER_VAD_MODEL_PATH ?? "/editing-models/ggml-silero-v6.2.0.bin",
				TRANSCRIPTION_QUALITY_POLICY.vadModelSha256,
				"VAD_MODEL_CHANGED",
				budget,
			),
		CAPTION_ALIGNMENT: async () => {
			const result = await run("/opt/bitovp-caption-alignment/bin/python", [
				"-I",
				"-B",
				"-c",
				alignmentProbe,
				fileURLToPath(
					new URL("../../scripts/caption-forced-align.py", import.meta.url),
				),
				fileURLToPath(
					new URL("../../native/caption-alignment-model.json", import.meta.url),
				),
				"/editing-models/qwen3-forced-aligner-0.6b",
				CAPTION_ALIGNMENT_POLICY.modelManifestHash,
			]);
			if (result.stdout.trim() === "READY") return;
			let code = "FAILED";
			try {
				const value = JSON.parse(result.stdout);
				if (["MISSING", "ACCESS_DENIED", "MISMATCH"].includes(value.code))
					code = value.code;
			} catch {
				/* Foreign output never becomes readiness or user-visible diagnostics. */
			}
			throw new MediaOperationError(code);
		},
		CAPTION_FONT: async () => {
			const font =
				env.EDITING_FONT_PATH ??
				"/usr/local/share/fonts/bitovp/NotoSansCJKjp-Regular.otf";
			if (!isAbsolute(font)) throw new MediaOperationError("MISMATCH");
			if (env.FONTCONFIG_FILE) await readableFile(env.FONTCONFIG_FILE);
			const directory = await mkdtemp(
				join(input.scratchRoot ?? tmpdir(), ".bitovp-font-preflight-"),
			);
			try {
				if (!/^\/[A-Za-z0-9/_.-]+$/.test(directory))
					throw new MediaOperationError("MISMATCH");
				const fontDirectory = join(directory, "fonts");
				await mkdir(fontDirectory, { mode: 0o700 });
				const copiedFont = join(fontDirectory, "NotoSansCJKjp-Regular.otf");
				await copyFile(font, copiedFont);
				await verifyAnalysisFile(
					copiedFont,
					fontSha256,
					"FONT_CHANGED",
					budget,
				);
				const subtitles = join(directory, "probe.ass");
				await writeFile(subtitles, assProbe, { flag: "wx", mode: 0o600 });
				const rendered = await run(env.FFMPEG_PATH ?? "ffmpeg", [
					"-hide_banner",
					"-loglevel",
					"verbose",
					"-f",
					"lavfi",
					"-i",
					"color=s=64x64:r=1:d=1",
					"-vf",
					`subtitles=filename=${subtitles}:fontsdir=${fontDirectory}`,
					"-frames:v",
					"1",
					"-f",
					"null",
					"-",
				]);
				if (!/fontselect:.*NotoSansCJKjp-Regular/.test(rendered.stderr))
					throw new MediaOperationError("MISMATCH");
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
		SCRATCH: () => writableDirectory(input.scratchRoot ?? tmpdir(), false),
		VOD_PREVIEW_STORAGE: () =>
			writableDirectory(
				env.VOD_INPUT_PREVIEW_DIR ??
					join(tmpdir(), "bitovp-vod-input-previews"),
				true,
			),
	};
	const components = [
		...new Set(input.components ?? NATIVE_EDITING_COMPONENTS),
	];
	const results = await Promise.all(
		components.map(async (component) => {
			try {
				budget.check();
				await checks[component]();
				budget.check();
				return { component, code: "READY" as const };
			} catch (error) {
				return { component, code: failureCode(error) };
			}
		}),
	);
	return nativeEditingPreflightSchema.parse({
		version: "bitovp-native-editing-preflight-v1",
		checkedAt: Date.now(),
		code: results.every((row) => row.code === "READY")
			? "READY"
			: "UNAVAILABLE",
		checks: results,
	});
}

export function nativeGenerationComponents(
	parameters: Pick<GenerationTaskParameters, "policy" | "captions">,
	hasAudio: boolean,
): NativeEditingComponent[] {
	const components: NativeEditingComponent[] = ["MEDIA_TOOLS", "SCRATCH"];
	if (hasAudio === false) return components;
	if (
		parameters.policy === "LOCAL_STORY" ||
		usesGeneratedCaptions(parameters.captions)
	)
		components.push("ASR_RUNTIME", "ASR_MODEL", "VAD_MODEL");
	if (usesGeneratedCaptions(parameters.captions))
		components.push("CAPTION_ALIGNMENT", "CAPTION_FONT");
	return components;
}
export function assertNativeGenerationReady(
	report: NativeEditingPreflight | undefined,
	required: readonly NativeEditingComponent[],
) {
	const parsed = nativeEditingPreflightSchema.safeParse(report);
	for (const component of required) {
		if (
			!parsed.success ||
			parsed.data.checkedAt < Date.now() - 45_000 ||
			parsed.data.checkedAt > Date.now() + 5_000 ||
			!parsed.data.checks.some(
				(row) => row.component === component && row.code === "READY",
			)
		)
			throw new MediaOperationError(`NATIVE_PREFLIGHT_${component}`);
	}
}
