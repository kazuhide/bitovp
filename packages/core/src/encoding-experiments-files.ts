import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
	experimentSourceId,
	experimentSourceSchema,
	experimentWorkerHealthSchema,
} from "./encoding-experiments";

export const experimentHealthWindowMs = 90_000;
export const experimentCapabilityByteLimit = 1024 * 1024;
const registrationByteLimit = 8_192;
const organizationSchema = z.uuid();

export function getExperimentRoot(): string | null {
	const path = process.env.BITOVP_EXPERIMENTS_ROOT;
	return path && isAbsolute(path) ? path : null;
}

export function experimentRegistrationDirectory(
	root: string,
	organizationId: string,
) {
	return join(root, "sources", organizationSchema.parse(organizationId));
}

export function experimentMediaPath(
	root: string,
	organizationId: string,
	sourceId: string,
) {
	return join(
		root,
		"media",
		organizationSchema.parse(organizationId),
		experimentSourceId.parse(sourceId),
	);
}

async function readRegistration(
	path: string,
	fileLimit = registrationByteLimit,
): Promise<unknown> {
	try {
		const file = await open(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size > fileLimit) return null;
			const buffer = Buffer.alloc(info.size + 1);
			const { bytesRead } = await file.read(buffer);
			if (bytesRead > fileLimit) return null;
			return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
		} finally {
			await file.close();
		}
	} catch {
		return null;
	}
}

export async function readExperimentRuntime(
	root: string,
	now = Date.now(),
	kind: "nvenc" | "software" = "nvenc",
) {
	const parsed = experimentWorkerHealthSchema.safeParse(
		await readRegistration(
			join(
				root,
				kind === "software" ? "software-runtime.json" : "runtime.json",
			),
			experimentCapabilityByteLimit,
		),
	);
	if (!parsed.success || (parsed.data.runtime.runtimeKind ?? "nvenc") !== kind)
		return null;
	const age = now - parsed.data.checkedAt;
	return age >= 0 && age < experimentHealthWindowMs
		? parsed.data.runtime
		: null;
}

export async function readExperimentSource(
	root: string,
	organizationId: string,
	sourceId: string,
) {
	if (!experimentSourceId.safeParse(sourceId).success) return null;
	const directory = experimentRegistrationDirectory(root, organizationId);
	const parsed = experimentSourceSchema.safeParse(
		await readRegistration(join(directory, `${sourceId}.json`)),
	);
	return parsed.success && parsed.data.id === sourceId ? parsed.data : null;
}

export async function readExperimentSources(
	root: string,
	organizationId: string,
) {
	const directory = experimentRegistrationDirectory(root, organizationId);
	const files = await readdir(directory, { withFileTypes: true }).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		},
	);
	const sources: z.infer<typeof experimentSourceSchema>[] = [];
	for (const file of files) {
		if (!file.isFile() || !file.name.endsWith(".json")) continue;
		const source = await readExperimentSource(
			root,
			organizationId,
			file.name.slice(0, -5),
		);
		if (source) sources.push(source);
	}
	return sources.sort((a, b) => a.id.localeCompare(b.id));
}

export async function hashExperimentMedia(path: string): Promise<string> {
	const hash = createHash("sha256");
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		if (!(await file.stat()).isFile())
			throw new Error("Experiment media is not a regular file");
		for await (const chunk of file.createReadStream({ autoClose: false }))
			hash.update(chunk);
		return hash.digest("hex");
	} finally {
		await file.close();
	}
}
