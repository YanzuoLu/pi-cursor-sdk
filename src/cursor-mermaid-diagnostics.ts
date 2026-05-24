import { parseEnvBoolean } from "./cursor-env-boolean.js";

export const CURSOR_MERMAID_PREVIEW_DEBUG_ENV = "PI_CURSOR_MERMAID_PREVIEW_DEBUG";
export const CURSOR_MERMAID_PREVIEW_DIAGNOSTIC_PREFIX = "[pi-cursor-sdk:mermaid]";

export function resolveCursorMermaidPreviewDebugEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return parseEnvBoolean(env[CURSOR_MERMAID_PREVIEW_DEBUG_ENV], false);
}

export type CursorMermaidPreviewDiagnosticEvent =
	| { event: "registered" }
	| {
		event: "message_end";
		outcome:
			| "disabled"
			| "skipped_role"
			| "skipped_provider"
			| "skipped_no_mermaid"
			| "skipped_no_change"
			| "transformed"
			| "transformed_text"
			| "transformed_image";
		provider?: string;
		api?: string;
		textBlocks?: number;
		transformedBlocks?: number;
		imageBlocks?: number;
	}
	| {
		event: "session_backfill";
		reason: string;
		scanned: number;
		transformed: number;
		imageBlocks?: number;
	};

export function writeCursorMermaidPreviewDiagnostic(
	event: CursorMermaidPreviewDiagnosticEvent,
	env: Record<string, string | undefined> = process.env,
): void {
	if (!resolveCursorMermaidPreviewDebugEnabled(env)) return;
	try {
		process.stderr.write(`${CURSOR_MERMAID_PREVIEW_DIAGNOSTIC_PREFIX} ${JSON.stringify(event)}\n`);
	} catch {
		// Diagnostics must never affect preview execution.
	}
}
