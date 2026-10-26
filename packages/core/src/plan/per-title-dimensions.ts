type Dimensions = { height?: number; width?: number };

const positiveInteger = (value: number | undefined): value is number =>
	value !== undefined && Number.isSafeInteger(value) && value > 0;

/** Compare only a declared axis shared by every row; never infer a missing size. */
export function perTitleDimensionAxis(
	rows: readonly Dimensions[],
): "width" | "height" | null {
	if (
		!rows.length ||
		rows.some(
			(row) =>
				(row.height !== undefined && !positiveInteger(row.height)) ||
				(row.width !== undefined && !positiveInteger(row.width)),
		)
	)
		return null;
	if (rows.every((row) => positiveInteger(row.width))) return "width";
	if (rows.every((row) => positiveInteger(row.height))) return "height";
	return null;
}
