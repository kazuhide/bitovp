import { z } from "zod";
import { jsonError, routeError, validationError } from "./http";
import { VodInputFavoriteError } from "./vod-input-favorites";

export function vodInputFavoriteRouteError(error: unknown) {
	if (error instanceof z.ZodError) return validationError(error);
	if (error instanceof VodInputFavoriteError)
		return jsonError(error.status, "Fixed source operation failed", {
			code: error.code,
		});
	return routeError(error);
}
