#!/usr/bin/env node
/** Local branch preview. Never reads the repository .env or inherited Compose settings. */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	ASR_MODELS,
	ensureModel,
	VAD_MODEL,
} from "../apps/worker/scripts/download-asr-model.mjs";

const commands = new Set([
	"up",
	"build",
	"seed",
	"demo",
	"asr",
	"dialogue",
	"timeline",
	"status",
	"logs",
	"stop",
	"down",
	"url",
]);
const files = [
	"postgres.env",
	"setup.env",
	"runtime.env",
	"storage.env",
	"seed.env",
	"empty.env",
];
const defaultRepository = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
);

function validPort(value) {
	if (
		!/^\d+$/.test(String(value)) ||
		Number(value) < 1 ||
		Number(value) > 65535
	)
		throw new Error("Port must be an integer from 1 to 65535.");
	return Number(value);
}

export function parseArguments(args) {
	const [command, ...options] = args;
	if (!commands.has(command))
		throw new Error(
			`Usage: node scripts/editing-preview.mjs up|build|seed|demo|dialogue|timeline|asr|status|logs|stop|down|url [--port 3180] [--local-llm] [asr --model ${Object.keys(ASR_MODELS).join("|")}]`,
		);
	let port, localLlm, model;
	for (let index = 0; index < options.length; index++) {
		const option = options[index];
		if (!["up", "build", "asr"].includes(command))
			throw new Error(
				"Only up/build accept --port PORT or --local-llm. Extra Docker options are not accepted.",
			);
		if (option === "--port" && command !== "asr" && port === undefined)
			port = validPort(options[++index]);
		else if (option === "--local-llm" && !localLlm) localLlm = true;
		else if (option === "--model" && command === "asr" && model === undefined) {
			model = options[++index];
			if (!Object.hasOwn(ASR_MODELS, model ?? ""))
				throw new Error(
					`ASR model must be one of: ${Object.keys(ASR_MODELS).join(", ")}.`,
				);
		} else throw new Error("Unknown or repeated preview option.");
	}
	return {
		command,
		port,
		...(localLlm ? { localLlm: true } : {}),
		...(model ? { model } : {}),
	};
}

function directory(path, mode) {
	if (!existsSync(path)) mkdirSync(path, { mode });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("Preview configuration requires a regular directory.");
	if (mode === 0o700 && (stat.mode & 0o077) !== 0)
		throw new Error(
			"Preview configuration directory must be private (chmod 700).",
		);
}

function assertPrivateFile(path) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
		throw new Error(
			"Preview configuration requires a private regular file (chmod 600).",
		);
}

function writePrivate(path, contents) {
	writeFileSync(path, contents, { mode: 0o600, flag: "wx" });
}

const envText = (values) =>
	`${Object.entries(values)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n")}\n`;

function readAsrProfile(config) {
	const path = join(config.directory, "asr-model.json");
	if (!existsSync(path)) return "base";
	try {
		assertPrivateFile(path);
		if (lstatSync(path).size > 1024) throw new Error();
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (
			!value ||
			Object.keys(value).length !== 2 ||
			value.version !== 1 ||
			!Object.hasOwn(ASR_MODELS, value.model)
		)
			throw new Error();
		return value.model;
	} catch {
		throw new Error(
			"ASR profile is invalid; existing settings were preserved.",
		);
	}
}

