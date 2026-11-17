export type InstalledRow = { height: number; bitrate: number };
export type InstalledWizardOracle = {
	rows: InstalledRow[];
	counts: Record<"edit" | "select" | "add" | "remove" | "revisit", number>;
	selected: number | null;
	fault: boolean;
	faults: number;
	tripwire: string;
	guarded: { mutation: boolean; external: boolean } | null;
};

// These inputs are independent of the application's key derivation and plan builder.
export const installedRows: InstalledRow[] = [
	{ height: 360, bitrate: 500_000 },
	{ height: 720, bitrate: 1_500_000 },
	{ height: 1080, bitrate: 3_000_000 },
];
