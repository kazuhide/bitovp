import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const prefix = "/api/encoding-experiments/v1";
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const cursorPattern = /^[A-Za-z0-9._:-]{1,1024}$/;
const idempotencyPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const usage = `Usage: node scripts/encoding-experiments.mjs COMMAND [CAMPAIGN_ID] [options]

Commands:
  capabilities | catalog | sources | list
  validate --file trial.json
  create --file campaign.json
  enqueue CAMPAIGN_ID --file batch.json --idempotency-key KEY
  status CAMPAIGN_ID | watch CAMPAIGN_ID | trials CAMPAIGN_ID [--cursor CURSOR]
  select CAMPAIGN_ID --file constraints.json
  pause CAMPAIGN_ID | resume CAMPAIGN_ID | seal CAMPAIGN_ID | cancel CAMPAIGN_ID
  export CAMPAIGN_ID [--cursor CURSOR] [--format json|ndjson]

Set BITOVP_EXPERIMENTS_URL and BITOVP_API_TOKEN. --url overrides the server origin.
Use a scoped encoding-experiments token. JSON is the default output.
`;

function serverOrigin(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Set BITOVP_EXPERIMENTS_URL to a valid HTTPS origin");
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
		url.username || url.password || url.pathname !== "/" || url.search || url.hash
	)
		throw new Error("Use an HTTPS origin, or HTTP on loopback for local testing");
	return url.origin;
}

async function jsonFile(path, limit) {
	const input = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await input.stat();
		if (!stat.isFile() || stat.size > limit)
			throw new Error("Input must be a JSON file within the request size limit");
		const buffer = Buffer.alloc(limit + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await input.read(buffer, offset, buffer.length - offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > limit) throw new Error("Input JSON exceeds the request size limit");
		try {
			return JSON.parse(buffer.toString("utf8", 0, offset));
		} catch {
			throw new Error("Input file is not valid JSON");
		}
	} finally {
		await input.close();
	}
}

function requestFailure(response, body) {
	const candidate = body?.details?.code ?? body?.error?.code;
	const code = typeof candidate === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(candidate)
		? candidate
		: "HTTP_ERROR";
	return Object.assign(new Error(`Request failed (HTTP ${response.status}, ${code})`), {
		status: response.status,
		code,
	});
}

function writeStdout(value) {
	return new Promise((done, fail) =>
		process.stdout.write(value, (error) => error ? fail(error) : done()),
	);
}

export async function runExperiments(args, {
	env = process.env,
	fetch = globalThis.fetch,
	write = writeStdout,
} = {}) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			help: { type: "boolean" },
			json: { type: "boolean" },
			url: { type: "string" },
			file: { type: "string" },
			"idempotency-key": { type: "string" },
			cursor: { type: "string" },
			format: { type: "string" },
		},
	});
	const [command, id] = positionals;
	if (values.help || command === "help") {
		await write(usage);
		return;
	}
	const indexCommands = {
		capabilities: "/capabilities",
		catalog: "/catalog",
		sources: "/sources",
		list: "/campaigns",
		validate: "/validate",
		create: "/campaigns",
	};
	const withId = ["select", "enqueue", "status", "watch", "trials", "pause", "resume", "seal", "cancel", "export"].includes(command);
	if (
		(!withId && !Object.hasOwn(indexCommands, command)) ||
		positionals.length !== (withId ? 2 : 1) ||
		(withId && !uuid.test(id))
	)
		throw new Error("Expected an experiment command and its campaign ID, if required. See --help");
	const inputSize = { validate: 8192, create: 4096, select: 8192, enqueue: 256 * 1024 };
	const hasFile = Object.hasOwn(inputSize, command);
	if (hasFile !== Boolean(values.file))
		throw new Error(hasFile ? "A JSON input file is required" : "--file is unavailable for this command");
	const key = values["idempotency-key"];
	if (command === "enqueue" ? !idempotencyPattern.test(key ?? "") : key !== undefined)
		throw new Error("Enqueue requires a stable --idempotency-key");
	if (
		values.cursor !== undefined &&
		(!["list", "trials", "export"].includes(command) || !cursorPattern.test(values.cursor))
	)
		throw new Error("Invalid cursor");
	const format = values.format ?? "json";
	if ((command !== "export" && values.format !== undefined) || !["json", "ndjson"].includes(format))
		throw new Error("Export format must be json or ndjson");

	const origin = serverOrigin(values.url ?? env.BITOVP_EXPERIMENTS_URL);
	const token = env.BITOVP_API_TOKEN;
	if (!/^boe_[A-Za-z0-9_-]{43}$/.test(token ?? ""))
		throw new Error("Set BITOVP_API_TOKEN to a scoped experiment token");
	const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
	async function request(path, { method = "GET", body, cursor } = {}) {
		const url = new URL(prefix + path, origin);
		if (cursor !== undefined) url.searchParams.set("cursor", cursor);
		const response = await fetch(url, {
			method,
			headers: {
				...headers,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
				...(key === undefined ? {} : { "Idempotency-Key": key }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(30000),
		}).catch(() => { throw new Error("Unable to reach the encoding experiment API"); });
		const data = await response.json().catch(() => null);
		if (!response.ok) throw requestFailure(response, data);
		if (data === null) throw new Error("The server did not return a JSON result");
		return data;
	}
	const writeJson = (value) => write(`${JSON.stringify(value)}\n`);
	const campaignPath = `/campaigns/${id}`;
	if (hasFile) {
		const body = await jsonFile(values.file, inputSize[command]);
		const path = command === "enqueue" ? campaignPath + "/trials"
			: command === "select" ? campaignPath + "/select"
			: indexCommands[command];
		return await writeJson(await request(path, { method: "POST", body }));
	}
	if (format === "ndjson") {
		const seen = new Set();
		let cursor = values.cursor;
		do {
			if (seen.has(cursor)) throw new Error("The export returned a repeated cursor");
			seen.add(cursor);
			const page = await request(campaignPath + "/results", { cursor });
			if (!Array.isArray(page.items) ||
				(page.nextCursor !== null && !cursorPattern.test(page.nextCursor ?? "")))
				throw new Error("The server returned an invalid export page");
			for (const item of page.items) await writeJson(item);
			cursor = page.nextCursor ?? undefined;
		} while (cursor !== undefined);
		return;
	}
	if (command === "watch") {
		for (;;) {
			const campaign = await request(campaignPath);
			await writeJson(campaign);
			const { PENDING = 0, RUNNING = 0 } = campaign.statusCounts ?? {};
			if (campaign.state === "CANCELED" || (campaign.sealed && PENDING + RUNNING === 0)) return;
			await setTimeout(2000);
		}
	}
	if (["pause", "resume", "seal"].includes(command))
		return await writeJson(await request(campaignPath, { method: "PATCH", body: { action: command } }));
	if (command === "cancel")
		return await writeJson(await request(campaignPath + "/cancel", { method: "POST" }));
	const path = command === "status" ? campaignPath
		: command === "trials" ? campaignPath + "/trials"
		: command === "export" ? campaignPath + "/results"
		: indexCommands[command];
	await writeJson(await request(path, { cursor: values.cursor }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	runExperiments(process.argv.slice(2)).catch((error) => {
		const report = { error: error.message, code: error.code ?? "COMMAND_FAILED" };
		if (error.status !== undefined) report.status = error.status;
		process.stderr.write(JSON.stringify(report) + "\n");
		process.exitCode = 1;
	});
}
