import { SLATE_NORMALIZE_PROMOTE_JOB } from "@bitovp/core";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const systemSweeps = {
	liveChannel: {
		name: "heartbeat-sweep",
		id: "live-heartbeat-sweep",
		marker: "heartbeat",
	},
	slateNormalize: {
		name: SLATE_NORMALIZE_PROMOTE_JOB,
		id: SLATE_NORMALIZE_PROMOTE_JOB,
		marker: "slate",
	},
} as const;

type SystemSweep = (typeof systemSweeps)[keyof typeof systemSweeps];

export function scheduleSystemSweep(
	queue: Queue,
	sweep: SystemSweep,
	every: number,
) {
	return queue.upsertJobScheduler(
		sweep.id,
		{ every },
		{
			name: sweep.name,
			data: { systemSweep: sweep.marker },
			// A numeric BullMQ limit trims the entire shared queue's terminal set.
			opts: { removeOnComplete: true, removeOnFail: true },
		},
	);
}

// A queue can also contain tenant jobs, including jobs with the same name.
// BullMQ 5 stores standalone scheduler runs as repeat:<rjk>:<timestamp>.
// Only their job hash and optional logs need removal. Flow/deduplication
// records have additional relationships and must be left to BullMQ.
const prunePage = `
local stateKey, metaKey = KEYS[1], KEYS[2]
local base, scheduler, name, data, cursorField = unpack(ARGV)
local prefix = 'repeat:' .. scheduler .. ':'
local remainingField = cursorField .. '.remaining'
local progress = redis.call('HMGET', metaKey, cursorField, remainingField)
local offset = tonumber(progress[1]) or 0
local remaining = tonumber(progress[2]) or redis.call('ZCARD', stateKey)
if remaining == 0 then return end
local limit = math.min(100, remaining)
local ids = redis.call('ZRANGE', stateKey, offset, offset + limit - 1)
local retained = 0
for _, id in ipairs(ids) do
  local removed = false
  if id:sub(1, #prefix) == prefix and id:sub(#prefix + 1):match('^%d+$') then
    local key = base .. id
    local fields = redis.call('HMGET', key, 'rjk', 'name', 'data', 'parentKey', 'deid')
    if fields[1] == scheduler and fields[2] == name and fields[3] == data
       and not fields[4] and not fields[5]
       and redis.call('EXISTS', key .. ':lock', key .. ':dependencies',
         key .. ':processed', key .. ':failed', key .. ':unsuccessful') == 0 then
      redis.call('ZREM', stateKey, id)
      redis.call('UNLINK', key, key .. ':logs')
      removed = true
    end
  end
  if not removed then retained = retained + 1 end
end
-- Deletions shift the remaining ranks. A pass covers at most its starting
-- cardinality, so even on a growing queue we revisit ranks shifted by retries.
if #ids < limit or remaining == limit then
  redis.call('HDEL', metaKey, cursorField, remainingField)
else
  redis.call('HSET', metaKey, cursorField, offset + retained, remainingField, remaining - #ids)
end
`;

export async function pruneSystemSweepHistory(
	redis: Pick<Redis, "eval">,
	queue: Queue,
	sweep: SystemSweep,
) {
	for (const state of ["completed", "failed"]) {
		await redis.eval(
			prunePage,
			2,
			queue.toKey(state),
			queue.toKey("meta"),
			queue.toKey(""),
			sweep.id,
			sweep.name,
			JSON.stringify({ systemSweep: sweep.marker }),
			`bitovp.sweepHistoryOffset.${state}`,
		);
	}
}
