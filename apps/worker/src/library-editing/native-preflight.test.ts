import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	assertNativeGenerationReady,
	nativeGenerationComponents,
	probeNativeEditingRuntime,
} from "./native-preflight";
import { runMediaProcess } from "./process";

const io = vi.hoisted(() => ({ asr: vi.fn(), file: vi.fn() }));
vi.mock("./analysis-io", async (load) => ({
	...(await load<object>()),
	verifyAsrModelFile: io.asr,
	verifyAnalysisFile: io.file,
}));
const owned: string[] = [];
const originalCwd = process.cwd();
afterEach(async () => {
	process.chdir(originalCwd);
	vi.resetAllMocks();
	vi.unstubAllEnvs();
	await Promise.all(
		owned.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "native-preflight-test-"));
	owned.push(root);
	const env = {
		WHISPER_MODEL_PATH: "/test/asr.bin",
		WHISPER_MODEL_SHA256: "a".repeat(64),
		VOD_INPUT_PREVIEW_DIR: join(root, "previews"),
		EDITING_FONT_PATH: join(root, "font.otf"),
		WHISPER_CLI_PATH: join(root, "whisper-cli"),
	};
	await writeFile(
		env.EDITING_FONT_PATH,
		"synthetic readable font, not rendering proof",
	);
	await writeFile(
		env.WHISPER_CLI_PATH,
		"authored binary with bitovp-mapped-quality-v1 marker",
	);
	await chmod(env.WHISPER_CLI_PATH, 0o700);
	const run = vi.fn(async (_binary: string, args: readonly string[]) => ({
		stdout: args.includes("--version")
			? "whisper.cpp version: 1.9.5\n"
			: args.includes("--help")
				? "--vad -vm -vt -vspd -vsd -vp -vo -nth -lpt -ng -nf -tp -bs -bo -ojf"
				: args.includes("-c")
					? "READY\n"
					: "",
		stderr: "fontselect: (Noto Sans CJK JP, 400, 0) -> NotoSansCJKjp-Regular",
	}));
	return { env, root, run };
}

