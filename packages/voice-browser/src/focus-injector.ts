/**
 * Host-agnostic DOM focus resolver and zero-clipboard text injector for `<input>`, `<textarea>`,
 * Shadow DOM, same-origin `<iframe>`, and virtualized rich-text editors (Lexical, ProseMirror, TipTap).
 */

import type { AsrReplacer } from '@voice-mode/core'

const MAX_ACTIVE_ELEMENT_DEPTH = 16

const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'date',
  'datetime-local',
  'file',
  'hidden',
  'image',
  'month',
  'number',
  'password',
  'radio',
  'range',
  'reset',
  'submit',
  'time',
  'week',
])

export interface DomConstructorWindow extends Window {
  HTMLTextAreaElement?: typeof HTMLTextAreaElement
  HTMLInputElement?: typeof HTMLInputElement
  InputEvent?: typeof InputEvent
  Event?: typeof Event
  DataTransfer?: typeof DataTransfer
  ClipboardEvent?: typeof ClipboardEvent
}

interface DuckHostElement {
  instanceOf?: (ctor: unknown) => boolean
  appendText?: (text: string) => void
}

function asDuckElement(el: Element): DuckHostElement {
  return el as unknown as DuckHostElement
}

function hasHostInstanceOf(el: Element): boolean {
  return typeof asDuckElement(el).instanceOf === 'function'
}

function isTextAreaElement(el: Element): el is HTMLTextAreaElement {
  if (hasHostInstanceOf(el) && typeof HTMLTextAreaElement !== 'undefined') {
    return Boolean(asDuckElement(el).instanceOf?.(HTMLTextAreaElement))
  }
  return el.tagName.toUpperCase() === 'TEXTAREA'
}

function isInputElement(el: Element): el is HTMLInputElement {
  if (hasHostInstanceOf(el) && typeof HTMLInputElement !== 'undefined') {
    return Boolean(asDuckElement(el).instanceOf?.(HTMLInputElement))
  }
  return el.tagName.toUpperCase() === 'INPUT'
}

function isEditableHtmlElement(el: Element): el is HTMLElement {
  if (hasHostInstanceOf(el) && typeof HTMLElement !== 'undefined') {
    return (
      Boolean(asDuckElement(el).instanceOf?.(HTMLElement)) &&
      (el as Partial<HTMLElement>).isContentEditable === true
    )
  }
  return (el as Partial<HTMLElement>).isContentEditable === true
}

function resolveFallbackWindow(
  el: Element,
  explicitWin?: DomConstructorWindow | null,
): DomConstructorWindow | null {
  if (explicitWin !== undefined) {
    return explicitWin
  }
  const docWin: DomConstructorWindow | null = el.ownerDocument?.defaultView ?? null
  if (docWin) {
    return docWin
  }
  if (typeof window !== 'undefined') {
    const maybeActive = (window as unknown as { activeWindow?: DomConstructorWindow }).activeWindow
    return maybeActive ?? window
  }
  return null
}

function setNativeInputValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  nextValue: string,
  win: DomConstructorWindow | null,
): void {
  const proto = isTextAreaElement(el)
    ? win?.HTMLTextAreaElement?.prototype
    : win?.HTMLInputElement?.prototype
  const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : undefined
  if (descriptor && typeof descriptor.set === 'function') {
    descriptor.set.call(el, nextValue)
  } else {
    el.value = nextValue
  }
}

function dispatchInsertInputEvent(
  el: Element,
  text: string,
  win: DomConstructorWindow | null,
): void {
  const InputEventCtor =
    win?.InputEvent ?? (typeof InputEvent === 'function' ? InputEvent : undefined)
  const EventCtor = win?.Event ?? Event
  const evt: Event =
    typeof InputEventCtor === 'function'
      ? new InputEventCtor('input', {
          bubbles: true,
          cancelable: false,
          data: text,
          inputType: 'insertText',
        })
      : new EventCtor('input', { bubbles: true, cancelable: false })
  el.dispatchEvent(evt)
}

/**
 * Recursively pierce open Shadow DOM roots and same-origin iframes to locate
 * the deepest currently focused element.
 */
export function resolveDeepActiveElement(doc: Document): Element | null {
  let current: Element | null = doc.activeElement
  let depth = 0

  while (current && depth < MAX_ACTIVE_ELEMENT_DEPTH) {
    depth += 1

    const shadowActive = current.shadowRoot?.activeElement ?? null
    if (shadowActive && shadowActive !== current) {
      current = shadowActive
      continue
    }

    if (current.tagName.toUpperCase() === 'IFRAME') {
      try {
        const frameDoc = (current as HTMLIFrameElement).contentDocument
        const frameActive = frameDoc?.activeElement ?? null
        if (frameActive && frameActive !== current) {
          current = frameActive
          continue
        }
      } catch {
        // Cross-origin iframe cannot be inspected; stop descending.
        break
      }
    }

    break
  }

  return current
}

