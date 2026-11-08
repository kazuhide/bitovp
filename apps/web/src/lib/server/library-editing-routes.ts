import { actorFrom, writeAuditLog } from "./audit";
import { getServerContext } from "./context";
import { editingRoute } from "./library-editing-common";

/** Audit only the public resource identity; never the editing document or locators. */
export function editingMutation(
	req: Request,
	action: (actor: string | null) => Promise<unknown>,
	status = 200,
	options: { allowUnavailable?: "CANCEL" } = {},
) {
	return editingRoute(
		async () => {
			const result = await action(actorFrom(req));
			const ctx = await getServerContext();
			await writeAuditLog(
				ctx,
				{
					method: req.method,
					path: new URL(req.url).pathname,
					statusCode: status,
					response: {
						id:
							typeof result === "object" && result && "id" in result
								? result.id
								: typeof result === "object" && result && "taskId" in result
									? result.taskId
									: undefined,
					},
				},
				req,
			);
			return result;
		},
		status,
		options.allowUnavailable === "CANCEL" ? { allowUnavailable: "CANCEL" } : {},
	);
}