function saveAsrProfile(config, model) {
	readAsrProfile(config);
	const path = join(config.directory, "asr-model.json");
	const temporary = `${path}.${randomBytes(8).toString("hex")}.partial`;
	try {
		writePrivate(temporary, `${JSON.stringify({ version: 1, model })}\n`);
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function preparePreview(repository, { port } = {}) {
	repository = realpathSync(repository);
	const output = join(repository, "output");
	directory(output, 0o755);
	const configDirectory = join(output, "editing-preview");
	directory(configDirectory, 0o700);
	const statePath = join(configDirectory, "state.json");
	const project = `bitovp-editing-preview-${createHash("sha256").update(repository).digest("hex").slice(0, 8)}`;
	if (existsSync(statePath)) {
		assertPrivateFile(statePath);
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		if (
			state.version !== 1 ||
			state.repository !== repository ||
			state.project !== project
		)
			throw new Error(
				"Preview configuration belongs to another worktree or is invalid; it was preserved.",
			);
		validPort(state.port);
		if (port !== undefined && validPort(port) !== state.port)
			throw new Error(
				`Preview is already configured on port ${state.port}; existing settings were preserved.`,
			);
		for (const name of files) assertPrivateFile(join(configDirectory, name));
		if (readFileSync(join(configDirectory, "empty.env"), "utf8") !== "")
			throw new Error(
				"Preview empty.env must remain empty; inherited settings are not accepted.",
			);
		return { ...state, directory: configDirectory };
	}
	if (readdirSync(configDirectory).length)
		throw new Error(
			"Preview configuration is incomplete; existing private files were preserved. Restore them or move this directory aside before initializing again.",
		);
	const selectedPort = port === undefined ? 3180 : validPort(port);
	const adminPassword = randomBytes(32).toString("base64url");
	const runtimePassword = randomBytes(32).toString("base64url");
	const accessKey = `preview-${randomBytes(12).toString("hex")}`;
	const secretKey = randomBytes(32).toString("base64url");
	const database = "bitovp_editing_preview";
	const adminUrl = `postgresql://bitovp_preview_admin:${adminPassword}@postgres:5432/${database}`;
	writePrivate(
		join(configDirectory, "postgres.env"),
		envText({
			POSTGRES_USER: "bitovp_preview_admin",
			POSTGRES_PASSWORD: adminPassword,
			POSTGRES_DB: database,
		}),
	);
	writePrivate(
		join(configDirectory, "setup.env"),
		envText({
			MIGRATION_DATABASE_URL: adminUrl,
			COMPOSE_MIGRATION_DATABASE_URL: adminUrl,
			RUNTIME_DATABASE_ROLE: "bitovp_runtime",
			RUNTIME_DATABASE_PASSWORD: runtimePassword,
			BITOVP_MIGRATION_IN_CONTAINER: "1",
		}),
	);
	writePrivate(
		join(configDirectory, "runtime.env"),
		envText({
			DATABASE_URL: `postgresql://bitovp_runtime:${runtimePassword}@postgres:5432/${database}`,
			REDIS_URL: "redis://redis:6379",
			MASTER_KEY: randomBytes(32).toString("base64"),
			NODE_ENV: "production",
			AUTH_MODE: "none",
			INGRESS_MODE: "none",
			DEPLOYMENT_PROFILE: "UNRESTRICTED",
			STORAGE_ENDPOINT_ALLOWED_HOSTS: "storage",
			ALLOWED_ORIGIN_HOSTS: "web,localhost,127.0.0.1",
		}),
	);
	writePrivate(
		join(configDirectory, "storage.env"),
		envText({
			AWS_ACCESS_KEY_ID: accessKey,
			AWS_SECRET_ACCESS_KEY: secretKey,
		}),
	);
	writePrivate(
		join(configDirectory, "seed.env"),
		envText({
			BITOVP_EDITING_PREVIEW: "1",
			EDITING_PREVIEW_S3_ACCESS_KEY: accessKey,
			EDITING_PREVIEW_S3_SECRET_KEY: secretKey,
		}),
	);
	writePrivate(join(configDirectory, "empty.env"), "");
	const state = { version: 1, repository, project, port: selectedPort };
	writePrivate(statePath, `${JSON.stringify(state, null, 2)}\n`);
	return { ...state, directory: configDirectory };
}

function verifyPlamoPreviewManifest(config, values, filename) {
	const result = JSON.parse(
		execFileSync(
			"pnpm",
			[
				"--filter",
				"@bitovp/worker",
				"exec",
				"tsx",
				join(
					config.repository,
					"tools/local-semantic-gateway/plamo-manifest-preflight.ts",
				),
			],
			{
				cwd: config.repository,
				env: {
					...(process.env.PATH ? { PATH: process.env.PATH } : {}),
					...values,
					BITOVP_LOCAL_CAPTION_MANIFEST_FILE: filename,
				},
				encoding: "utf8",
				timeout: 15_000,
				maxBuffer: 32_768,
				stdio: ["ignore", "pipe", "pipe"],
			},
		),
	);
	if (
		result.version !== "bitovp-caption-preflight-v1" ||
		result.provider !== "PLAMO" ||
		result.identity?.version !== "local-caption-model-v3" ||
		!/^[a-f0-9]{64}$/.test(result.identity.manifestHash)
	)
		throw new Error("manifest");
}

function assertLocalSemanticConfiguration(config, verifyCaptionManifest) {
	try {
		const envPath = join(config.directory, "local-semantic.env");
		assertPrivateFile(envPath);
		if (lstatSync(envPath).size > 8192) throw new Error("size");
		const entries = readFileSync(envPath, "utf8")
			.split(/\r?\n/)
			.filter((line) => line && !line.startsWith("#"))
			.map((line) => {
				const parsed = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
				if (!parsed) throw new Error("format");
				return [parsed[1], parsed[2]];
			});
		const values = Object.fromEntries(entries);
		const provider = values.BITOVP_LOCAL_CAPTION_PROVIDER;
		if (provider !== undefined && provider !== "QWEN" && provider !== "PLAMO")
			throw new Error("caption provider");
		const keys = [
			"BITOVP_LOCAL_SEMANTIC_ENABLED",
			"BITOVP_LOCAL_SEMANTIC_GATEWAY_URL",
			"BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN",
			"BITOVP_LOCAL_SEMANTIC_CA_FILE",
			"BITOVP_LOCAL_SEMANTIC_PROFILE",
			"BITOVP_LOCAL_SEMANTIC_CONFIG_ID",
			...(provider === undefined ? [] : ["BITOVP_LOCAL_CAPTION_PROVIDER"]),
			...(provider === "PLAMO" ? ["BITOVP_LOCAL_CAPTION_MANIFEST_FILE"] : []),
		];
		if (
			entries.length !== keys.length ||
			Object.keys(values).length !== keys.length ||
			!keys.every((key) => Object.hasOwn(values, key))
		)
			throw new Error("keys");
		const url = new URL(values.BITOVP_LOCAL_SEMANTIC_GATEWAY_URL);
		if (
			values.BITOVP_LOCAL_SEMANTIC_ENABLED !== "1" ||
			url.origin !== "https://192.168.68.62:11437" ||
			url.pathname !== "/" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!/^[-_A-Za-z0-9]{32,256}$/.test(
				values.BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN,
			) ||
			values.BITOVP_LOCAL_SEMANTIC_CA_FILE !==
				"/run/bitovp-local-semantic/gateway-ca.pem" ||
			!["amd", "nvidia"].includes(values.BITOVP_LOCAL_SEMANTIC_PROFILE) ||
			!/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(
				values.BITOVP_LOCAL_SEMANTIC_CONFIG_ID,
			)
		)
			throw new Error("configuration");
		const caPath = join(config.directory, "gateway-ca.pem"),
			ca = lstatSync(caPath);
		if (
			!ca.isFile() ||
			ca.isSymbolicLink() ||
			(ca.mode & 0o022) !== 0 ||
			ca.size > 16384
		)
			throw new Error("certificate");
		new X509Certificate(readFileSync(caPath));
		if (provider === "PLAMO") {
			if (
				values.BITOVP_LOCAL_CAPTION_MANIFEST_FILE !==
				"/run/bitovp-local-semantic/local-caption-manifest.json"
			)
				throw new Error("manifest path");
			const filename = join(config.directory, "local-caption-manifest.json");
			assertPrivateFile(filename);
			if (lstatSync(filename).size > 16_384) throw new Error("manifest size");
			verifyCaptionManifest(config, values, filename);
		}
		return provider === "PLAMO";
	} catch {
		// Never echo private env values, certificate parser errors, or inherited settings.
		throw new Error(
			"Local semantic preview requires a valid private local-semantic.env and regular gateway-ca.pem. Existing settings were preserved.",
		);
	}
}

export function composeInvocation(
	config,
	args,
	source = process.env,
	verifyCaptionManifest = verifyPlamoPreviewManifest,
) {
	const plamo =
		config.localLlm === true &&
		assertLocalSemanticConfiguration(config, verifyCaptionManifest);
	const model = ASR_MODELS[readAsrProfile(config)];
	return {
		command: "docker",
		args: [
			"compose",
			"--project-directory",
			config.repository,
			"--env-file",
			join(config.directory, "empty.env"),
			"--project-name",
			config.project,
			"--file",
			join(config.repository, "docker-compose.editing.yml"),
			...(config.localLlm === true
				? [
						"--file",
						join(config.repository, "docker-compose.editing-local-llm.yml"),
					]
				: []),
			...(plamo
				? [
						"--file",
						join(config.repository, "docker-compose.editing-plamo.yml"),
					]
				: []),
			...args,
		],
		cwd: config.repository,
		// HOME keeps Docker's selected local context/auth. Shell/app/Compose variables never cross this boundary.
		env: {
			...(source.PATH ? { PATH: source.PATH } : {}),
			...(source.HOME ? { HOME: source.HOME } : {}),
			EDITING_PREVIEW_DIRECTORY: config.directory,
			EDITING_PREVIEW_PROJECT: config.project,
			EDITING_PREVIEW_WEB_PORT: String(config.port),
			EDITING_PREVIEW_ASR_MODEL_FILE: model.fileName,
			EDITING_PREVIEW_ASR_MODEL_SHA256: model.sha256,
		},
	};
}

function execute(invocation) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd: invocation.cwd,
			env: invocation.env,
			stdio: "inherit",
			shell: false,
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolvePromise();
			else
				reject(
					new Error(
						`Docker Compose failed (${signal ?? `exit ${code}`}). Preview data was preserved; inspect with the logs command.`,
					),
				);
		});
	});
}

