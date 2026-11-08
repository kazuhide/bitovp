import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rootCertificates } from "node:tls";
import { parseEnv } from "node:util";
import {
	composeInvocation,
	main,
	parseArguments,
	prepareAnimation,
	prepareDialogue,
	preparePreview,
	verifyHostHealth,
} from "./editing-preview.mjs";

function fixture(t) {
	const repository = mkdtempSync(join(tmpdir(), "bitovp preview "));
	t.after(() => rmSync(repository, { recursive: true, force: true }));
	return repository;
}

test("preview gets private credentials distinct from the migration administrator", (t) => {
	const repository = fixture(t);
	const config = preparePreview(repository);
	const read = (name) =>
		parseEnv(readFileSync(join(config.directory, name), "utf8"));
	const postgres = read("postgres.env");
	const setup = read("setup.env");
	const runtime = read("runtime.env");
	const seed = read("seed.env");
	const storage = read("storage.env");
	assert.equal(statSync(config.directory).mode & 0o777, 0o700);
	for (const name of [
		"postgres.env",
		"setup.env",
		"runtime.env",
		"seed.env",
		"storage.env",
		"empty.env",
		"state.json",
	])
		assert.equal(statSync(join(config.directory, name)).mode & 0o777, 0o600);
	const administrator = new URL(setup.MIGRATION_DATABASE_URL);
	const application = new URL(runtime.DATABASE_URL);
	assert.equal(administrator.hostname, "postgres");
	assert.equal(application.hostname, "postgres");
	assert.equal(application.pathname, "/bitovp_editing_preview");
	assert.equal(application.username, "bitovp_runtime");
	assert.notEqual(administrator.username, application.username);
	assert.notEqual(administrator.password, application.password);
	assert.equal(application.password, setup.RUNTIME_DATABASE_PASSWORD);
	assert.equal(administrator.password, postgres.POSTGRES_PASSWORD);
	assert.equal(Buffer.from(runtime.MASTER_KEY, "base64").length, 32);
	assert.equal(runtime.AUTH_MODE, "none");
	assert.equal(runtime.INGRESS_MODE, "none");
	assert.equal(runtime.STORAGE_ENDPOINT_ALLOWED_HOSTS, "storage");
	assert.equal(seed.BITOVP_EDITING_PREVIEW, "1");
	assert.equal(seed.EDITING_PREVIEW_S3_ACCESS_KEY, storage.AWS_ACCESS_KEY_ID);
	assert.equal(
		seed.EDITING_PREVIEW_S3_SECRET_KEY,
		storage.AWS_SECRET_ACCESS_KEY,
	);
	for (const key of [
		"MIGRATION_DATABASE_URL",
		"POSTGRES_PASSWORD",
		"RUNTIME_DATABASE_PASSWORD",
		"EDITING_PREVIEW_S3_SECRET_KEY",
	])
		assert.equal(runtime[key], undefined);
});

