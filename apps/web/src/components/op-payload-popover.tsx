"use client";

import type { CompiledOperation } from "@bitovp/core";
import { DetailPopover } from "@/components/ui/detail-popover";
import { useT } from "@/lib/i18n/context";

/**
 * , the last residual (item 1's S4, reproduced by item 13's peek
 * by design): every ops list rendered step + kind and stopped there —
 * `op.payload`, the content the list summarizes, was unreachable in the
 * UI. The kind cell now opens the operation's payload (and its refs when
 * it has any) as selectable JSON. Payloads are secret-free by compiler
 * contract (credential MATERIAL is resolved executor-side at run time and
 * never enters the plan), so rendering them verbatim is safe.
 */
export function OpPayloadPopover({ op }: { op: CompiledOperation }) {
	const { t } = useT();
	const refs = Object.keys(op.refs).length > 0 ? { refs: op.refs } : {};
	return (
		<DetailPopover
			summary={op.kind}
			label={t("uiX.opPayloadLabel", { step: op.step })}
		>
			<pre className="max-h-72 max-w-96 select-text overflow-auto whitespace-pre-wrap break-all text-[11px] text-zinc-300 leading-relaxed">
				{JSON.stringify({ payload: op.payload, ...refs }, null, 2)}
			</pre>
		</DetailPopover>
	);
}