export async function verifyHostHealth(
	port,
	{
		fetchImpl = fetch,
		wait = (milliseconds) =>
			new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
	} = {},
) {
	const url = `http://127.0.0.1:${validPort(port)}/api/health`;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			const response = await fetchImpl(url, {
				signal: AbortSignal.timeout(2000),
				redirect: "error",
			});
			if (response.ok && (await response.json()).status === "ok") return;
		} catch {
			// A healthy container does not prove its published port is reachable from the host.
		}
		if (attempt < 9) await wait(1000);
	}
	throw new Error(
		`Editing preview containers are running, but ${url} is not reachable from this host. Inspect the preview logs; data was preserved.`,
	);
}

/** Public, licensed source is fetched by the host; app containers remain isolated. */
export async function prepareAnimation(config, { fetchImpl = fetch } = {}) {
	const { source } = JSON.parse(
		readFileSync(
			join(
				config.repository,
				"apps/worker/src/library-editing/animation-demo.json",
			),
			"utf8",
		),
	);
	const url = new URL(source.url);
	if (
		url.origin !== "https://video.blender.org" ||
		url.username ||
		url.password ||
		!Number.isSafeInteger(source.bytes) ||
		source.bytes < 1 ||
		source.bytes > 64 * 1024 * 1024 ||
		!/^[a-f0-9]{64}$/.test(source.sha256)
	)
		throw new Error("Animation source manifest is invalid.");
	const path = join(config.directory, "caminandes2-original.mp4");
	const matches = (bytes) =>
		bytes.length === source.bytes &&
		createHash("sha256").update(bytes).digest("hex") === source.sha256;
	if (existsSync(path)) {
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.size !== source.bytes ||
			!matches(readFileSync(path))
		)
			throw new Error(
				"Animation cache was changed; existing bytes were preserved.",
			);
		// This cache contains public CC-BY movie bytes. The non-root seed UID
		// must be able to read the bind mount on Linux as well as Docker Desktop.
		chmodSync(path, 0o644);
		return path;
	}
	const signal = AbortSignal.timeout(120_000);
	let destination = url;
	let response;
	for (let redirects = 0; redirects <= 3; redirects++) {
		response = await fetchImpl(destination.href, {
			redirect: "manual",
			signal,
		});
		if (![301, 302, 303, 307, 308].includes(response.status)) break;
		const location = response.headers.get("location");
		await response.body?.cancel();
		if (!location || redirects === 3)
			throw new Error("Animation download redirect limit exceeded.");
		try {
			destination = new URL(location, destination);
		} catch {
			throw new Error("Animation download redirect is invalid.");
		}
		if (
			destination.origin !== url.origin ||
			destination.username ||
			destination.password
		)
			throw new Error(
				"Animation download redirect is outside the official origin.",
			);
	}
	if (!response?.ok || !response.body)
		throw new Error("Animation download failed; preview data was preserved.");
	const chunks = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.length;
		if (size > source.bytes)
			throw new Error("Animation download exceeded its pinned size.");
		chunks.push(chunk);
	}
	const bytes = Buffer.concat(chunks);
	if (!matches(bytes))
		throw new Error(
			"Animation source verification failed; no cache was written.",
		);
	writeFileSync(path, bytes, { flag: "wx", mode: 0o644 });
	chmodSync(path, 0o644);
	return path;
}

