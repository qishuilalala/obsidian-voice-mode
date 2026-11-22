import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  FocusTextInjector,
  dispatchSyntheticPaste,
  insertIntoFocusedInput,
  insertIntoInputOrTextarea,
  resolveDeepActiveElement,
} from '../src/index.ts'

class MockDataTransfer {
  constructor() {
    this._map = new Map()
  }
  setData(type, val) {
    this._map.set(type, String(val))
  }
  getData(type) {
    return this._map.get(type) ?? ''
  }
}

class MockClipboardEvent extends Event {
  constructor(type, init = {}) {
    super(type, { bubbles: Boolean(init.bubbles), cancelable: Boolean(init.cancelable) })
    this.clipboardData = init.clipboardData ?? null
  }
}

class MockTextControl {
  constructor(tagName = 'TEXTAREA', initialValue = '', type = 'text') {
    this.tagName = tagName
    this.type = type
    this._value = initialValue
    this.selectionStart = initialValue.length
    this.selectionEnd = initialValue.length
    this.disabled = false
    this.readOnly = false
    this.events = []
    this.setterCalls = 0
  }
  get value() {
    return this._value
  }
  set value(v) {
    this.setterCalls += 1
    this._value = v
  }
  setSelectionRange(start, end) {
    this.selectionStart = start
    this.selectionEnd = end
  }
  dispatchEvent(evt) {
    this.events.push(evt)
    return true
  }
}

describe('focus-injector: deep active element piercing and controlled input injection', () => {
  it('pierces open Shadow DOM roots and same-origin iframes while tolerating cross-origin iframes', () => {
    const innerInput = new MockTextControl('INPUT', 'hi ', 'search')
    const sameOriginIframe = {
      tagName: 'IFRAME',
      contentDocument: { activeElement: innerInput },
    }
    const shadowHost = {
      tagName: 'CUSTOM-SIDEBAR',
      shadowRoot: { activeElement: sameOriginIframe },
    }
    const doc = { activeElement: shadowHost }
    assert.equal(resolveDeepActiveElement(doc), innerInput)

    const crossOriginIframe = {
      tagName: 'IFRAME',
      get contentDocument() {
        throw new Error('SecurityError: Blocked a frame with origin')
      },
    }
    assert.equal(resolveDeepActiveElement({ activeElement: crossOriginIframe }), crossOriginIframe)
  })

  it('splices text via native prototype value setter and rejects password/readonly/disabled inputs', () => {
    class MockTextArea extends MockTextControl {
      constructor(v) {
        super('TEXTAREA', v)
      }
    }
    class MockInput extends MockTextControl {
      constructor(type, v = '') {
        super('INPUT', v, type)
      }
    }

    const win = {
      HTMLTextAreaElement: MockTextArea,
      HTMLInputElement: MockInput,
      Event,
    }

    const ta = new MockTextArea('Hello !')
    ta.selectionStart = 6
    ta.selectionEnd = 6
    assert.equal(insertIntoInputOrTextarea(ta, 'SillyTavern', win), true)
    assert.equal(ta.value, 'Hello SillyTavern!')
    assert.equal(ta.selectionStart, 17)
    assert.equal(ta.setterCalls, 1)
    assert.equal(ta.events.length, 1)
    assert.equal(ta.events[0].type, 'input')

    const pw = new MockInput('password', '')
    assert.equal(insertIntoInputOrTextarea(pw, 'top-secret', win), false)
    assert.equal(pw.value, '')

    ta.readOnly = true
    assert.equal(insertIntoInputOrTextarea(ta, 'blocked', win), false)
  })

  it('dispatches in-memory synthetic paste for Lexical/ProseMirror and applies AsrReplacer in insertIntoFocusedInput', () => {
    const pasted = []
    const win = {
      DataTransfer: MockDataTransfer,
      ClipboardEvent: MockClipboardEvent,
      Event,
      getSelection: () => null,
    }

    const editable = new EventTarget()
    editable.tagName = 'DIV'
    editable.isContentEditable = true
    editable.addEventListener('paste', (ev) => {
      const txt = ev.clipboardData?.getData('text/plain') ?? ''
      if (txt) {
        ev.preventDefault()
        pasted.push(txt)
      }
    })

    const doc = {
      activeElement: editable,
      defaultView: win,
      createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    }
    editable.ownerDocument = doc

    assert.equal(dispatchSyntheticPaste(editable, 'Direct paste', win), true)
    assert.equal(
      insertIntoFocusedInput(doc, '  打开黑曜石  ', (s) => s.replace('黑曜石', 'Obsidian')),
      true,
    )
    const injector = new FocusTextInjector({
      replacer: (s) => s.replace('语音层', 'Voice Mode'),
    })
    assert.equal(injector.resolveActiveElement(doc), editable)
    assert.equal(injector.inject(doc, '  欢迎使用语音层  '), true)
    assert.deepEqual(pasted, ['Direct paste', '打开Obsidian', '欢迎使用Voice Mode'])
  })
})
