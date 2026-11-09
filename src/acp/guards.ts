/**
 * Canonical runtime guard for ACP wire objects.
 *
 * ACP params/results are `unknown` at the transport boundary; fields are
 * validated individually with `typeof`/`Array.isArray` where they are used.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
