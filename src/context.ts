import { createHash } from "node:crypto";
import type { Context, Message, ToolCall } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AgentModeOption, SDKImage } from "@cursor/sdk";
import { CURSOR_PI_BRIDGE_PREFERENCE_TEXT } from "./cursor-bridge-contract.js";
import { getCursorReplayPromptLabel } from "./cursor-tool-presentation-registry.js";

export interface CursorPrompt {
	text: string;
	images: SDKImage[];
}

export interface CursorPromptOptions {
	maxInputTokens?: number;
	charsPerToken?: number;
	imageTokenEstimate?: number;
	agentMode?: AgentModeOption;
	/** Compact callable-surface summary; included on bootstrap prompts when set. */
	toolManifest?: string;
	includePiBridgeGuidance?: boolean;
	includePiAskQuestionGuidance?: boolean;
}

export const CURSOR_APPROX_CHARS_PER_TOKEN = 4;
export const CURSOR_IMAGE_TOKEN_ESTIMATE = 1200;
const SECTION_SEPARATOR = "\n\n";

export function getCursorPlanModeToolGuidanceText(
	agentMode: AgentModeOption | undefined,
	options: { includePiBridgeGuidance?: boolean } = {},
): string | undefined {
	if (agentMode !== "plan") return undefined;
	return [
		"Cursor SDK mode is plan for this run. In pi-cursor-sdk, plan mode may still use available tools for inspection when needed.",
		"Safe/read-only shell commands that inspect or print information are allowed when choosing to call shell; do not say shell is blocked by plan mode and then call it anyway.",
		options.includePiBridgeGuidance === false
			? undefined
			: "Exposed bridge tools are also callable in plan mode when the user asks for them or they are needed to answer.",
	].filter((line): line is string => line !== undefined).join("\n");
}

export function getCursorToolTailGuardText(
	options: Pick<CursorPromptOptions, "agentMode"> & { includePlanModeGuidance?: boolean; includePiBridgeGuidance?: boolean } = {},
): string {
	return [
		"Shell: use explicit `cd` to repo path for project commands; session cwd may differ from tool args.",
		options.includePlanModeGuidance === false
			? undefined
			: getCursorPlanModeToolGuidanceText(options.agentMode, { includePiBridgeGuidance: options.includePiBridgeGuidance }),
		"Exact-output requests: output exactly the requested text; no preamble or checks unless asked.",
		"Tools: call available tools; never print tool cards as assistant text.",
		options.includePiBridgeGuidance === false ? undefined : CURSOR_PI_BRIDGE_PREFERENCE_TEXT,
	].filter((line): line is string => line !== undefined).join("\n");
}

function getCursorToolBoundaryText(
	options: Pick<CursorPromptOptions, "agentMode" | "includePiAskQuestionGuidance"> & { hasToolManifest?: boolean; includePiBridgeGuidance?: boolean } = {},
): string {
	const includePiBridgeGuidance = options.includePiBridgeGuidance !== false;
	const includePiAskQuestionGuidance = includePiBridgeGuidance && options.includePiAskQuestionGuidance !== false;
	const lines = [
		"Cursor SDK tool boundary:",
		"Call only Cursor SDK/MCP tools exposed in this run; pi history names, replay labels, and transcript names are not callable.",
		includePiBridgeGuidance
			? "For exposed pi bridge tools, call exposed tool names directly; pi history names and transcript labels are not callable."
			: undefined,
		"Do not claim pi-side or WebSearch/WebFetch tools unless Cursor ran an equivalent tool.",
		includePiAskQuestionGuidance ? "Use cursor_ask_question for material choices if exposed." : undefined,
		getCursorPlanModeToolGuidanceText(options.agentMode, { includePiBridgeGuidance }),
		"Images: only latest user images are sent; ask to reattach prior images.",
	].filter((line): line is string => line !== undefined);
	if (options.hasToolManifest) {
		lines.push("See callable surfaces below.");
	}
	return lines.join("\n");
}

function getCursorBootstrapTailSections(
	options: Pick<CursorPromptOptions, "agentMode" | "includePiBridgeGuidance"> = {},
): string[] {
	return [
		"Answer the latest user request above using the instructions and capabilities available in this run.",
		getCursorToolTailGuardText({ ...options, includePlanModeGuidance: false }),
	];
}

function normalizePiContextMessages(messages: Context["messages"]): Message[] {
	return convertToLlm(messages as Parameters<typeof convertToLlm>[0]);
}

function isTextBlock(block: { type: string }): block is { type: "text"; text: string } {
	return block.type === "text";
}

function isImageBlock(block: { type: string }): block is { type: "image"; data: string; mimeType: string } {
	return block.type === "image";
}

function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

