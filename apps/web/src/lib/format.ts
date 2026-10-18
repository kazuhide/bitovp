const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(size: number): string {
	if (!Number.isFinite(size) || size < 0) {
		return "—";
	}
	let value = size;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`;
}

export function formatDateTime(iso: string | undefined): string {
	if (!iso) {
		return "—";
	}
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

/**
 * Humanizes an elapsed/run duration between two ISO timestamps as the two
 * most significant units (e.g. "1h 20m", "45s"). For a terminal job that is
 * the run time (updatedAt − createdAt); for an active job it is elapsed.
 */
export function formatDuration(fromIso: string, toIso: string): string {
	const from = new Date(fromIso).getTime();
	const to = new Date(toIso).getTime();
	if (Number.isNaN(from) || Number.isNaN(to)) {
		return "—";
	}
	return formatDurationMs(to - from);
}

/**
 * The same humanization from a raw millisecond span — for callers that
 * already hold epoch numbers (the live list's elapsed/remaining and schedule
 * countdowns compare a server-anchored clock, not two ISO strings, and
 * round-tripping through `toISOString` just to come back here would be a
 * second place for the format to drift).
 *
 * A NEGATIVE span stays "—" exactly as it did when this was inline: a
 * duration that ran backwards is not a duration, and the callers that mean
 * "overdue" say so with their own words rather than a negative clock.
 */
export function formatDurationMs(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) {
		return "—";
	}
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) {
		return `${h}h ${m}m`;
	}
	if (m > 0) {
		return `${m}m ${s}s`;
	}
	return `${s}s`;
}

/** "videos/raw/" → ["videos/", "videos/raw/"] for breadcrumb navigation. */
export function prefixCrumbs(prefix: string): string[] {
	const crumbs: string[] = [];
	let acc = "";
	for (const segment of prefix.split("/").filter(Boolean)) {
		acc += `${segment}/`;
		crumbs.push(acc);
	}
	return crumbs;
}

export function baseName(path: string): string {
	const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
	const idx = trimmed.lastIndexOf("/");
	return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}