it("checks native dependencies without inference and removes only its own write probes", async () => {
	const f = await fixture();
	const result = await probeNativeEditingRuntime({ ...f, scratchRoot: f.root });
	expect(result.code).toBe("READY");
	expect(result.checks).toHaveLength(8);
	expect(result.checks.every((row) => row.code === "READY")).toBe(true);
	expect(await readdir(f.root)).toEqual([
		"font.otf",
		"previews",
		"whisper-cli",
	]);
	expect(await readdir(f.env.VOD_INPUT_PREVIEW_DIR)).toEqual([]);
	expect(io.asr).toHaveBeenCalledTimes(1);
	expect(io.file).toHaveBeenCalledTimes(2);
	expect(JSON.stringify(f.run.mock.calls)).not.toMatch(
		/from_pretrained|\.generate\(|\.align\(|https?:/,
	);
});

it("does not treat missing ASR configuration as healthy", async () => {
	const f = await fixture();
	const result = await probeNativeEditingRuntime({
		...f,
		env: {},
		scratchRoot: f.root,
		components: ["ASR_MODEL"],
	});
	expect(result).toMatchObject({
		code: "UNAVAILABLE",
		checks: [{ component: "ASR_MODEL", code: "MISSING" }],
	});
	expect(io.asr).not.toHaveBeenCalled();
});

it("rejects stock Whisper even when it reports the pinned version and supports the flags", async () => {
	const f = await fixture();
	await writeFile(
		f.env.WHISPER_CLI_PATH,
		"stock binary without the required quality adapter",
	);
	expect(
		(await probeNativeEditingRuntime({ ...f, components: ["ASR_RUNTIME"] }))
			.checks[0]?.code,
	).toBe("MISMATCH");
});

it.each([
	false,
	true,
])("uses only the executable PATH candidate for version, help and quality-marker verification; unused marker=%s", async (unusedHasMarker) => {
	const f = await fixture();
	const first = join(f.root, "first"),
		second = join(f.root, "second");
	await mkdir(first);
	await mkdir(second);
	const ignored = join(first, "whisper-cli"),
		selected = join(second, "whisper-cli");
	await writeFile(
		ignored,
		unusedHasMarker
			? "bitovp-mapped-quality-v1"
			: "unrelated non-executable file",
	);
	await chmod(ignored, 0o600);
	// An authored executable shim proves command lookup/process execution;
	// it does not claim that Whisper or any model ran in this test.
	await writeFile(
		selected,
		`#!/bin/sh
case "$1" in
--version) printf '%s\\n' 'whisper.cpp version: 1.9.5' ;;
--help) printf '%s\\n' '--vad -vm -vt -vspd -vsd -vp -vo -nth -lpt -ng -nf -tp -bs -bo -ojf' ;;
*) exit 2 ;;
esac
# ${unusedHasMarker ? "stock shim without the quality adapter" : "bitovp-mapped-quality-v1"}
`,
	);
	await chmod(selected, 0o700);
	vi.stubEnv("PATH", `${first}:${second}:${process.env.PATH ?? ""}`);
	const { WHISPER_CLI_PATH: _binary, ...env } = f.env;
	const run = vi.fn(runMediaProcess);
	const result = await probeNativeEditingRuntime({
		...f,
		env,
		run,
		components: ["ASR_RUNTIME"],
	});
	expect(result.checks[0]?.code).toBe(unusedHasMarker ? "MISMATCH" : "READY");
	expect(run.mock.calls.map(([binary]) => binary)).toEqual([
		selected,
		selected,
	]);
});

it.each([
	undefined,
	"",
])("matches actual Unix spawn lookup with PATH=%s and a patched cwd shadow", async (path) => {
	const f = await fixture();
	const shadow = join(f.root, "whisper-cli");
	const sentinel = "authored-cwd-whisper-shadow";
	await writeFile(
		shadow,
		`#!/bin/sh
case "$1" in
--version) printf '%s\\n' 'whisper.cpp version: 1.9.5'; printf '%s\\n' '${sentinel}' >&2 ;;
--help) printf '%s\\n' '--vad -vm -vt -vspd -vsd -vp -vo -nth -lpt -ng -nf -tp -bs -bo -ojf' ;;
*) exit 2 ;;
esac
# bitovp-mapped-quality-v1
`,
	);
	await chmod(shadow, 0o700);
	process.chdir(f.root);
	const selectedShadow = join(process.cwd(), "whisper-cli");
	vi.stubEnv("PATH", path);
	const direct = await runMediaProcess("whisper-cli", ["--version"]).catch(
		() => ({ stdout: "", stderr: "" }),
	);
	const run = vi.fn(runMediaProcess);
	const { WHISPER_CLI_PATH: _binary, ...env } = f.env;
	const result = await probeNativeEditingRuntime({
		...f,
		env,
		run,
		components: ["ASR_RUNTIME"],
	});
	if (path === "") {
		expect(direct.stderr).toContain(sentinel);
		expect(result.code).toBe("READY");
		expect(run.mock.calls.map(([binary]) => binary)).toEqual([
			selectedShadow,
			selectedShadow,
		]);
	} else {
		expect(direct.stderr).not.toContain(sentinel);
		// The installed default command may be absent or may be a real Whisper;
		// neither case may inspect or execute the unused working-directory shim.
		expect(run.mock.calls.map(([binary]) => binary)).not.toContain(
			selectedShadow,
		);
		for (const [binary] of run.mock.calls)
			expect(["/usr/bin/whisper-cli", "/bin/whisper-cli"]).toContain(binary);
	}
});

it("verifies the actual copied caption font bytes before trying libass", async () => {
	const f = await fixture();
	io.file.mockRejectedValueOnce(
		Object.assign(new Error("font mismatch"), { code: "FONT_CHANGED" }),
	);
	const result = await probeNativeEditingRuntime({
		...f,
		scratchRoot: f.root,
		components: ["CAPTION_FONT"],
	});
	expect(result.checks[0]?.code).toBe("MISMATCH");
	expect(io.file).toHaveBeenCalledWith(
		expect.stringContaining("NotoSansCJKjp-Regular.otf"),
		"68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5",
		"FONT_CHANGED",
		expect.anything(),
	);
	expect(f.run).not.toHaveBeenCalled();
});

it("uses the same default ASR digest as task execution when only the model path is configured", async () => {
	const f = await fixture();
	const { WHISPER_MODEL_SHA256: _sha, ...env } = f.env;
	await probeNativeEditingRuntime({ ...f, env, components: ["ASR_MODEL"] });
	expect(io.asr).toHaveBeenCalledWith(
		env.WHISPER_MODEL_PATH,
		"60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
		"MODEL_CHANGED",
		expect.anything(),
	);
});

it.each([
	"EACCES",
	"ENOENT",
	"MODEL_CHANGED",
])("sanitizes %s and refuses the unavailable dependency", async (code) => {
	const f = await fixture();
	io.asr.mockRejectedValueOnce(
		Object.assign(new Error("private path and token"), { code }),
	);
	const result = await probeNativeEditingRuntime({
		...f,
		components: ["ASR_MODEL"],
	});
	expect(result.code).toBe("UNAVAILABLE");
	expect(result.checks[0]?.code).toBe(
		code === "EACCES"
			? "ACCESS_DENIED"
			: code === "ENOENT"
				? "MISSING"
				: "MISMATCH",
	);
	expect(JSON.stringify(result)).not.toMatch(/private|test\/asr|token/);
});

it("rejects a superficially executable Whisper of a different version", async () => {
	const f = await fixture();
	f.run.mockResolvedValueOnce({
		stdout: "whisper.cpp version: 1.8.0",
		stderr: "",
	});
	expect(
		(await probeNativeEditingRuntime({ ...f, components: ["ASR_RUNTIME"] }))
			.checks[0]?.code,
	).toBe("MISMATCH");
});

it("does not claim alignment readiness from an invalid response or failed runtime import", async () => {
	const f = await fixture();
	f.run.mockResolvedValueOnce({
		stdout: '{"code":"MISMATCH"}',
		stderr: "secret",
	});
	const result = await probeNativeEditingRuntime({
		...f,
		components: ["CAPTION_ALIGNMENT"],
	});
	expect(result).toMatchObject({
		code: "UNAVAILABLE",
		checks: [{ code: "MISMATCH" }],
	});
	expect(JSON.stringify(result)).not.toContain("secret");
});

it("uses the real writable namespace rather than accepting existing directory metadata", async () => {
	const f = await fixture();
	const result = await probeNativeEditingRuntime({
		...f,
		env: { ...f.env, VOD_INPUT_PREVIEW_DIR: "/dev/null/denied" },
		components: ["VOD_PREVIEW_STORAGE"],
	});
	expect(result.code).toBe("UNAVAILABLE");
	expect(result.checks[0]?.code).not.toBe("READY");
});

it("requires ASR with captions OFF for local story but not alignment or fonts", () => {
	expect(
		nativeGenerationComponents(
			{ policy: "LOCAL_STORY", captions: "OFF" },
			true,
		),
	).toEqual([
		"MEDIA_TOOLS",
		"SCRATCH",
		"ASR_RUNTIME",
		"ASR_MODEL",
		"VAD_MODEL",
	]);
	expect(
		nativeGenerationComponents(
			{ policy: "LOCAL_STORY", captions: "JAPANESE" },
			true,
		),
	).toContain("CAPTION_ALIGNMENT");
	expect(
		nativeGenerationComponents({ policy: "AUTO", captions: "OFF" }, true),
	).toEqual(["MEDIA_TOOLS", "SCRATCH"]);
});

it.each([
	"OFF",
	"AUTO",
] as const)("does not require speech dependencies for video-only LOCAL_STORY with captions=%s", (captions) => {
	expect(
		nativeGenerationComponents({ policy: "LOCAL_STORY", captions }, false),
	).toEqual(["MEDIA_TOOLS", "SCRATCH"]);
});

it("rejects missing, stale and mismatched required checks without blocking unrelated failures", () => {
	const base = {
		version: "bitovp-native-editing-preflight-v1" as const,
		checkedAt: Date.now(),
		code: "UNAVAILABLE" as const,
		checks: [
			{ component: "MEDIA_TOOLS" as const, code: "READY" as const },
			{ component: "CAPTION_ALIGNMENT" as const, code: "MISSING" as const },
		],
	};
	expect(() =>
		assertNativeGenerationReady(base, ["MEDIA_TOOLS"]),
	).not.toThrow();
	expect(() => assertNativeGenerationReady(base, ["ASR_MODEL"])).toThrow(
		"NATIVE_PREFLIGHT_ASR_MODEL",
	);
	expect(() =>
		assertNativeGenerationReady({ ...base, checkedAt: 0 }, ["MEDIA_TOOLS"]),
	).toThrow("NATIVE_PREFLIGHT_MEDIA_TOOLS");
	expect(() => assertNativeGenerationReady(undefined, ["MEDIA_TOOLS"])).toThrow(
		"NATIVE_PREFLIGHT_MEDIA_TOOLS",
	);
});