/**
 * Splice text into an `<input>` or `<textarea>` at its current selection range using the
 * native prototype value setter and a synthetic `InputEvent` so controlled UI frameworks reconcile.
 */
export function insertIntoInputOrTextarea(
  el: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  explicitWin?: Window | null,
): boolean {
  if (!text || el.disabled || el.readOnly) {
    return false
  }
  if (isInputElement(el) && NON_TEXT_INPUT_TYPES.has((el.type || 'text').toLowerCase())) {
    return false
  }

  const win = resolveFallbackWindow(el, explicitWin)
  const current = el.value
  const start = el.selectionStart ?? current.length
  const end = el.selectionEnd ?? current.length
  const nextValue = `${current.slice(0, start)}${text}${current.slice(end)}`
  const nextCaret = start + text.length

  setNativeInputValue(el, nextValue, win)
  if (typeof el.setSelectionRange === 'function') {
    try {
      el.setSelectionRange(nextCaret, nextCaret)
    } catch {
      // Non-selectable input types ignore selection ranges; value insertion still succeeded.
    }
  }
  dispatchInsertInputEvent(el, text, win)
  return true
}

/**
 * Dispatch an in-memory synthetic `ClipboardEvent("paste")` for virtualized rich-text editors
 * (Lexical, ProseMirror, TipTap) so framework state and Undo/Redo update without OS clipboard pollution.
 */
export function dispatchSyntheticPaste(
  el: HTMLElement,
  text: string,
  explicitWin?: Window | null,
): boolean {
  if (!text) {
    return false
  }
  const win = resolveFallbackWindow(el, explicitWin)
  const DataTransferCtor =
    win?.DataTransfer ??
    (win === null && typeof DataTransfer === 'function' ? DataTransfer : undefined)
  const ClipboardEventCtor =
    win?.ClipboardEvent ??
    (win === null && typeof ClipboardEvent === 'function' ? ClipboardEvent : undefined)
  if (typeof DataTransferCtor !== 'function' || typeof ClipboardEventCtor !== 'function') {
    return false
  }

  try {
    const dt = new DataTransferCtor()
    dt.setData('text/plain', text)
    const pasteEvt = new ClipboardEventCtor('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    })
    const notCancelled = el.dispatchEvent(pasteEvt)
    return !notCancelled || pasteEvt.defaultPrevented
  } catch {
    return false
  }
}

/**
 * Insert text into the deepest focused `<input>`, `<textarea>`, or `contenteditable` element
 * within `doc` (piercing open Shadow DOM and same-origin iframes).
 */
export function insertIntoFocusedInput(
  doc: Document,
  text: string,
  replacer?: AsrReplacer,
): boolean {
  const transformed = replacer ? replacer(text) : text
  const cleanText = transformed.trim()
  if (!cleanText) {
    return false
  }

  const active = resolveDeepActiveElement(doc)
  if (!active) {
    return false
  }

  const targetDoc = active.ownerDocument ?? doc
  const win: DomConstructorWindow | null =
    targetDoc.defaultView ?? doc.defaultView ?? resolveFallbackWindow(active)

  if (isTextAreaElement(active) || isInputElement(active)) {
    return insertIntoInputOrTextarea(active, cleanText, win)
  }

  if (isEditableHtmlElement(active)) {
    if (dispatchSyntheticPaste(active, cleanText, win)) {
      return true
    }

    const selection = win?.getSelection ? win.getSelection() : null
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0)
      if (active.contains(range.commonAncestorContainer)) {
        range.deleteContents()
        const textNode = targetDoc.createTextNode(cleanText)
        range.insertNode(textNode)
        range.setStartAfter(textNode)
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
        dispatchInsertInputEvent(active, cleanText, win)
        return true
      }
    }

    const hostEl = asDuckElement(active)
    if (typeof hostEl.appendText === 'function') {
      hostEl.appendText(cleanText)
    } else {
      active.appendChild(targetDoc.createTextNode(cleanText))
    }
    dispatchInsertInputEvent(active, cleanText, win)
    return true
  }

  return false
}

export interface FocusTextInjectorOptions {
  replacer?: AsrReplacer
}

/**
 * Stateful adapter wrapping `resolveDeepActiveElement` and `insertIntoFocusedInput`
 * for hosts (Obsidian, SillyTavern, MV3 extensions) sharing one vocabulary replacer.
 */
export class FocusTextInjector {
  private replacer?: AsrReplacer

  constructor(options: FocusTextInjectorOptions = {}) {
    this.replacer = options.replacer
  }

  updateReplacer(replacer?: AsrReplacer): void {
    this.replacer = replacer
  }

  resolveActiveElement(doc: Document): Element | null {
    return resolveDeepActiveElement(doc)
  }

  inject(doc: Document, text: string, replacerOverride?: AsrReplacer): boolean {
    return insertIntoFocusedInput(doc, text, replacerOverride ?? this.replacer)
  }
}