function animationFixture(t) {
	const repository = fixture(t);
	const config = preparePreview(repository);
	const directory = join(repository, "apps/worker/src/library-editing");
	mkdirSync(directory, { recursive: true });
	const bytes = Buffer.from("licensed animation source");
	writeFileSync(
		join(directory, "animation-demo.json"),
		JSON.stringify({
			source: {
				url: "https://video.blender.org/download/web-videos/example.mp4",
				bytes: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
		}),
	);
	return { config, bytes };
}

test("animation is a separate command that seeds through a read-only source mount", async (t) => {
	const repository = fixture(t);
	preparePreview(repository);
	const calls = [];
	let checked = false;
	await main(["demo"], {
		repository,
		verify: async () => {
			checked = true;
		},
		prepareAnimation: async () => {
			assert.equal(checked, true);
			return join(
				repository,
				"output/editing-preview/caminandes2-original.mp4",
			);
		},
		execute: async (call) => calls.push(call),
		log: () => {},
	});
	assert.equal(calls.length, 1);
	const args = calls[0].args.slice(9);
	assert.deepEqual(args.slice(0, 4), ["run", "--rm", "--no-deps", "--volume"]);
	assert.ok(args[4].endsWith(":/fixtures/caminandes2.mp4:ro"));
	assert.deepEqual(args.slice(5), [
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
	assert.ok(!calls[0].env.DATABASE_URL);
});

test("animation fetch verifies size and hash, then reuses the exact cached bytes offline", async (t) => {
	const { config, bytes } = animationFixture(t);
	let requests = 0;
	const path = await prepareAnimation(config, {
		fetchImpl: async (url, options) => {
			requests++;
			assert.match(url, /^https:\/\/video\.blender\.org\//);
			assert.equal(options.redirect, "manual");
			assert.ok(options.signal instanceof AbortSignal);
			return new Response(bytes);
		},
	});
	assert.deepEqual(readFileSync(path), bytes);
	assert.equal(statSync(path).mode & 0o777, 0o644);
	chmodSync(path, 0o600);
	assert.equal(
		await prepareAnimation(config, {
			fetchImpl: async () => {
				throw new Error("must stay offline");
			},
		}),
		path,
	);
	assert.equal(requests, 1);
	assert.equal(statSync(path).mode & 0o777, 0o644);
	writeFileSync(path, Buffer.alloc(bytes.length, 1));
	await assert.rejects(prepareAnimation(config), /cache.*changed/i);
	assert.deepEqual(readFileSync(path), Buffer.alloc(bytes.length, 1));
});

test("animation rejects short, oversized, corrupt, and unsuccessful downloads without a cache", async (t) => {
	for (const kind of ["short", "oversized", "corrupt", "http"]) {
		const { config, bytes } = animationFixture(t);
		const body =
			kind === "short"
				? bytes.subarray(1)
				: kind === "oversized"
					? Buffer.concat([bytes, Buffer.from("!")])
					: Buffer.alloc(bytes.length);
		await assert.rejects(
			prepareAnimation(config, {
				fetchImpl: async () =>
					new Response(body, { status: kind === "http" ? 503 : 200 }),
			}),
			/animation.*(download|verification)/i,
		);
		assert.throws(() =>
			statSync(join(config.directory, "caminandes2-original.mp4")),
		);
	}
});

test("animation refuses symlink cache entries and never seeds an unhealthy preview", async (t) => {
	const { config, bytes } = animationFixture(t);
	const target = join(config.directory, "source.mp4");
	writeFileSync(target, bytes);
	symlinkSync(target, join(config.directory, "caminandes2-original.mp4"));
	await assert.rejects(prepareAnimation(config), /cache.*changed/i);
	const calls = [];
	await assert.rejects(
		main(["demo"], {
			repository: config.repository,
			verify: async () => {
				throw new Error("unhealthy preview");
			},
			execute: async (call) => calls.push(call),
			prepareAnimation: async () => {
				throw new Error("must not download");
			},
		}),
		/unhealthy preview/,
	);
	assert.equal(calls.length, 0);
});

test("animation follows the official same-origin storage redirect with one total timeout", async (t) => {
	const { config, bytes } = animationFixture(t);
	const requests = [];
	const path = await prepareAnimation(config, {
		fetchImpl: async (url, options) => {
			requests.push({ url, signal: options.signal });
			return requests.length === 1
				? new Response(null, {
						status: 302,
						headers: { location: "/object-storage/movie.mp4?lease=example" },
					})
				: new Response(bytes);
		},
	});
	assert.equal(requests.length, 2);
	assert.equal(
		requests[1].url,
		"https://video.blender.org/object-storage/movie.mp4?lease=example",
	);
	assert.equal(requests[0].signal, requests[1].signal);
	assert.deepEqual(readFileSync(path), bytes);
});

test("animation refuses cross-origin, credentialed, and endless redirects before caching", async (t) => {
	for (const location of [
		"https://other.example/movie.mp4",
		"https://user:pass@video.blender.org/movie.mp4",
		"/again",
	]) {
		const { config } = animationFixture(t);
		let requests = 0;
		await assert.rejects(
			prepareAnimation(config, {
				fetchImpl: async () => {
					requests++;
					return new Response(null, { status: 302, headers: { location } });
				},
			}),
			/animation.*redirect/i,
		);
		assert.equal(requests, location === "/again" ? 4 : 1);
		assert.throws(() =>
			statSync(join(config.directory, "caminandes2-original.mp4")),
		);
	}
});

test("repeat startup preserves encryption key, database passwords, and the selected port", (t) => {
	const repository = fixture(t);
	const first = preparePreview(repository, { port: 3197 });
	const before = readFileSync(join(first.directory, "runtime.env"), "utf8");
	const second = preparePreview(repository);
	assert.equal(second.port, 3197);
	assert.equal(second.project, first.project);
	assert.equal(
		readFileSync(join(first.directory, "runtime.env"), "utf8"),
		before,
	);
	assert.throws(
		() => preparePreview(repository, { port: 3198 }),
		/configured.*3197/,
	);
});

test("different worktrees get different projects and volumes", (t) => {
	assert.notEqual(
		preparePreview(fixture(t)).project,
		preparePreview(fixture(t)).project,
	);
});

test("incomplete private setup is preserved instead of silently rotating keys", (t) => {
	const repository = fixture(t);
	const directory = join(repository, "output", "editing-preview");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	writeFileSync(join(directory, "runtime.env"), "MASTER_KEY=keep-me\n", {
		mode: 0o600,
	});
	assert.throws(() => preparePreview(repository), /incomplete/i);
	assert.equal(
		readFileSync(join(directory, "runtime.env"), "utf8"),
		"MASTER_KEY=keep-me\n",
	);
});

test("private setup rejects symlink destinations", (t) => {
	const repository = fixture(t);
	const target = fixture(t);
	symlinkSync(target, join(repository, "output"));
	assert.throws(() => preparePreview(repository), /regular directory/i);
});

test("existing unsafe private file permissions fail closed", (t) => {
	const config = preparePreview(fixture(t));
	writeFileSync(join(config.directory, "runtime.env"), "", { mode: 0o644 });
	// writeFile does not change existing mode, so create a distinct unsafe file.
	rmSync(join(config.directory, "runtime.env"));
	writeFileSync(join(config.directory, "runtime.env"), "", { mode: 0o644 });
	assert.throws(
		() => preparePreview(config.repository),
		/private regular file/i,
	);
});

test("Compose ignores inherited profiles, overrides, production credentials, and dotenv", (t) => {
	const config = preparePreview(fixture(t));
	const invocation = composeInvocation(config, ["ps"], {
		PATH: "/safe/path",
		HOME: "/safe/home",
		COMPOSE_FILE: "production.yml",
		COMPOSE_PROFILES: "quick-tunnel",
		DATABASE_URL: "postgresql://production",
		MASTER_KEY: "production-key",
		EDITING_PREVIEW_WEB_PORT: "9999",
		DOCKER_HOST: "tcp://remote:2375",
	});
	assert.equal(invocation.command, "docker");
	assert.ok(
		!invocation.args.some((arg) => arg.endsWith("docker-compose.story.yml")),
	);
	assert.deepEqual(invocation.args.slice(0, 7), [
		"compose",
		"--project-directory",
		config.repository,
		"--env-file",
		join(config.directory, "empty.env"),
		"--project-name",
		config.project,
	]);
	assert.ok(
		invocation.args.includes(
			join(config.repository, "docker-compose.editing.yml"),
		),
	);
	assert.equal(invocation.env.EDITING_PREVIEW_WEB_PORT, "3180");
	assert.equal(invocation.env.PATH, "/safe/path");
	assert.equal(invocation.env.HOME, "/safe/home");
	for (const key of [
		"COMPOSE_FILE",
		"COMPOSE_PROFILES",
		"DATABASE_URL",
		"MASTER_KEY",
		"DOCKER_HOST",
	])
		assert.equal(invocation.env[key], undefined);
});

function staleStoryConfiguration(config) {
	const identity = {
		version: "aisa-story-model-v1",
		provider: "CODEX_CLI",
		model: "gpt-6.1-sol",
		promptVersion: "aisa-story-prompt-v1",
		schemaHash: "a".repeat(64),
		configId: "11111111-1111-4111-8111-111111111111",
	};
	const token = "t".repeat(43),
		common = `BITOVP_STORY_ENABLED=1\nBITOVP_STORY_MODEL_ID=${identity.model}\nBITOVP_STORY_CONFIG_ID=${identity.configId}\n`;
	mkdirSync(join(config.directory, "story"), { mode: 0o700 });
	writeFileSync(
		join(config.directory, "story/bridge.json"),
		JSON.stringify({
			identity,
			port: 3185,
			token,
			codexPath: "/fixture/codex",
		}),
		{ mode: 0o600 },
	);
	writeFileSync(join(config.directory, "story-web.env"), common, {
		mode: 0o600,
	});
	writeFileSync(
		join(config.directory, "story-worker.env"),
		`${common}BITOVP_STORY_MODEL_URL=http://host.docker.internal:3185/v1/story\nBITOVP_STORY_MODEL_TOKEN=${token}\n`,
		{ mode: 0o600 },
	);
}

for (const kind of ["complete", "incomplete", "malformed"]) {
	test(`withdrawn STORY configuration cannot change Compose routing: ${kind}`, (t) => {
		const config = preparePreview(fixture(t));
		staleStoryConfiguration(config);
		if (kind === "incomplete")
			rmSync(join(config.directory, "story-worker.env"));
		if (kind === "malformed")
			writeFileSync(join(config.directory, "story/bridge.json"), "not json");
		const runtimeBefore = readFileSync(join(config.directory, "runtime.env"));
		const invocation = composeInvocation(config, ["ps"], {
			PATH: "/safe/path",
			BITOVP_STORY_ENABLED: "1",
			BITOVP_STORY_MODEL_ID: "old-model",
			BITOVP_STORY_MODEL_TOKEN: "old-token",
			BITOVP_STORY_MODEL_URL: "http://host.docker.internal:3185/v1/story",
			COMPOSE_FILE: "docker-compose.story.yml",
		});
		assert.deepEqual(invocation.args.slice(7), [
			"--file",
			join(config.repository, "docker-compose.editing.yml"),
			"ps",
		]);
		assert.deepEqual(Object.keys(invocation.env).sort(), [
			"EDITING_PREVIEW_ASR_MODEL_FILE",
			"EDITING_PREVIEW_ASR_MODEL_SHA256",
			"EDITING_PREVIEW_DIRECTORY",
			"EDITING_PREVIEW_PROJECT",
			"EDITING_PREVIEW_WEB_PORT",
			"PATH",
		]);
		assert.deepEqual(
			readFileSync(join(config.directory, "runtime.env")),
			runtimeBefore,
		);
		assert.equal(preparePreview(config.repository).project, config.project);
	});
}

test("withdrawn model integration has no preview entry point or container connection", () => {
	const base = readFileSync(
		new URL("../docker-compose.editing.yml", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(
		base,
		/story-(?:worker|web)\.env|story-model|host\.docker\.internal|BITOVP_STORY/,
	);
	assert.match(base, /worker:\n {4}networks: \[default\]/);
	assert.match(base, /default:\n {4}internal: true/);
	assert.equal(
		existsSync(new URL("./story-preview.mjs", import.meta.url)),
		false,
	);
	assert.equal(
		existsSync(new URL("../docker-compose.story.yml", import.meta.url)),
		false,
	);
	const pkg = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);
	assert.equal(pkg.scripts["preview:story"], undefined);
	assert.doesNotMatch(pkg.scripts["test:editing-preview"], /story-preview/);
});

test("arguments reject extra Compose options, invalid ports, and unknown commands", () => {
	assert.deepEqual(parseArguments(["up", "--port", "3190"]), {
		command: "up",
		port: 3190,
	});
	assert.deepEqual(parseArguments(["stop"]), {
		command: "stop",
		port: undefined,
	});
	for (const args of [
		["up", "--port", "0"],
		["up", "--port", "65536"],
		["up", "--port", "3180.5"],
		["up", "--profile", "quick-tunnel"],
		["down", "--volumes"],
		["stop", "--port", "3190"],
		["oops"],
	])
		assert.throws(() => parseArguments(args));
});

test("startup builds branch images, waits for services, then seeds through the runtime role", async (t) => {
	const calls = [];
	await main(["up"], {
		repository: fixture(t),
		execute: async (invocation) => calls.push(invocation),
		verify: async () => {},
		log: () => {},
	});
	assert.deepEqual(
		calls.map((c) => c.args.slice(9)),
		[
			["build", "worker", "web", "gateway"],
			["up", "--detach", "--wait", "--wait-timeout", "180"],
			["run", "--rm", "--no-deps", "seed"],
		],
	);
});

test("host readiness probes only the fixed loopback health URL and retries transient failures", async () => {
	const requests = [];
	const waits = [];
	await verifyHostHealth(3197, {
		fetchImpl: async (url, options) => {
			requests.push(url);
			assert.ok(options.signal instanceof AbortSignal);
			if (requests.length === 1) throw new Error("connection refused");
			return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
		},
		wait: async (milliseconds) => waits.push(milliseconds),
	});
	assert.deepEqual(requests, [
		"http://127.0.0.1:3197/api/health",
		"http://127.0.0.1:3197/api/health",
	]);
	assert.deepEqual(waits, [1000]);
});

test("host readiness has a finite retry budget and rejects degraded health", async () => {
	let requests = 0;
	await assert.rejects(
		verifyHostHealth(3180, {
			fetchImpl: async () => {
				requests += 1;
				return new Response(JSON.stringify({ status: "degraded" }), {
					status: 503,
				});
			},
			wait: async () => {},
		}),
		/not reachable from this host/,
	);
	assert.equal(requests, 10);
});

test("healthy containers with an unreachable published host port never seed or report ready", async (t) => {
	const calls = [];
	const logs = [];
	await assert.rejects(
		main(["up"], {
			repository: fixture(t),
			execute: async (invocation) => calls.push(invocation),
			verify: async () => {
				throw new Error("host connection refused");
			},
			log: (value) => logs.push(value),
		}),
		/host connection refused/,
	);
	assert.equal(calls.length, 2);
	assert.ok(!calls.some((call) => call.args.includes("seed")));
	assert.ok(!logs.some((line) => line.includes("ready:")));
});

test("only a credential-free fixed gateway bridges the host to the isolated application network", () => {
	const repository = new URL("../", import.meta.url);
	const compose = readFileSync(
		new URL("docker-compose.editing.yml", repository),
		"utf8",
	);
	const service = (name) =>
		compose.match(
			new RegExp(
				`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|^networks:)`,
				"m",
			),
		)?.[1] ?? "";
	const gateway = service("gateway");
	assert.match(
		gateway,
		/127\.0\.0\.1:\$\{EDITING_PREVIEW_WEB_PORT:-3180\}:8080/,
	);
	assert.match(gateway, /networks: \[frontend, default\]/);
	assert.doesNotMatch(
		gateway,
		/env_file:|DATABASE_URL|MASTER_KEY|S3_SECRET|POSTGRES_PASSWORD/,
	);
	for (const name of [
		"web",
		"worker",
		"postgres",
		"redis",
		"storage",
		"setup",
		"report-init",
		"seed",
	]) {
		assert.doesNotMatch(service(name), /^ {4}ports:|frontend/m);
		assert.match(service(name), /networks: \[default\]/);
	}
	assert.match(
		compose,
		/networks:\n {2}default:\n {4}internal: true\n {2}frontend: \{\}/,
	);
	const nginx = readFileSync(
		new URL("docker/editing-preview-nginx.conf", repository),
		"utf8",
	);
	assert.match(nginx, /server web:3100 resolve;/);
	assert.match(nginx, /proxy_set_header Host \$http_host;/);
	assert.match(nginx, /proxy_buffering off;/);
	assert.match(nginx, /proxy_request_buffering off;/);
});

test("unhealthy startup never seeds or reports a ready URL", async (t) => {
	const calls = [];
	const logs = [];
	await assert.rejects(
		main(["up"], {
			repository: fixture(t),
			execute: async (invocation) => {
				calls.push(invocation);
				if (invocation.args.includes("up")) throw new Error("unhealthy");
			},
			log: (value) => logs.push(value),
		}),
		/unhealthy/,
	);
	assert.equal(calls.length, 2);
	assert.ok(!logs.some((line) => line.includes("http://")));
});

test("stop and down allow semantic cleanup, preserve volumes, and status does not initialize a deployment", async (t) => {
	const repository = fixture(t);
	const calls = [];
	const logs = [];
	await main(["status"], {
		repository,
		execute: async (c) => calls.push(c),
		log: (s) => logs.push(s),
	});
	assert.equal(calls.length, 0);
	assert.match(logs[0], /not initialized/i);
	preparePreview(repository);
	for (const command of ["stop", "down"]) {
		calls.length = 0;
		await main([command], {
			repository,
			execute: async (c) => calls.push(c),
			log: () => {},
		});
		assert.deepEqual(calls[0].args.slice(9), [command, "--timeout", "75"]);
		assert.ok(!calls[0].args.includes("--volumes"));
	}
});

test("ASR setup verifies the pinned public model and restarts only the worker without rotating configuration", async (t) => {
	const repository = fixture(t),
		config = preparePreview(repository),
		calls = [],
		models = [];
	const before = readFileSync(join(config.directory, "runtime.env"));
	await main(["asr"], {
		repository,
		ensureModel: async (model) => models.push(model),
		execute: async (call) => calls.push(call),
		log: () => {},
	});
	assert.equal(models.length, 2);
	assert.equal(
		models[1].sha256,
		"2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
	);
	assert.equal(
		models[1].file,
		join(config.directory, "models", "ggml-silero-v6.2.0.bin"),
	);
	assert.equal(
		models[0].sha256,
		"60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
	);
	assert.equal(
		models[0].file,
		join(config.directory, "models", "ggml-base.bin"),
	);
	assert.deepEqual(
		calls.map((call) => call.args.slice(9)),
		[["restart", "worker"]],
	);
	assert.deepEqual(readFileSync(join(config.directory, "runtime.env")), before);
});

test("ASR quality profile activates a pinned multilingual small model for both request and worker identities", async (t) => {
	const repository = fixture(t),
		config = preparePreview(repository),
		calls = [],
		models = [];
	const before = readFileSync(join(config.directory, "runtime.env"));
	await main(["asr", "--model", "small"], {
		repository,
		ensureModel: async (model) => models.push(model),
		execute: async (call) => calls.push(call),
		log: () => {},
	});
	assert.equal(models[0].size, 487601967);
	assert.equal(
		models[0].sha256,
		"1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
	);
	assert.equal(
		models[0].file,
		join(config.directory, "models", "ggml-small.bin"),
	);
	assert.deepEqual(calls[0].args.slice(9), [
		"up",
		"--detach",
		"--no-deps",
		"worker",
		"web",
	]);
	assert.equal(calls[0].env.EDITING_PREVIEW_ASR_MODEL_FILE, "ggml-small.bin");
	assert.equal(calls[0].env.EDITING_PREVIEW_ASR_MODEL_SHA256, models[0].sha256);
	assert.equal(
		composeInvocation(preparePreview(repository), ["ps"]).env
			.EDITING_PREVIEW_ASR_MODEL_SHA256,
		models[0].sha256,
	);
	assert.deepEqual(readFileSync(join(config.directory, "runtime.env")), before);
	await main(["asr", "--model", "base"], {
		repository,
		ensureModel: async () => {},
		execute: async () => {},
		log: () => {},
	});
	assert.equal(
		composeInvocation(config, ["ps"]).env.EDITING_PREVIEW_ASR_MODEL_FILE,
		"ggml-base.bin",
	);
});

test("ASR turbo evaluation selects its own fixed file and identical web/worker digest without replacing small", async (t) => {
	const repository = fixture(t),
		config = preparePreview(repository),
		calls = [],
		models = [];
	await main(["asr", "--model", "small"], {
		repository,
		ensureModel: async () => {},
		execute: async () => {},
		log: () => {},
	});
	const small = join(config.directory, "models", "ggml-small.bin");
	mkdirSync(join(config.directory, "models"), { recursive: true });
	writeFileSync(small, "existing small model", { mode: 0o444 });
	await main(["asr", "--model", "large-v3-turbo-q5_0"], {
		repository,
		ensureModel: async (model) => models.push(model),
		execute: async (call) => calls.push(call),
		log: () => {},
	});
	assert.equal(models[0].size, 574041195);
	assert.equal(
		models[0].file,
		join(config.directory, "models", "ggml-large-v3-turbo-q5_0.bin"),
	);
	assert.equal(
		models[0].sha256,
		"394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
	);
	assert.deepEqual(calls[0].args.slice(9), [
		"up",
		"--detach",
		"--no-deps",
		"worker",
		"web",
	]);
	assert.equal(
		calls[0].env.EDITING_PREVIEW_ASR_MODEL_FILE,
		"ggml-large-v3-turbo-q5_0.bin",
	);
	assert.equal(calls[0].env.EDITING_PREVIEW_ASR_MODEL_SHA256, models[0].sha256);
	assert.equal(
		composeInvocation(config, ["ps"]).env.EDITING_PREVIEW_ASR_MODEL_SHA256,
		models[0].sha256,
	);
	assert.equal(readFileSync(small, "utf8"), "existing small model");
});

test("ASR model provisioning failure preserves the active profile and starts no containers", async (t) => {
	const repository = fixture(t),
		config = preparePreview(repository),
		calls = [];
	await assert.rejects(
		main(["asr", "--model", "small"], {
			repository,
			ensureModel: async () => {
				throw new Error("download failed");
			},
			execute: async (call) => calls.push(call),
			log: () => {},
		}),
		/download failed/,
	);
	assert.equal(calls.length, 0);
	assert.equal(
		composeInvocation(config, ["ps"]).env.EDITING_PREVIEW_ASR_MODEL_FILE,
		"ggml-base.bin",
	);
	assert.equal(existsSync(join(config.directory, "asr-model.json")), false);
});

test("VAD verification failure does not activate a new ASR profile or restart containers", async (t) => {
	const repository = fixture(t),
		config = preparePreview(repository),
		calls = [];
	let models = 0;
	await assert.rejects(
		main(["asr", "--model", "small"], {
			repository,
			ensureModel: async () => {
				if (++models === 2) throw new Error("VAD verification failed");
			},
			execute: async (call) => calls.push(call),
			log: () => {},
		}),
		/VAD verification failed/,
	);
	assert.equal(models, 2);
	assert.equal(calls.length, 0);
	assert.equal(existsSync(join(config.directory, "asr-model.json")), false);
	assert.equal(
		composeInvocation(config, ["ps"]).env.EDITING_PREVIEW_ASR_MODEL_FILE,
		"ggml-base.bin",
	);
});

test("ASR profile rejects arbitrary model names, inherited overrides and corrupt selection files", (t) => {
	for (const args of [
		["asr", "--model", "../model"],
		["asr", "--model", "small", "--model", "base"],
		["up", "--model", "small"],
	])
		assert.throws(() => parseArguments(args));
	assert.equal(
		parseArguments(["asr", "--model", "small", "--local-llm"]).localLlm,
		true,
	);
	const config = preparePreview(fixture(t));
	const invocation = composeInvocation(config, ["ps"], {
		EDITING_PREVIEW_ASR_MODEL_FILE: "evil.bin",
		EDITING_PREVIEW_ASR_MODEL_SHA256: "e".repeat(64),
	});
	assert.equal(invocation.env.EDITING_PREVIEW_ASR_MODEL_FILE, "ggml-base.bin");
	writeFileSync(
		join(config.directory, "asr-model.json"),
		JSON.stringify({ version: 1, model: "../evil" }),
		{ mode: 0o600 },
	);
	assert.throws(() => composeInvocation(config, ["ps"]), /ASR profile/i);
});

test("dialogue demo mounts only its verified public fixture read-only and leaves existing seed data separate", async (t) => {
	const repository = fixture(t),
		calls = [];
	preparePreview(repository);
	await main(["dialogue"], {
		repository,
		verify: async () => {},
		prepareDialogue: () => "/public/sintel.mp4",
		execute: async (call) => calls.push(call),
		log: () => {},
	});
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].args.slice(9), [
		"run",
		"--rm",
		"--no-deps",
		"--volume",
		"/public/sintel.mp4:/fixtures/sintel-dialogue-cfr30.mp4:ro",
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
});

test("dialogue fixture identity is verified and corrupt public files are never accepted", (t) => {
	const repository = fixture(t),
		dir = join(repository, "apps/worker/src/library-editing/fixtures");
	mkdirSync(dir, { recursive: true });
	const target = join(dir, "sintel-dialogue-cfr30.mp4"),
		original = readFileSync(
			new URL(
				"../apps/worker/src/library-editing/fixtures/sintel-dialogue-cfr30.mp4",
				import.meta.url,
			),
		);
	writeFileSync(target, original);
	assert.equal(prepareDialogue({ repository }), target);
	const changed = Buffer.from(original);
	changed[128] ^= 1;
	writeFileSync(target, changed);
	assert.throws(() => prepareDialogue({ repository }), /verification failed/);
	assert.deepEqual(readFileSync(target), changed);
});

function localSemanticFixture(config, changes = {}) {
	const token = "test-local-semantic-token-".repeat(3);
	const settings = {
		BITOVP_LOCAL_SEMANTIC_ENABLED: "1",
		BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "https://192.168.68.62:11437",
		BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN: token,
		BITOVP_LOCAL_SEMANTIC_CA_FILE: "/run/bitovp-local-semantic/gateway-ca.pem",
		BITOVP_LOCAL_SEMANTIC_PROFILE: "nvidia",
		BITOVP_LOCAL_SEMANTIC_CONFIG_ID: "11111111-1111-4111-8111-111111111111",
		...changes,
	};
	writeFileSync(
		join(config.directory, "local-semantic.env"),
		`${Object.entries(settings)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n")}\n`,
		{ mode: 0o600 },
	);
	writeFileSync(join(config.directory, "gateway-ca.pem"), rootCertificates[0], {
		mode: 0o644,
	});
	return token;
}

test("selected Plamo metadata is verified before mounting it into web and worker", (t) => {
	const repository = fixture(t),
		config = { ...preparePreview(repository), localLlm: true };
	localSemanticFixture(config, {
		BITOVP_LOCAL_CAPTION_PROVIDER: "PLAMO",
		BITOVP_LOCAL_CAPTION_MANIFEST_FILE:
			"/run/bitovp-local-semantic/local-caption-manifest.json",
	});
	const manifest = join(config.directory, "local-caption-manifest.json");
	writeFileSync(manifest, '{"fixture":"metadata-only"}', { mode: 0o600 });
	let checks = 0;
	const call = composeInvocation(
		config,
		["up"],
		process.env,
		(selected, values, filename) => {
			checks++;
			assert.equal(selected, config);
			assert.equal(values.BITOVP_LOCAL_CAPTION_PROVIDER, "PLAMO");
			assert.equal(filename, manifest);
		},
	);
	assert.equal(checks, 1);
	assert.ok(
		call.args.includes(
			join(config.repository, "docker-compose.editing-plamo.yml"),
		),
	);
	assert.equal(call.env.BITOVP_LOCAL_CAPTION_PROVIDER, undefined);
	assert.equal(statSync(manifest).mode & 0o777, 0o600);
});

test("Plamo preflight failure preserves private configuration and hides its diagnostics", (t) => {
	const repository = fixture(t),
		config = { ...preparePreview(repository), localLlm: true };
	const token = localSemanticFixture(config, {
		BITOVP_LOCAL_CAPTION_PROVIDER: "PLAMO",
		BITOVP_LOCAL_CAPTION_MANIFEST_FILE:
			"/run/bitovp-local-semantic/local-caption-manifest.json",
	});
	const manifest = join(config.directory, "local-caption-manifest.json"),
		envFile = join(config.directory, "local-semantic.env");
	writeFileSync(manifest, '{"fixture":"invalid"}', { mode: 0o600 });
	const before = readFileSync(envFile);
	let called = false;
	assert.throws(
		() =>
			composeInvocation(config, ["up"], process.env, () => {
				called = true;
				throw new Error(token);
			}),
		(error) =>
			!error.message.includes(token) &&
			/Existing settings were preserved/.test(error.message),
	);
	assert.equal(called, true);
	assert.deepEqual(readFileSync(envFile), before);
});

test("Plamo refuses unsafe metadata and arbitrary manifest mounts before invoking a validator", (t) => {
	for (const variant of ["missing", "symlink", "permissions", "size", "path"]) {
		const repository = fixture(t),
			config = { ...preparePreview(repository), localLlm: true };
		localSemanticFixture(config, {
			BITOVP_LOCAL_CAPTION_PROVIDER: "PLAMO",
			BITOVP_LOCAL_CAPTION_MANIFEST_FILE:
				variant === "path"
					? "/arbitrary/manifest.json"
					: "/run/bitovp-local-semantic/local-caption-manifest.json",
		});
		const file = join(config.directory, "local-caption-manifest.json");
		if (variant === "symlink")
			symlinkSync(join(config.directory, "local-semantic.env"), file);
		else if (variant !== "missing")
			writeFileSync(file, variant === "size" ? "x".repeat(16385) : "{}", {
				mode: variant === "permissions" ? 0o644 : 0o600,
			});
		let called = false;
		assert.throws(() =>
			composeInvocation(config, ["up"], process.env, () => {
				called = true;
			}),
		);
		assert.equal(called, false);
	}
});

test("explicit Qwen needs no metadata mount or model preflight", (t) => {
	const config = { ...preparePreview(fixture(t)), localLlm: true };
	localSemanticFixture(config, { BITOVP_LOCAL_CAPTION_PROVIDER: "QWEN" });
	const call = composeInvocation(config, ["up"], process.env, () => {
		assert.fail("Qwen must not invoke Plamo preflight");
	});
	assert.ok(!call.args.some((x) => x.includes("editing-plamo")));
});

test("local LLM routing requires an explicit startup flag and never inherits shell configuration", (t) => {
	const config = preparePreview(fixture(t));
	const token = localSemanticFixture(config);
	assert.deepEqual(parseArguments(["up", "--local-llm", "--port", "3190"]), {
		command: "up",
		port: 3190,
		localLlm: true,
	});
	assert.deepEqual(parseArguments(["build", "--local-llm"]), {
		command: "build",
		port: undefined,
		localLlm: true,
	});
	for (const args of [
		["up", "--local-llm", "--local-llm"],
		["status", "--local-llm"],
		["up", "--port", "3180", "--port", "3190"],
	])
		assert.throws(() => parseArguments(args));
	const defaultCall = composeInvocation(config, ["ps"], {
		PATH: "/safe/path",
		BITOVP_LOCAL_SEMANTIC_ENABLED: "1",
		BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN: token,
	});
	assert.ok(!defaultCall.args.some((arg) => arg.includes("editing-local-llm")));
	assert.equal(defaultCall.env.BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN, undefined);
	const enabled = composeInvocation({ ...config, localLlm: true }, ["build"]);
	assert.deepEqual(enabled.args.slice(7), [
		"--file",
		join(config.repository, "docker-compose.editing.yml"),
		"--file",
		join(config.repository, "docker-compose.editing-local-llm.yml"),
		"build",
	]);
	assert.ok(!JSON.stringify(enabled).includes(token));
});

test("local LLM startup rejects incomplete, unsafe or unrelated settings without rotating preview credentials", (t) => {
	for (const kind of [
		"missing",
		"unsafe-env",
		"wrong-url",
		"wrong-profile",
		"extra-db",
		"duplicate-key",
		"symlink-ca",
		"corrupt-ca",
	]) {
		const config = preparePreview(fixture(t));
		const original = readFileSync(join(config.directory, "runtime.env"));
		if (kind !== "missing")
			localSemanticFixture(
				config,
				kind === "wrong-url"
					? { BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "http://untrusted.example/" }
					: kind === "wrong-profile"
						? { BITOVP_LOCAL_SEMANTIC_PROFILE: "cloud" }
						: kind === "extra-db"
							? { DATABASE_URL: "postgresql://unrelated" }
							: {},
			);
		if (kind === "unsafe-env")
			chmodSync(join(config.directory, "local-semantic.env"), 0o644);
		if (kind === "duplicate-key")
			writeFileSync(
				join(config.directory, "local-semantic.env"),
				`${readFileSync(join(config.directory, "local-semantic.env"), "utf8")}BITOVP_LOCAL_SEMANTIC_PROFILE=amd\n`,
			);
		if (kind === "symlink-ca") {
			rmSync(join(config.directory, "gateway-ca.pem"));
			symlinkSync(
				join(config.directory, "runtime.env"),
				join(config.directory, "gateway-ca.pem"),
			);
		}
		if (kind === "corrupt-ca")
			writeFileSync(
				join(config.directory, "gateway-ca.pem"),
				"not a certificate",
			);
		assert.throws(
			() => composeInvocation({ ...config, localLlm: true }, ["build"]),
			/local semantic preview/i,
		);
		assert.deepEqual(
			readFileSync(join(config.directory, "runtime.env")),
			original,
		);
	}
});

test("local LLM startup supplies an overlay only for the requested invocation and preserves v1 state", async (t) => {
	const config = preparePreview(fixture(t));
	const token = localSemanticFixture(config),
		before = readFileSync(join(config.directory, "state.json")),
		calls = [],
		logs = [];
	await main(["up", "--local-llm"], {
		repository: config.repository,
		execute: async (call) => calls.push(call),
		verify: async () => {},
		log: (line) => logs.push(line),
	});
	assert.equal(calls.length, 3);
	assert.ok(
		calls.every((call) =>
			call.args.includes(
				join(config.repository, "docker-compose.editing-local-llm.yml"),
			),
		),
	);
	assert.ok(!JSON.stringify({ calls, logs }).includes(token));
	assert.deepEqual(readFileSync(join(config.directory, "state.json")), before);
	assert.ok(
		!composeInvocation(preparePreview(config.repository), ["ps"]).args.some(
			(arg) => arg.includes("editing-local-llm"),
		),
	);
});

test("local LLM overlay gives only the worker explicit egress and passes fixed private settings to servers", () => {
	const overlay = readFileSync(
		new URL("../docker-compose.editing-local-llm.yml", import.meta.url),
		"utf8",
	);
	const { parse } = createRequire(
		new URL("../packages/core/package.json", import.meta.url),
	)("yaml");
	const config = parse(overlay);
	assert.deepEqual(config.services.worker.networks, ["default", "semantic"]);
	assert.equal(config.services.worker.stop_grace_period, "75s");
	assert.equal(config.services.web.networks, undefined);
	assert.equal(config.services.web.env_file.length, 1);
	assert.doesNotMatch(
		overlay,
		/web:\n {4}networks:|ports:|host\.docker\.internal|BITOVP_STORY/,
	);
	assert.equal((overlay.match(/local-semantic\.env/g) ?? []).length, 2);
	assert.equal((overlay.match(/read_only: true/g) ?? []).length, 2);
	assert.equal((overlay.match(/create_host_path: false/g) ?? []).length, 2);
	assert.match(overlay, /networks:\n {2}semantic: \{\}/);
});
