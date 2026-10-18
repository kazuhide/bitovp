import { matchesWhere, projectSelect } from "@bitovp/core/testing";
import type { AppPrismaClient } from "@bitovp/db";

type Row = Record<string, unknown>;

export function fakeDb() {
	const jobs: Row[] = [];
	const runs: Row[] = [];
	const channels: Row[] = [];
	const registrations: Row[] = [];
	const events: Row[] = [];
	const settings = new Map<string, unknown>();
	let seq = 0;
	let updateClock = Date.now();
	const updatedAt = () => new Date(++updateClock);
	// `undefined` for anything but the one relation the registrar filters on:
	// the shared reading then THROWS on a shape this double does not know.
	const rel = (row: Row, key: string): Row | null | undefined => {
		if (key === "liveChannel") {
			return channels.find((c) => c.id === row.liveChannelId) ?? null;
		}
		return undefined;
	};
	const project = (row: Row, select?: Row): Row =>
		projectSelect(row, select, rel);
	const withInclude = (row: Row, include?: Row): Row => {
		if (!include) return { ...row };
		const out: Row = { ...row };
		if (include.encodingJob) {
			const job = jobs.find((j) => j.id === row.encodingJobId) ?? null;
			out.encodingJob = job ? { status: job.status } : null;
		}
		if (include.liveChannelRun) {
			const run = runs.find((r) => r.id === row.liveChannelRunId) ?? null;
			out.liveChannelRun = run ? { status: run.status } : null;
		}
		return out;
	};
	const prisma = {
		encodingJob: {
			async findMany(args: { where?: Row; select?: Row }) {
				return jobs
					.filter((j) => matchesWhere(j, args.where, rel))
					.map((j) => project(j, args.select));
			},
		},
		liveChannelRun: {
			async findMany(args: { where?: Row; select?: Row }) {
				return runs
					.filter((r) => matchesWhere(r, args.where, rel))
					.map((r) => project(r, args.select));
			},
		},
		webhookRegistration: {
			async findMany(args: { where?: Row; include?: Row; orderBy?: unknown }) {
				return registrations
					.filter((r) => matchesWhere(r, args.where, rel))
					.map((r) => withInclude(r, args.include));
			},
			async findUnique(args: {
				where: { encodingId_kind: { encodingId: string; kind: string } };
			}) {
				const { encodingId, kind } = args.where.encodingId_kind;
				const r = registrations.find(
					(x) => x.encodingId === encodingId && x.kind === kind,
				);
				return r ? { ...r } : null;
			},
			async updateMany(args: { where?: Row; data: Row }) {
				let count = 0;
				for (const r of registrations) {
					if (matchesWhere(r, args.where, rel)) {
						Object.assign(r, args.data);
						r.updatedAt = updatedAt();
						count += 1;
					}
				}
				return { count };
			},
			async update(args: { where: { id: string }; data: Row }) {
				const r = registrations.find((x) => x.id === args.where.id);
				if (!r) throw new Error("not found");
				Object.assign(r, args.data);
				r.updatedAt = updatedAt();
				return { ...r };
			},
			async upsert(args: {
				where: { encodingId_kind: { encodingId: string; kind: string } };
				create: Row;
				update: Row;
			}) {
				const { encodingId, kind } = args.where.encodingId_kind;
				const r = registrations.find(
					(x) => x.encodingId === encodingId && x.kind === kind,
				);
				if (r) {
					Object.assign(r, args.update);
					if (Object.keys(args.update).length) r.updatedAt = updatedAt();
					return { ...r };
				}
				seq += 1;
				const created = {
					id: `reg-${seq}`,
					createdAt: new Date(),
					updatedAt: updatedAt(),
					claimedUntil: null,
					nextAttemptAt: null,
					attempts: 0,
					providerWebhookId: null,
					url: null,
					keyId: null,
					...args.create,
				};
				registrations.push(created);
				return { ...created };
			},
			async deleteMany(args: { where?: Row }) {
				let count = 0;
				for (let i = registrations.length - 1; i >= 0; i -= 1) {
					if (matchesWhere(registrations[i] as Row, args.where, rel)) {
						registrations.splice(i, 1);
						count += 1;
					}
				}
				return { count };
			},
		},
		webhookEvent: {
			async findMany(args: {
				where?: Row;
				select?: Row;
				orderBy?: { receivedAt: "asc" | "desc" };
				take?: number;
			}) {
				const list = events
					.filter((e) => matchesWhere(e, args.where, rel))
					.sort(
						(a, b) =>
							(a.receivedAt as Date).getTime() -
							(b.receivedAt as Date).getTime(),
					);
				return list
					.slice(0, args.take ?? list.length)
					.map((e) => project(e, args.select));
			},
			async deleteMany(args: { where?: Row }) {
				let count = 0;
				for (let i = events.length - 1; i >= 0; i -= 1) {
					if (matchesWhere(events[i] as Row, args.where, rel)) {
						events.splice(i, 1);
						count += 1;
					}
				}
				return { count };
			},
		},
		appSetting: {
			async findUnique(args: { where: { key: string } }) {
				return settings.has(args.where.key)
					? { value: settings.get(args.where.key) }
					: null;
			},
			async create(args: { data: { key: string; value: unknown } }) {
				if (settings.has(args.data.key)) {
					throw Object.assign(new Error("dup"), { code: "P2002" });
				}
				settings.set(args.data.key, args.data.value);
				return args.data;
			},
			async update(args: { where: { key: string }; data: { value: unknown } }) {
				settings.set(args.where.key, args.data.value);
				return {};
			},
			async upsert(args: {
				where: { key: string };
				create: { value: unknown };
				update: { value: unknown };
			}) {
				settings.set(
					args.where.key,
					settings.has(args.where.key) ? args.update.value : args.create.value,
				);
				return {};
			},
		},
	};
	return {
		prisma: prisma as unknown as AppPrismaClient,
		jobs,
		runs,
		channels,
		registrations,
		events,
		settings,
	};
}
