import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { posix } from "node:path";

export type ResourceSources = {
	parallelism(): number | undefined;
	constrainedMemory(): number | undefined;
	availableMemory(): number | undefined;
	totalMemory(): number | undefined;
	readFile(path: string): string;
};

export type LocalResources = {
	cpuCapacity: number;
	memoryLimitBytes?: number;
	headroomBytes?: number;
	reserveBytes: number;
	budgetBytes?: number;
};

const defaults: ResourceSources = {
	parallelism: availableParallelism,
	constrainedMemory: () => process.constrainedMemory(),
	availableMemory: () => process.availableMemory(),
	totalMemory: totalmem,
	readFile: (path) => readFileSync(path, "utf8"),
};

function value(read: () => number | undefined, allowZero = false) {
	try {
		const result = read();
		return result !== undefined &&
			Number.isFinite(result) &&
			(allowZero ? result >= 0 : result > 0)
			? result
			: undefined;
	} catch {
		return undefined;
	}
}

function cgroupPaths(read: (path: string) => string | undefined): {
	paths: string[];
	complete: boolean;
} {
	const group = read("/proc/self/cgroup")
		?.split("\n")
		.find((line) => line.startsWith("0::"))
		?.slice(3);
	const mount = read("/proc/self/mountinfo")
		?.split("\n")
		.find((line) => line.split(" - ")[1]?.startsWith("cgroup2 "))
		?.split(" - ")[0]
		?.split(" ");
	if (!group || !mount) return { paths: [], complete: false };
	const decodeMountPath = (path: string) =>
		path.replace(/\\([0-7]{3})/g, (_, octal: string) =>
			String.fromCharCode(Number.parseInt(octal, 8)),
		);
	const root = decodeMountPath(mount[3] ?? "");
	const point = decodeMountPath(mount[4] ?? "");
	const safe = (path: string) =>
		posix.isAbsolute(path) &&
		!path.includes("\0") &&
		posix.normalize(path) === path;
	if (![group, root, point].every(safe)) return { paths: [], complete: false };
	const relative = group === "/" ? "" : posix.relative(root, group);
	if (relative === ".." || relative.startsWith("../"))
		return { paths: [], complete: false };
	const mountPoint = posix.resolve(point);
	let directory = posix.join(mountPoint, relative);
	const paths: string[] = [];
	for (;;) {
		paths.push(directory);
		if (directory === mountPoint) return { paths, complete: true };
		const parent = posix.dirname(directory);
		if (parent === directory) return { paths, complete: false };
		directory = parent;
	}
}

function bytes(raw: string | undefined) {
	if (!raw || !/^\d+$/.test(raw)) return undefined;
	const result = Number(raw);
	return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function affinity(raw: string | undefined) {
	if (!raw) return undefined;
	const ranges: [number, number][] = [];
	for (const token of raw.split(",")) {
		if (!/^\d+(?:-\d+)?$/.test(token)) return undefined;
		const [start, end = start] = token.split("-").map(Number) as [
			number,
			number?,
		];
		if (!Number.isSafeInteger(end) || end < start) return undefined;
		ranges.push([start, end]);
	}
	let count = 0;
	let previous = -1;
	for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
		count += Math.max(0, end - Math.max(start, previous + 1) + 1);
		previous = Math.max(previous, end);
	}
	return count > 0 ? count : undefined;
}

function hostMemory(raw: string | undefined) {
	const values = new Map<string, number>();
	for (const line of raw?.split("\n") ?? []) {
		if (!/^Mem(?:Total|Available):/.test(line)) continue;
		const match = line.match(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/);
		if (!match || values.has(match[1] as string)) return undefined;
		const value = Number(match[2]) * 1024;
		if (!Number.isSafeInteger(value) || value < 0) return undefined;
		values.set(match[1] as string, value);
	}
	const total = values.get("MemTotal");
	const available = values.get("MemAvailable");
	if (!total || available === undefined || available > total) return undefined;
	return { total, available };
}