export function prepareDialogue(config) {
	const path = join(
		config.repository,
		"apps/worker/src/library-editing/fixtures/sintel-dialogue-cfr30.mp4",
	);
	const facts = lstatSync(path);
	if (
		!facts.isFile() ||
		facts.isSymbolicLink() ||
		facts.size !== 2061365 ||
		createHash("sha256").update(readFileSync(path)).digest("hex") !==
			"498b9b18398810bf742007135530a32f0699516b6f6012c7f063ca1de0583cd7"
	)
		throw new Error(
			"Dialogue fixture verification failed; existing files were preserved.",
		);
	return path;
}

export async function main(args = process.argv.slice(2), options = {}) {
	const { command, port, localLlm, model } = parseArguments(args);
	const repository = realpathSync(options.repository ?? defaultRepository);
	const log = options.log ?? console.log;
	if (
		!["up", "build"].includes(command) &&
		!existsSync(join(repository, "output", "editing-preview", "state.json"))
	) {
		log(
			"Editing preview is not initialized. Run: node scripts/editing-preview.mjs up",
		);
		return;
	}
	const config = {
		...preparePreview(repository, { port }),
		...(localLlm ? { localLlm: true } : {}),
	};
	directory(join(config.directory, "models"), 0o755);
	chmodSync(join(config.directory, "models"), 0o755);
	const run = (argsToRun) =>
		(options.execute ?? execute)(
			composeInvocation(config, argsToRun, options.environment ?? process.env),
		);
	if (command === "up" || command === "build") {
		await run(["build", "worker", "web", "gateway"]);
		if (command === "build") return;
		await run(["up", "--detach", "--wait", "--wait-timeout", "180"]);
		await (options.verify ?? verifyHostHealth)(config.port);
		await run(["run", "--rm", "--no-deps", "seed"]);
		log(`Editing preview ready: http://127.0.0.1:${config.port}/library`);
		log(
			`Project: ${config.project}. Stop/down preserve database and generated media.`,
		);
	} else if (command === "timeline") {
		await run([
			"run",
			"--rm",
			"--no-deps",
			"seed",
			"pnpm",
			"--filter",
			"@bitovp/worker",
			"exec",
			"tsx",
			"scripts/seed-vod-timeline-preview.ts",
		]);
		log(`VOD timeline fixtures ready: http://127.0.0.1:${config.port}/vod/new`);
	} else if (command === "dialogue") {
		await (options.verify ?? verifyHostHealth)(config.port);
		const path = await (options.prepareDialogue ?? prepareDialogue)(config);
		await run([
			"run",
			"--rm",
			"--no-deps",
			"--volume",
			`${path}:/fixtures/sintel-dialogue-cfr30.mp4:ro`,
			"seed",
			"pnpm",
			"--filter",
			"@bitovp/worker",
			"exec",
			"tsx",
			"scripts/seed-dialogue-preview.ts",
			"--dialogue",
			"/fixtures/sintel-dialogue-cfr30.mp4",
		]);
		log(
			`Dialogue subtitle demo added: http://127.0.0.1:${config.port}/library/72b40340-2426-439e-8029-3e5dc764ee01`,
		);
	} else if (command === "asr") {
		const selected = model ?? readAsrProfile(config);
		const profile = ASR_MODELS[selected];
		await (options.ensureModel ?? ensureModel)({
			...profile,
			file: join(config.directory, "models", profile.fileName),
		});
		await (options.ensureModel ?? ensureModel)({
			...VAD_MODEL,
			file: join(config.directory, "models", VAD_MODEL.fileName),
		});
		if (model || existsSync(join(config.directory, "asr-model.json"))) {
			saveAsrProfile(config, selected);
			await run(["up", "--detach", "--no-deps", "worker", "web"]);
		} else await run(["restart", "worker"]);
		log(
			`Local speech recognition model verified (${selected}). Media and projects were preserved.`,
		);
	} else if (command === "seed")
		await run(["run", "--rm", "--no-deps", "seed"]);
	else if (command === "demo") {
		await (options.verify ?? verifyHostHealth)(config.port);
		log("Preparing the licensed Caminandes 2 demo (47 MB on first download).");
		const path = await (options.prepareAnimation ?? prepareAnimation)(config);
		await run([
			"run",
			"--rm",
			"--no-deps",
			"--volume",
			`${path}:/fixtures/caminandes2.mp4:ro`,
			"seed",
			"pnpm",
			"--filter",
			"@bitovp/worker",
			"exec",
			"tsx",
			"scripts/seed-editing-preview.ts",
			"--animation",
			"/fixtures/caminandes2.mp4",
		]);
		log(`Animation demo added: http://127.0.0.1:${config.port}/library`);
	} else if (command === "status") await run(["ps", "--all"]);
	else if (command === "logs") await run(["logs", "--tail", "100"]);
	else if (command === "stop" || command === "down")
		await run([command, "--timeout", "75"]);
	else if (command === "url") log(`http://127.0.0.1:${config.port}/library`);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	main().catch((error) => {
		console.error(
			error instanceof Error ? error.message : "Editing preview failed.",
		);
		process.exitCode = 1;
	});
}