function extractAllImages(messages: Message[]): SDKImage[] {
	const images: SDKImage[] = [];
	for (const msg of messages) {
		if (msg.role !== "user" || typeof msg.content === "string") continue;
		for (const block of msg.content) {
			if (isImageBlock(block) && block.data && block.mimeType) {
				images.push({ data: block.data, mimeType: block.mimeType });
			}
		}
	}
	return images;
}

function formatContentBlocks(content: string | { type: string; text?: string; data?: string; mimeType?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			if (isTextBlock(block)) return block.text;
			if (isImageBlock(block)) return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function formatToolCall(toolCall: ToolCall): string {
	const args = JSON.stringify(toolCall.arguments) ?? "";
	return `Tool call (${getCursorReplayPromptLabel(toolCall.name)}, call ${toolCall.id}): ${args}`;
}

function sanitizeSystemPromptForCursor(systemPrompt: string): string {
	let sanitized = systemPrompt;
	sanitized = sanitized.replace(
		/Available tools:\n[\s\S]*?\n\nIn addition to the tools above, you may have access to other custom tools depending on the project\.\n\n/g,
		"",
	);
	// Keep the Agent Skills catalog. Cursor-specific skill activation wording is normalized
	// by cursor-skill-tool.ts before this prompt reaches the Cursor SDK provider.
	sanitized = sanitized.replace(/\n+Semantic code intelligence priority:[\s\S]*$/g, "");
	return sanitized.trim();
}

function formatMessage(msg: Message): string | undefined {
	switch (msg.role) {
		case "user": {
			const text = formatContentBlocks(msg.content);
			return text ? `User: ${text}` : undefined;
		}
		case "assistant": {
			const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text" as const, text: String(msg.content) }];
			const textParts: string[] = [];
			for (const block of blocks) {
				if (isTextBlock(block)) {
					textParts.push(block.text);
				} else if (isToolCallBlock(block)) {
					textParts.push(formatToolCall(block));
				}
				// Omit thinking content from transcript
			}
			return textParts.length > 0 ? `Assistant: ${textParts.join("\n")}` : undefined;
		}
		case "toolResult": {
			const text = formatContentBlocks(msg.content);
			const label = msg.isError ? "Tool error" : "Tool result";
			return `${label} (${getCursorReplayPromptLabel(msg.toolName)}, call ${msg.toolCallId}): ${text}`;
		}
	}
}

function getLatestUserMessageIndex(messages: Message[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "user") return index;
	}
	return -1;
}

export function estimateCursorTextTokens(text: string, options: Pick<CursorPromptOptions, "charsPerToken"> = {}): number {
	const charsPerToken = options.charsPerToken ?? CURSOR_APPROX_CHARS_PER_TOKEN;
	return Math.ceil(text.length / charsPerToken);
}

export function estimateCursorPromptTokens(prompt: CursorPrompt, options: Pick<CursorPromptOptions, "charsPerToken" | "imageTokenEstimate"> = {}): number {
	return estimateCursorTextTokens(prompt.text, options) + prompt.images.length * (options.imageTokenEstimate ?? CURSOR_IMAGE_TOKEN_ESTIMATE);
}

export function estimateCursorPromptMessageTokens(message: Message, options: Pick<CursorPromptOptions, "charsPerToken"> = {}): number {
	const text = formatMessage(message);
	return text ? estimateCursorTextTokens(text, options) : 0;
}

export function estimateCursorContextTokens(context: Context, options: CursorPromptOptions = {}): number {
	return estimateCursorPromptTokens(buildCursorPrompt(context, options), options);
}

interface CursorContextFingerprintPayload {
	systemHash: string;
	messageHashes: string[];
}

function hashCursorContextValue(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function serializeMessageForFingerprint(message: Message, index: number): string {
	switch (message.role) {
		case "user": {
			const text =
				typeof message.content === "string"
					? message.content
					: JSON.stringify(message.content);
			return hashCursorContextValue(`user:${message.timestamp ?? index}:${text}`);
		}
		case "assistant":
			return hashCursorContextValue(`assistant:${message.timestamp ?? index}:${JSON.stringify(message.content)}`);
		case "toolResult":
			return hashCursorContextValue(
				`toolResult:${message.timestamp ?? index}:${message.toolCallId}:${message.toolName}:${JSON.stringify(message.content)}:${message.isError === true}`,
			);
	}
}

function serializeRawPiMessageForFingerprint(message: Context["messages"][number], index: number): string {
	const role = (message as { role?: string }).role;
	switch (role) {
		case "branchSummary": {
			const entry = message as { summary?: string; fromId?: string; timestamp?: number };
			return hashCursorContextValue(
				`branchSummary:${entry.timestamp ?? index}:${entry.fromId ?? ""}:${entry.summary ?? ""}`,
			);
		}
		case "compactionSummary": {
			const entry = message as { summary?: string; tokensBefore?: number; timestamp?: number };
			return hashCursorContextValue(
				`compactionSummary:${entry.timestamp ?? index}:${entry.tokensBefore ?? ""}:${entry.summary ?? ""}`,
			);
		}
		case "custom": {
			const entry = message as { customType?: string; content?: unknown; timestamp?: number };
			return hashCursorContextValue(
				`custom:${entry.timestamp ?? index}:${entry.customType ?? ""}:${JSON.stringify(entry.content)}`,
			);
		}
		case "bashExecution": {
			const entry = message as {
				command?: string;
				output?: string;
				exitCode?: number | null;
				cancelled?: boolean;
				excludeFromContext?: boolean;
				timestamp?: number;
			};
			if (entry.excludeFromContext) {
				return hashCursorContextValue(`bashExecution:excluded:${entry.timestamp ?? index}`);
			}
			return hashCursorContextValue(
				`bashExecution:${entry.timestamp ?? index}:${entry.command ?? ""}:${entry.output ?? ""}:${entry.exitCode ?? ""}:${entry.cancelled === true}`,
			);
		}
		default:
			return serializeMessageForFingerprint(message as Message, index);
	}
}

function parseCursorContextFingerprint(fingerprint: string): CursorContextFingerprintPayload | undefined {
	try {
		const parsed = JSON.parse(fingerprint) as CursorContextFingerprintPayload;
		if (!parsed || typeof parsed.systemHash !== "string" || !Array.isArray(parsed.messageHashes)) return undefined;
		if (!parsed.messageHashes.every((entry) => typeof entry === "string")) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export function computeCursorContextFingerprint(context: Context): string {
	const payload: CursorContextFingerprintPayload = {
		systemHash: hashCursorContextValue(context.systemPrompt ?? ""),
		messageHashes: context.messages.map((message, index) => serializeRawPiMessageForFingerprint(message, index)),
	};
	return JSON.stringify(payload);
}

export function shouldBootstrapCursorContext(
	sendState: { bootstrapped: boolean; contextFingerprint: string },
	context: Context,
): boolean {
	if (!sendState.bootstrapped) return true;
	const previous = parseCursorContextFingerprint(sendState.contextFingerprint);
	if (!previous) return true;
	const current = parseCursorContextFingerprint(computeCursorContextFingerprint(context));
	if (!current) return true;
	if (current.systemHash !== previous.systemHash) return true;
	if (current.messageHashes.length < previous.messageHashes.length) return true;
	if (current.messageHashes.length > previous.messageHashes.length) {
		for (let index = previous.messageHashes.length; index < context.messages.length; index += 1) {
			const role = (context.messages[index] as { role?: string }).role;
			if (role === "branchSummary" || role === "compactionSummary") return true;
		}
	}
	for (let index = 0; index < previous.messageHashes.length; index += 1) {
		if (current.messageHashes[index] !== previous.messageHashes[index]) return true;
	}
	return false;
}

/** @deprecated Use planCursorSessionSend() for send mode and shouldBootstrapCursorContext() for context-only checks. */
export function shouldBootstrapCursorSend(
	sendState: { bootstrapped: boolean; contextFingerprint: string },
	context: Context,
): boolean {
	return shouldBootstrapCursorContext(sendState, context);
}

export function buildCursorIncrementalPrompt(context: Context, options: CursorPromptOptions = {}): CursorPrompt {
	// Incremental sends omit Pi system instructions and the full tool boundary; the session agent retains both from bootstrap.
	const messages = normalizePiContextMessages(context.messages);
	const latestUserMessageIndex = getLatestUserMessageIndex(messages);
	const latestUserMessage = latestUserMessageIndex >= 0 ? messages[latestUserMessageIndex] : undefined;
	const latestUserText = latestUserMessage ? formatMessage(latestUserMessage) : undefined;
	const text = latestUserText ?? "";
	const images = extractAllImages(latestUserMessage ? [latestUserMessage] : []);
	return { text, images };
}

export function buildCursorPrompt(context: Context, options: CursorPromptOptions = {}): CursorPrompt {
	const sections: string[] = [];

	if (context.systemPrompt) {
		sections.push(`System instructions from pi:\n${sanitizeSystemPromptForCursor(context.systemPrompt)}`);
	}

	const messages = normalizePiContextMessages(context.messages);
	for (const msg of messages) {
		const text = formatMessage(msg);
		if (text) {
			sections.push(text);
		}
	}

	const images = extractAllImages(messages);
	const text = sections.join(SECTION_SEPARATOR);

	return { text, images };
}
