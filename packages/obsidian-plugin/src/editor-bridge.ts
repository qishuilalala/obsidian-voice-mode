import {
  SentenceSegmenter,
  type AsrReplacer,
  type MarkdownTablePolicy,
} from "@voice-mode/core";
import {
  FocusTextInjector,
  dispatchSyntheticPaste,
  insertIntoFocusedInput,
  insertIntoInputOrTextarea,
  resolveDeepActiveElement,
  type FocusTextInjectorOptions,
} from "@voice-mode/browser";
import type { Editor } from "obsidian";

export {
  FocusTextInjector,
  dispatchSyntheticPaste,
  insertIntoFocusedInput,
  insertIntoInputOrTextarea,
  resolveDeepActiveElement,
  type FocusTextInjectorOptions,
};

export interface ExtractReadableOptions {
  maxSentenceChars?: number;
  tablePolicy?: MarkdownTablePolicy;
  tablePlaceholder?: string;
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

/**
 * Returns true when the currently focused element belongs to an Obsidian
 * CodeMirror 6 editor inside the given MarkdownView container.
 */
export function isMarkdownEditorFocused(
  viewContainerEl: Element | null | undefined,
  activeEl: Element | null,
): boolean {
  if (!viewContainerEl || !activeEl) {
    return false;
  }
  if (!viewContainerEl.contains(activeEl)) {
    return false;
  }
  return typeof activeEl.closest === "function" && Boolean(activeEl.closest(".cm-editor"));
}

/**
 * Insert dictated text cleanly at the active cursor position (or replacing the active selection)
 * inside the current Obsidian Markdown editor.
 */
export function insertDictatedText(
  editor: Editor,
  text: string,
  replacer?: AsrReplacer,
): boolean {
  const transformed = replacer ? replacer(text) : text;
  const cleanText = transformed.trim();
  if (!cleanText) {
    return false;
  }
  editor.replaceSelection(cleanText);
  return true;
}

/**
 * Strip leading YAML frontmatter (`---\n...\n---`) so neither full-note nor select-all
 * read-aloud pronounces raw note metadata.
 */
function stripLeadingFrontmatter(raw: string): string {
  return raw.replace(FRONTMATTER_RE, "");
}

/**
 * Extract Markdown-cleaned spoken sentences from the active Obsidian editor.
 * Prefers the current text selection; otherwise reads the full note.
 * Strips leading YAML frontmatter in both cases.
 */
export function extractReadableText(
  editor: Editor,
  options: ExtractReadableOptions = {},
): string[] {
  const selected = editor.getSelection();
  const baseSource = selected.trim().length > 0 ? selected : editor.getValue();
  const rawSource = stripLeadingFrontmatter(baseSource);
  if (!rawSource.trim()) {
    return [];
  }

  const segmenter = new SentenceSegmenter({
    maxSentenceChars: options.maxSentenceChars ?? 200,
    tablePolicy: options.tablePolicy ?? "skip",
    tablePlaceholder: options.tablePlaceholder,
  });

  const sentences = [...segmenter.feed(rawSource), ...segmenter.flush()];
  return sentences.filter((sentence) => sentence.trim().length > 0);
}
