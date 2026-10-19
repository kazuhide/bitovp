import { describe, expect, it } from "vitest";
import { type ResourceSources, readLocalResources } from "./resources";

const GiB = 1024 ** 3;
function sources(
	files: Record<string, string | undefined> = {},
): ResourceSources {
	return {
		parallelism: () => 10,
		constrainedMemory: () => 4 * GiB,
		availableMemory: () => 3.5 * GiB,
		totalMemory: () => 8 * GiB,
		readFile: (path) => {
			const fixed: Record<string, string> = {
				"/proc/self/cgroup": "0::/",
				"/proc/self/mountinfo":
					"12 1 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
			};
			const value = files[path] ?? fixed[path];
			if (value === undefined) throw new Error("not available");
			return value;
		},
	};
}

describe("local quality resource snapshot", () => {
	it.each([
		0.5, 1, 4,
	])("retains a fractional or integer CPU quota of %s", (quota) => {
		const value = readLocalResources(
			sources({ "/sys/fs/cgroup/cpu.max": `${quota * 100000} 100000` }),
		);
		expect(value.cpuCapacity).toBe(quota);
	});

	it("uses the tightest ancestor quota, affinity and memory headroom", () => {
		const value = readLocalResources(
			sources({
				"/proc/self/cgroup": "0::/worker/child",
				"/sys/fs/cgroup/worker/child/cpu.max": "400000 100000",
				"/sys/fs/cgroup/worker/cpu.max": "200000 100000",
				"/sys/fs/cgroup/cpu.max": "max 100000",
				"/sys/fs/cgroup/worker/child/cpuset.cpus.effective": "0-3,2-4",
				"/sys/fs/cgroup/worker/child/memory.max": String(4 * GiB),
				"/sys/fs/cgroup/worker/child/memory.current": String(0.5 * GiB),
				"/sys/fs/cgroup/worker/memory.high": String(2 * GiB),
				"/sys/fs/cgroup/worker/memory.current": String(1.5 * GiB),
			}),
		);
		expect(value.cpuCapacity).toBe(2);
		expect(value.memoryLimitBytes).toBe(2 * GiB);
		expect(value.headroomBytes).toBe(0.5 * GiB);
		expect(value.reserveBytes).toBe(0.5 * GiB);
		expect(value.budgetBytes).toBe(0);
	});

	it("does not confuse an unlimited cgroup with missing Node memory information", () => {
		const known = readLocalResources(
			sources({ "/sys/fs/cgroup/memory.max": "max" }),
		);
		expect(known.memoryLimitBytes).toBe(4 * GiB);
		expect(known.headroomBytes).toBe(3.5 * GiB);
		expect(known.budgetBytes).toBe(3 * GiB);
		const unknown = sources();
		unknown.availableMemory = () => undefined;
		unknown.constrainedMemory = () => 0;
		unknown.totalMemory = () => undefined;
		expect(readLocalResources(unknown).budgetBytes).toBeUndefined();
	});

	it("preserves zero real headroom rather than treating it as unknown", () => {
		const input = sources();
		input.availableMemory = () => 0;
		expect(readLocalResources(input).budgetBytes).toBe(0);
	});

	it("falls back conservatively when platform files and CPU information fail", () => {
		const input = sources();
		input.parallelism = () => {
			throw new Error("unsupported");
		};
		input.readFile = () => {
			throw new Error("unsupported");
		};
		const value = readLocalResources(input);
		expect(value.cpuCapacity).toBe(1);
		expect(value.headroomBytes).toBe(3.5 * GiB);
	});

	it("ignores malformed limits and never follows a traversal outside the mount", () => {
		const input = sources({
			"/proc/self/cgroup": "0::/../../outside",
			"/sys/fs/cgroup/cpu.max": "1000 0",
		});
		const read = input.readFile;
		const paths: string[] = [];
		input.readFile = (path) => {
			paths.push(path);
			return read(path);
		};
		const value = readLocalResources(input);
		expect(value.cpuCapacity).toBe(10);
		expect(paths.every((path) => !path.includes("outside"))).toBe(true);
	});

	it("uses ancestor headroom even when Node availableMemory cannot be read", () => {
		const input = sources({
			"/sys/fs/cgroup/memory.max": String(2 * GiB),
			"/sys/fs/cgroup/memory.current": String(0.25 * GiB),
		});
		input.availableMemory = () => undefined;
		const value = readLocalResources(input);
		expect(value.headroomBytes).toBe(1.75 * GiB);
		expect(value.budgetBytes).toBe(1.25 * GiB);
	});

	it.each([
		{ "/proc/self/cgroup": "2:cpu:/worker" },
		{ "/proc/self/mountinfo": "12 1 0:1 / /sys rw - tmpfs tmpfs rw" },
	])("falls back when unified cgroup discovery is unsupported", (files) => {
		expect(readLocalResources(sources(files)).cpuCapacity).toBe(10);
	});

	it("never reports more headroom than a known memory limit", () => {
		const input = sources();
		input.availableMemory = () => 6 * GiB;
		expect(readLocalResources(input).headroomBytes).toBe(4 * GiB);
	});
});