/** Only a lower estimate of clean, inactive disk cache is reclaimable here. */
function cleanCacheCredit(
	raw: string | undefined,
	current: number,
	limit: number,
) {
	const values = new Map<string, number>();
	for (const line of raw?.split("\n") ?? []) {
		const match = line.match(/^([a-z0-9_]+) (\d+)$/);
		if (!match || values.has(match[1] as string)) return 0;
		const amount = bytes(match[2]);
		if (amount === undefined) return 0;
		values.set(match[1] as string, amount);
	}
	const fields = [
		"inactive_file",
		"file",
		"shmem",
		"file_mapped",
		"file_dirty",
		"file_writeback",
		"unevictable",
	];
	if (fields.some((field) => !values.has(field))) return 0;
	const excluded = fields
		.slice(2)
		.reduce((sum, field) => sum + (values.get(field) as number), 0);
	if (!Number.isSafeInteger(excluded)) return 0;
	return Math.max(
		0,
		Math.min(
			values.get("inactive_file") as number,
			values.get("file") as number,
			current,
			limit,
		) - excluded,
	);
}

/** Node APIs work outside Linux; readable cgroup ancestors can tighten them. */
export function readLocalResources(sources = defaults): LocalResources {
	const read = (path: string) => {
		try {
			return sources.readFile(path).trim();
		} catch {
			return undefined;
		}
	};
	let cpuCapacity = value(sources.parallelism) ?? 1;
	const nodeLimit = value(sources.constrainedMemory);
	const total = value(sources.totalMemory);
	const host = hostMemory(read("/proc/meminfo"));
	const limits = [nodeLimit, total, host?.total].filter(
		(item): item is number => item !== undefined,
	);
	const available = value(sources.availableMemory, true);
	let headrooms: number[] = available !== undefined ? [available] : [];
	const group = cgroupPaths(read);
	const { paths } = group;
	const rawAncestorHeadrooms: number[] = [];
	const correctedHeadrooms: number[] = [];
	const cgroupLimits: number[] = [];
	let constraintsKnown = group.complete;
	let hasCacheCredit = false;
	for (const directory of paths) {
		const quota = read(posix.join(directory, "cpu.max"))?.match(
			/^(\d+)\s+(\d+)$/,
		);
		if (quota) {
			const capacity = Number(quota[1]) / Number(quota[2]);
			if (Number.isFinite(capacity) && capacity > 0)
				cpuCapacity = Math.min(cpuCapacity, capacity);
		}
		const cpus = affinity(read(posix.join(directory, "cpuset.cpus.effective")));
		if (cpus !== undefined) cpuCapacity = Math.min(cpuCapacity, cpus);
		const rawLimits = ["memory.max", "memory.high"].map((file) =>
			read(posix.join(directory, file)),
		);
		if (rawLimits.some((raw) => raw !== "max" && bytes(raw) === undefined))
			constraintsKnown = false;
		const localLimits = rawLimits
			.map(bytes)
			.filter((item): item is number => item !== undefined);
		limits.push(...localLimits);
		const current = bytes(read(posix.join(directory, "memory.current")));
		if (localLimits.length === 0) continue;
		const limit = Math.min(...localLimits);
		cgroupLimits.push(limit);
		if (current === undefined) {
			constraintsKnown = false;
			continue;
		}
		const raw = Math.max(0, limit - current);
		headrooms.push(raw);
		rawAncestorHeadrooms.push(raw);
		const credit = cleanCacheCredit(
			read(posix.join(directory, "memory.stat")),
			current,
			limit,
		);
		hasCacheCredit ||= credit > 0;
		correctedHeadrooms.push(
			Math.min(limit, Math.max(0, limit - current + credit)),
		);
	}
	if (host && headrooms.length > 0) headrooms.push(host.available);
	// Node's raw API includes file cache on Linux. Replace its bound only when
	// independently readable host/ancestor bounds explain it. An unexplained
	// stricter sample keeps the conservative path, without a sampling tolerance.
	if (
		host &&
		constraintsKnown &&
		hasCacheCredit &&
		cgroupLimits.length > 0 &&
		available !== undefined &&
		available >= Math.min(...rawAncestorHeadrooms) &&
		(nodeLimit === undefined ||
			nodeLimit >= Math.min(...cgroupLimits, total ?? Infinity, host.total))
	)
		headrooms = [host.available, ...correctedHeadrooms];
	const memoryLimitBytes = limits.length > 0 ? Math.min(...limits) : undefined;
	const headroomBytes =
		headrooms.length > 0
			? Math.min(...headrooms, memoryLimitBytes ?? Infinity)
			: undefined;
	const reserveBytes = Math.max(512 * 1024 ** 2, (memoryLimitBytes ?? 0) * 0.1);
	return {
		cpuCapacity,
		memoryLimitBytes,
		headroomBytes,
		reserveBytes,
		budgetBytes:
			headroomBytes !== undefined
				? Math.max(0, headroomBytes - reserveBytes)
				: undefined,
	};
}
