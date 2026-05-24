import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { writeCursorMermaidPreviewDiagnostic } from "./cursor-mermaid-diagnostics.js";
import {
	isCursorMermaidPreviewEnabled,
	transformMermaidFencesInMarkdownAsync,
} from "./cursor-mermaid-preview.js";
import { messageContainsMermaidImage } from "./cursor-mermaid-terminal-image.js";

interface CursorMermaidMessageEndEvent {
	type: "message_end";
	message: AssistantMessage;
}

interface CursorMermaidSessionStartEvent {
	type: "session_start";
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	previousSessionFile?: string;
}

interface CursorMermaidMessageExtensionApi {
	on(
		event: "message_end",
		handler: ExtensionHandler<CursorMermaidMessageEndEvent, { message: AssistantMessage }>,
	): void;
	on(event: "session_start", handler: ExtensionHandler<CursorMermaidSessionStartEvent>): void;
}

function isCursorAssistantMessage(message: AssistantMessage): boolean {
	return message.provider === "cursor" || message.api === "cursor-sdk";
}

function assistantMessageHasMermaidFence(message: AssistantMessage): boolean {
	return message.content.some(
		(block) => block.type === "text" && /```mermaid/i.test(block.text),
	);
}

export async function applyMermaidPreviewToAssistantMessage(message: AssistantMessage): Promise<{
	transformedBlocks: number;
	imageBlocks: number;
	textBlocks: number;
}> {
	let transformedBlocks = 0;
	let imageBlocks = 0;
	let textBlocks = 0;

	for (const block of message.content) {
		if (block.type !== "text") continue;
		if (!/```mermaid/i.test(block.text)) continue;
		const transformed = await transformMermaidFencesInMarkdownAsync(block.text);
		if (transformed === block.text) continue;
		block.text = transformed;
		transformedBlocks += 1;
		if (messageContainsMermaidImage(transformed)) {
			imageBlocks += 1;
		} else {
			textBlocks += 1;
		}
	}

	return { transformedBlocks, imageBlocks, textBlocks };
}

async function backfillSessionMermaidPreviews(ctx: ExtensionContext, reason: string): Promise<void> {
	let scanned = 0;
	let transformed = 0;
	let imageBlocks = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		if (!isCursorAssistantMessage(message)) continue;
		if (!assistantMessageHasMermaidFence(message)) continue;
		scanned += 1;
		const result = await applyMermaidPreviewToAssistantMessage(message);
		transformed += result.transformedBlocks;
		imageBlocks += result.imageBlocks;
	}
	writeCursorMermaidPreviewDiagnostic({
		event: "session_backfill",
		reason,
		scanned,
		transformed,
		imageBlocks,
	});
}

export function registerCursorMermaidPreview(pi: CursorMermaidMessageExtensionApi): void {
	writeCursorMermaidPreviewDiagnostic({ event: "registered" });

	pi.on("session_start", async (event, ctx) => {
		if (!isCursorMermaidPreviewEnabled()) return;
		await backfillSessionMermaidPreviews(ctx, event.reason);
	});

	pi.on("message_end", async (event) => {
		if (!isCursorMermaidPreviewEnabled()) {
			writeCursorMermaidPreviewDiagnostic({ event: "message_end", outcome: "disabled" });
			return;
		}
		if (event.message.role !== "assistant") {
			writeCursorMermaidPreviewDiagnostic({ event: "message_end", outcome: "skipped_role" });
			return;
		}
		if (!isCursorAssistantMessage(event.message)) {
			writeCursorMermaidPreviewDiagnostic({
				event: "message_end",
				outcome: "skipped_provider",
				provider: event.message.provider,
				api: event.message.api,
			});
			return;
		}
		if (!assistantMessageHasMermaidFence(event.message)) {
			writeCursorMermaidPreviewDiagnostic({ event: "message_end", outcome: "skipped_no_mermaid" });
			return;
		}

		const result = await applyMermaidPreviewToAssistantMessage(event.message);
		if (result.transformedBlocks === 0) {
			writeCursorMermaidPreviewDiagnostic({ event: "message_end", outcome: "skipped_no_change" });
			return;
		}

		writeCursorMermaidPreviewDiagnostic({
			event: "message_end",
			outcome: result.imageBlocks > 0 ? "transformed_image" : "transformed_text",
			provider: event.message.provider,
			api: event.message.api,
			transformedBlocks: result.transformedBlocks,
			imageBlocks: result.imageBlocks,
			textBlocks: result.textBlocks,
		});
		return { message: event.message };
	});
}