const stat = (changes: Record<string, number | string> = {}) =>
	Object.entries({
		file: 1.5 * GiB,
		inactive_file: 1.5 * GiB,
		shmem: 0,
		file_mapped: 0,
		file_dirty: 0,
		file_writeback: 0,
		unevictable: 0,
		...changes,
	})
		.map(([key, value]) => `${key} ${value}`)
		.join("\n");
function cached(overrides: Record<string, string | undefined> = {}) {
	const input = sources({
		"/proc/meminfo": `MemTotal: ${(8 * GiB) / 1024} kB\nMemAvailable: ${(4 * GiB) / 1024} kB`,
		"/sys/fs/cgroup/memory.max": String(2 * GiB),
		"/sys/fs/cgroup/memory.high": "max",
		"/sys/fs/cgroup/memory.current": String(2 * GiB),
		"/sys/fs/cgroup/memory.stat": stat(),
		...overrides,
	});
	input.constrainedMemory = () => 2 * GiB;
	input.availableMemory = () => 0;
	return input;
}

describe("Linux reclaimable file cache", () => {
	it("allows a bounded working set after clean file cache fills the container", () => {
		const value = readLocalResources(cached());
		expect(value.headroomBytes).toBe(1.5 * GiB);
		expect(value.budgetBytes).toBe(GiB);
		expect(value.memoryLimitBytes).toBe(2 * GiB);
	});
	it.each([
		"shmem",
		"file_mapped",
		"file_dirty",
		"file_writeback",
		"unevictable",
	])("deducts all %s pages from inactive cache credit", (key) => {
		expect(
			readLocalResources(
				cached({ "/sys/fs/cgroup/memory.stat": stat({ [key]: 0.25 * GiB }) }),
			).headroomBytes,
		).toBe(1.25 * GiB);
		expect(
			readLocalResources(
				cached({ "/sys/fs/cgroup/memory.stat": stat({ [key]: 1.5 * GiB }) }),
			).headroomBytes,
		).toBe(0);
	});
	it("never credits active file pages and caps inactive credit to file/current/limit", () => {
		expect(
			readLocalResources(
				cached({
					"/sys/fs/cgroup/memory.stat": stat({
						inactive_file: 0,
						active_file: 1.5 * GiB,
					}),
				}),
			).headroomBytes,
		).toBe(0);
		expect(
			readLocalResources(
				cached({ "/sys/fs/cgroup/memory.stat": stat({ file: 0.5 * GiB }) }),
			).headroomBytes,
		).toBe(0.5 * GiB);
		expect(
			readLocalResources(
				cached({
					"/sys/fs/cgroup/memory.stat": stat({
						inactive_file: 4 * GiB,
						file: 4 * GiB,
					}),
				}),
			).headroomBytes,
		).toBe(2 * GiB);
	});
	it.each([
		`${stat()}\nfile 1`,
		stat({ file_dirty: "NaN" }),
		stat({ file_dirty: -1 }),
		stat({ file_dirty: 1.5 }),
		stat().replace("unevictable 0", ""),
	])("keeps raw headroom when cache statistics are invalid or incomplete", (invalid) => {
		expect(
			readLocalResources(cached({ "/sys/fs/cgroup/memory.stat": invalid }))
				.headroomBytes,
		).toBe(0);
	});
	it.each([
		"",
		"MemTotal: 8388608 kB\nMemAvailable: unknown kB",
		"MemTotal: 8388608 kB\nMemAvailable: 4194304 kB\nMemAvailable: 4194304 kB",
	])("does not drop Node's raw bound without a validated host cap", (host) => {
		expect(
			readLocalResources(cached({ "/proc/meminfo": host })).headroomBytes,
		).toBe(0);
	});
	it("rejects a host sample whose available memory exceeds its total", () => {
		const input = cached({
			"/proc/meminfo": "MemTotal: 8388608 kB\nMemAvailable: 16777216 kB",
		});
		const result = readLocalResources(input);
		expect(result.memoryLimitBytes).toBe(2 * GiB);
		expect(result.headroomBytes).toBe(0);
		expect(result.budgetBytes).toBe(0);
	});
	it("retains the host pressure cap even when cache credit is unavailable", () => {
		const input = cached({
			"/proc/meminfo": "MemTotal: 8388608 kB\nMemAvailable: 262144 kB",
			"/sys/fs/cgroup/memory.current": String(GiB),
			"/sys/fs/cgroup/memory.stat": "file 0",
		});
		input.availableMemory = () => GiB;
		expect(readLocalResources(input).headroomBytes).toBe(0.25 * GiB);
	});
	it("retains an unexplained stricter Node available or constrained bound", () => {
		const input = cached({
			"/sys/fs/cgroup/memory.current": String(1.5 * GiB),
		});
		input.availableMemory = () => 0.25 * GiB;
		expect(readLocalResources(input).headroomBytes).toBe(0.25 * GiB);
		const constrained = cached();
		constrained.constrainedMemory = () => GiB;
		expect(readLocalResources(constrained).headroomBytes).toBe(0);
	});
	it.each([
		{ "/sys/fs/cgroup/memory.high": "unknown" },
		{ "/sys/fs/cgroup/memory.high": "" },
		{ "/sys/fs/cgroup/memory.current": "unknown" },
	])("does not credit an unknown constraint or unreadable finite current", (files) => {
		expect(readLocalResources(cached(files)).headroomBytes).toBe(0);
	});
	it.each([
		undefined,
		"unknown",
	])("retains raw bounds when an intermediate ancestor constraint is unreadable (%s)", (raw) => {
		const input = cached({
			"/proc/self/cgroup": "0::/parent/child",
			"/sys/fs/cgroup/parent/memory.max": raw,
			"/sys/fs/cgroup/parent/memory.high": "max",
			"/sys/fs/cgroup/parent/child/memory.max": String(2 * GiB),
			"/sys/fs/cgroup/parent/child/memory.high": "max",
			"/sys/fs/cgroup/parent/child/memory.current": String(2 * GiB),
			"/sys/fs/cgroup/parent/child/memory.stat": stat(),
		});
		expect(readLocalResources(input).headroomBytes).toBe(0);
	});
	it.each([
		63, 64, 65,
	])("walks every validated ancestor before crediting cache (%s)", (depth) => {
		const segments = Array.from(
			{ length: depth },
			(_, index) => `group${index}`,
		);
		const group = `/${segments.join("/")}`;
		const files: Record<string, string> = {
			"/proc/self/cgroup": `0::${group}`,
		};
		for (let count = 0; count <= depth; count++) {
			const directory = `/sys/fs/cgroup${count ? `/${segments.slice(0, count).join("/")}` : ""}`;
			files[`${directory}/memory.max`] = "max";
			files[`${directory}/memory.high`] = "max";
		}
		const leaf = `/sys/fs/cgroup${group}`;
		files[`${leaf}/memory.max`] = String(2 * GiB);
		files[`${leaf}/memory.current`] = String(2 * GiB);
		files[`${leaf}/memory.stat`] = stat();
		const result = readLocalResources(cached(files));
		expect(result.memoryLimitBytes).toBe(2 * GiB);
		expect(result.headroomBytes).toBe(1.5 * GiB);
	});
	it.each([
		"CPU",
		"memory",
	])("retains tighter %s bounds more than sixty-four ancestors above the leaf", (kind) => {
		const segments = Array.from({ length: 70 }, (_, index) => `group${index}`);
		const group = `/${segments.join("/")}`;
		const files: Record<string, string> = {
			"/proc/self/cgroup": `0::${group}`,
		};
		for (let count = 0; count <= segments.length; count++) {
			const directory = `/sys/fs/cgroup${count ? `/${segments.slice(0, count).join("/")}` : ""}`;
			files[`${directory}/memory.max`] = "max";
			files[`${directory}/memory.high`] = "max";
		}
		const leaf = `/sys/fs/cgroup${group}`;
		files[`${leaf}/cpu.max`] = "400000 100000";
		files[`${leaf}/memory.max`] = String(2 * GiB);
		files[`${leaf}/memory.current`] = String(0.25 * GiB);
		const ancestor = `/sys/fs/cgroup/${segments[0]}`;
		files[`${ancestor}/cpu.max`] = "50000 100000";
		files[`${ancestor}/memory.max`] = String(GiB);
		files[`${ancestor}/memory.current`] = String(0.75 * GiB);
		const input = cached(files);
		input.availableMemory = () => 1.5 * GiB;
		const result = readLocalResources(input);
		if (kind === "CPU") expect(result.cpuCapacity).toBe(0.5);
		else {
			expect(result.memoryLimitBytes).toBe(GiB);
			expect(result.headroomBytes).toBe(0.25 * GiB);
			expect(result.budgetBytes).toBe(0);
		}
	});
	it("reaches a validated mount point with a trailing slash", () => {
		const input = cached({
			"/proc/self/cgroup": "0::/child",
			"/proc/self/mountinfo":
				"12 1 0:1 / /sys/fs/cgroup/ rw - cgroup2 cgroup rw",
			"/sys/fs/cgroup/child/memory.max": "max",
			"/sys/fs/cgroup/child/memory.high": "max",
		});
		expect(readLocalResources(input).headroomBytes).toBe(1.5 * GiB);
	});
	it("does not hide an unreadable current value of a finite ancestor", () => {
		const input = cached({
			"/proc/self/cgroup": "0::/parent",
			"/sys/fs/cgroup/parent/memory.max": String(2 * GiB),
			"/sys/fs/cgroup/parent/memory.high": "max",
			"/sys/fs/cgroup/parent/memory.current": "unknown",
		});
		expect(readLocalResources(input).headroomBytes).toBe(0);
	});
	it("does not erase a temporary over-limit amount when estimating reclaimable headroom", () => {
		expect(
			readLocalResources(
				cached({ "/sys/fs/cgroup/memory.current": String(2.25 * GiB) }),
			).headroomBytes,
		).toBe(1.25 * GiB);
	});
	it("keeps each ancestor's sibling and mapped usage in its own bound", () => {
		const input = cached({
			"/proc/self/cgroup": "0::/parent/child",
			"/sys/fs/cgroup/memory.max": "max",
			"/sys/fs/cgroup/memory.high": "max",
			"/sys/fs/cgroup/parent/memory.max": String(2 * GiB),
			"/sys/fs/cgroup/parent/memory.high": "max",
			"/sys/fs/cgroup/parent/memory.current": String(1.75 * GiB),
			"/sys/fs/cgroup/parent/memory.stat": stat({
				file: GiB,
				inactive_file: GiB,
				file_mapped: 0.75 * GiB,
			}),
			"/sys/fs/cgroup/parent/child/memory.max": String(4 * GiB),
			"/sys/fs/cgroup/parent/child/memory.high": "max",
			"/sys/fs/cgroup/parent/child/memory.current": String(1.5 * GiB),
			"/sys/fs/cgroup/parent/child/memory.stat": stat({
				file: GiB,
				inactive_file: GiB,
			}),
		});
		input.constrainedMemory = () => 4 * GiB;
		input.availableMemory = () => 2.5 * GiB;
		expect(readLocalResources(input).headroomBytes).toBe(0.5 * GiB);
		const read = input.readFile;
		input.readFile = (path) =>
			path === "/sys/fs/cgroup/parent/memory.stat" ? "file 0" : read(path);
		expect(readLocalResources(input).headroomBytes).toBe(0.25 * GiB);
	});
});
