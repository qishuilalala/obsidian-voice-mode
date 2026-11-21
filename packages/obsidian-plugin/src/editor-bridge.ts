import {
  SentenceSegmenter,
  type AsrReplacer,
  type MarkdownTablePolicy,
} from "@voice-mode/core";
import type { Editor } from "obsidian";

export interface ExtractReadableOptions {
  maxSentenceChars?: number;
  tablePolicy?: MarkdownTablePolicy;
  tablePlaceholder?: string;
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const MAX_ACTIVE_ELEMENT_DEPTH = 16;

const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "color",
  "date",
  "datetime-local",
  "file",
  "hidden",
  "image",
  "month",
  "number",
  "password",
  "radio",
  "range",
  "reset",
  "submit",
  "time",
  "week",
]);

interface DomConstructorWindow extends Window {
  HTMLTextAreaElement?: typeof HTMLTextAreaElement;
  HTMLInputElement?: typeof HTMLInputElement;
  InputEvent?: typeof InputEvent;
  Event?: typeof Event;
  DataTransfer?: typeof DataTransfer;
  ClipboardEvent?: typeof ClipboardEvent;
}

function hasObsidianInstanceOf(el: Element): boolean {
  return typeof (el as Partial<Node>).instanceOf === "function";
}

function isTextAreaElement(el: Element): el is HTMLTextAreaElement {
  if (hasObsidianInstanceOf(el)) {
    return el.instanceOf(HTMLTextAreaElement);
  }
  return el.tagName.toUpperCase() === "TEXTAREA";
}

function isInputElement(el: Element): el is HTMLInputElement {
  if (hasObsidianInstanceOf(el)) {
    return el.instanceOf(HTMLInputElement);
  }
  return el.tagName.toUpperCase() === "INPUT";
}

function isEditableHtmlElement(el: Element): el is HTMLElement {
  if (hasObsidianInstanceOf(el)) {
    return el.instanceOf(HTMLElement) && el.isContentEditable;
  }
  const maybeHtml = el as Partial<HTMLElement>;
  return maybeHtml.isContentEditable === true;
}

/**
 * Recursively pierce open Shadow DOM roots and same-origin iframes to locate
 * the deepest currently focused element.
 */
export function resolveDeepActiveElement(doc: Document): Element | null {
  let current: Element | null = doc.activeElement;
  let depth = 0;

  while (current && depth < MAX_ACTIVE_ELEMENT_DEPTH) {
    depth += 1;

    const shadowActive = current.shadowRoot?.activeElement ?? null;
    if (shadowActive && shadowActive !== current) {
      current = shadowActive;
      continue;
    }

    if (current.tagName.toUpperCase() === "IFRAME") {
      try {
        const frameDoc = (current as HTMLIFrameElement).contentDocument;
        const frameActive = frameDoc?.activeElement ?? null;
        if (frameActive && frameActive !== current) {
          current = frameActive;
          continue;
        }
      } catch {
        // Cross-origin iframe cannot be inspected; stop descending.
        break;
      }
    }

    break;
  }

  return current;
}

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

function setNativeInputValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  nextValue: string,
  win: DomConstructorWindow | null,
): void {
  const proto = isTextAreaElement(el)
    ? win?.HTMLTextAreaElement?.prototype
    : win?.HTMLInputElement?.prototype;
  const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : undefined;
  if (descriptor && typeof descriptor.set === "function") {
    descriptor.set.call(el, nextValue);
  } else {
    el.value = nextValue;
  }
}

function dispatchInsertInputEvent(
  el: Element,
  text: string,
  win: DomConstructorWindow | null,
): void {
  const InputEventCtor = win?.InputEvent ?? (typeof InputEvent === "function" ? InputEvent : undefined);
  const EventCtor = win?.Event ?? Event;
  const evt: Event =
    typeof InputEventCtor === "function"
      ? new InputEventCtor("input", {
          bubbles: true,
          cancelable: false,
          data: text,
          inputType: "insertText",
        })
      : new EventCtor("input", { bubbles: true, cancelable: false });
  el.dispatchEvent(evt);
}

/**
 * Attempt in-memory synthetic paste dispatch for virtualized rich-text editors
 * (such as Lexical, ProseMirror, or TipTap `contenteditable` boxes) so framework
 * state reconciliation and Undo/Redo stacks update cleanly without touching the OS clipboard.
 */
function tryDispatchSyntheticPaste(
  el: HTMLElement,
  text: string,
  win: DomConstructorWindow | null,
): boolean {
  const DataTransferCtor =
    win?.DataTransfer ??
    (win === null && typeof DataTransfer === "function" ? DataTransfer : undefined);
  const ClipboardEventCtor =
    win?.ClipboardEvent ??
    (win === null && typeof ClipboardEvent === "function" ? ClipboardEvent : undefined);
  if (typeof DataTransferCtor !== "function" || typeof ClipboardEventCtor !== "function") {
    return false;
  }

  try {
    const dt = new DataTransferCtor();
    dt.setData("text/plain", text);
    const pasteEvt = new ClipboardEventCtor("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    const notCancelled = el.dispatchEvent(pasteEvt);
    return !notCancelled || pasteEvt.defaultPrevented;
  } catch {
    return false;
  }
}

/**
 * Zero-coupling text insertion into any currently focused input outside CodeMirror 6
 * (such as sidebar AI / Copilot chat textareas, Shadow DOM inputs, same-origin iframe
 * inputs, search boxes, or contenteditable widgets) using the native value setter
 * and a synthetic `InputEvent`.
 */
export function insertIntoFocusedInput(
  doc: Document,
  text: string,
  replacer?: AsrReplacer,
): boolean {
  const transformed = replacer ? replacer(text) : text;
  const cleanText = transformed.trim();
  if (!cleanText) {
    return false;
  }

  const active = resolveDeepActiveElement(doc);
  if (!active) {
    return false;
  }

  const targetDoc = active.ownerDocument ?? doc;
  const fallbackWin = typeof activeWindow !== "undefined" ? activeWindow : null;
  const win: DomConstructorWindow | null = targetDoc.defaultView ?? doc.defaultView ?? fallbackWin;

  if (isTextAreaElement(active) || isInputElement(active)) {
    if (active.disabled || active.readOnly) {
      return false;
    }
    if (
      isInputElement(active) &&
      NON_TEXT_INPUT_TYPES.has((active.type || "text").toLowerCase())
    ) {
      return false;
    }

    const current = active.value;
    const start = active.selectionStart ?? current.length;
    const end = active.selectionEnd ?? current.length;
    const nextValue = `${current.slice(0, start)}${cleanText}${current.slice(end)}`;
    const nextCaret = start + cleanText.length;

    setNativeInputValue(active, nextValue, win);
    if (typeof active.setSelectionRange === "function") {
      try {
        active.setSelectionRange(nextCaret, nextCaret);
      } catch {
        // Some input types do not support selection ranges; value insertion still succeeded.
      }
    }
    dispatchInsertInputEvent(active, cleanText, win);
    return true;
  }

  if (isEditableHtmlElement(active)) {
    if (tryDispatchSyntheticPaste(active, cleanText, win)) {
      return true;
    }

    const selection = win?.getSelection ? win.getSelection() : null;
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (active.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        const textNode = targetDoc.createTextNode(cleanText);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        dispatchInsertInputEvent(active, cleanText, win);
        return true;
      }
    }
    if (typeof active.appendText === "function") {
      active.appendText(cleanText);
    } else {
      active.appendChild(targetDoc.createTextNode(cleanText));
    }
    dispatchInsertInputEvent(active, cleanText, win);
    return true;
  }

  return false;
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
