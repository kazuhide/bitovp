import type { Env, QueueKey } from "@bitovp/core";

type QueueOwner = Env["VMAF_QUEUE_OWNER"];

export function primaryWorkerQueues(keys: QueueKey[], owner: QueueOwner) {
	return owner === "dedicated"
		? keys.filter((key) => key !== "vmafRunner")
		: keys;
}

export function dedicatedVmafOwner(owner: QueueOwner): "vmafRunner" {
	if (owner !== "dedicated")
		throw new Error(
			"Dedicated quality worker requires VMAF_QUEUE_OWNER=dedicated",
		);
	return "vmafRunner";
}

type ConnectedWorker = { rawname?: string; db?: string };
type DedicatedConsumer = {
	ready(): Promise<{ name: string; database: number }>;
	listWorkers(): Promise<ConnectedWorker[]>;
	ownsQueue(): Promise<boolean>;
	run(): void;
	close(): Promise<void>;
};

/** BullMQ connects a uniquely named blocking client with autorun disabled.
 * Checking the list after registration lets concurrent starts see one another. */
export async function startDedicatedVmafConsumer(
	worker: DedicatedConsumer,
	signal?: AbortSignal,
) {
	try {
		signal?.throwIfAborted();
		const { name, database } = await worker.ready();
		signal?.throwIfAborted();
		const workers = (await worker.listWorkers()).filter(
			(client) => client.db === undefined || client.db === String(database),
		);
		if (!name || workers.length !== 1 || workers[0]?.rawname !== name)
			throw new Error("VMAF_QUEUE_HAS_ANOTHER_CONSUMER");
		if (!(await worker.ownsQueue()))
			throw new Error("VMAF_QUEUE_OWNERSHIP_UNAVAILABLE");
		signal?.throwIfAborted();
		worker.run();
	} catch (error) {
		await worker.close();
		throw error;
	}
}
