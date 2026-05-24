import { Image, getCapabilities } from "@earendil-works/pi-tui";

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";
// pi-tui Markdown collapses consecutive blank lines, which breaks iTerm2 row
// reservation for inline images. Use invisible paragraph spacers instead.
const IMAGE_ROW_SPACER = "\u200b";

export function messageContainsMermaidImage(text: string): boolean {
	return text.includes(KITTY_PREFIX) || text.includes(ITERM2_PREFIX);
}

export function formatImageLinesForMarkdown(lines: string[]): string {
	const parts: string[] = [];
	for (const line of lines) {
		parts.push(line === "" ? IMAGE_ROW_SPACER : line);
	}
	return parts.join("\n\n");
}

export function buildTerminalImageMarkdown(
	pngBase64: string,
	widthCells: number,
): string | null {
	if (!getCapabilities().images) return null;

	const image = new Image(
		pngBase64,
		"image/png",
		{ fallbackColor: (text) => text },
		{ maxWidthCells: widthCells },
	);
	const renderWidth = Math.max(80, widthCells + 8);
	const lines = image.render(renderWidth);
	const hasImageSequence = lines.some(
		(line) => line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX),
	);
	if (!hasImageSequence) return null;

	return formatImageLinesForMarkdown(lines);
}
