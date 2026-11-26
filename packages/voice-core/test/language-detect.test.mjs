import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectPresentLanguages, detectTextLanguage } from "../src/language-detect.ts";

describe("language detection (P2-1)", () => {
  it("classifies Chinese, Japanese, Korean and English", () => {
    assert.equal(detectTextLanguage("今天天气很好，我们出去走走吧。"), "zh");
    assert.equal(detectTextLanguage("これは日本語のテストです。"), "ja");
    assert.equal(detectTextLanguage("한국어 테스트입니다."), "ko");
    assert.equal(detectTextLanguage("The quick brown fox jumps over the lazy dog."), "en");
  });

  it("returns mixed for substantial Latin + CJK content", () => {
    assert.equal(detectTextLanguage("请 review the pull request before Friday 谢谢"), "mixed");
    assert.equal(detectTextLanguage("API 和 SDK 都在这里"), "mixed");
  });

  it("returns unknown for empty or non-Latin/CJK scripts", () => {
    assert.equal(detectTextLanguage(""), "unknown");
    assert.equal(detectTextLanguage("   "), "unknown");
    assert.equal(detectTextLanguage("Привет мир"), "unknown");
  });

  it("lists present languages with dominant script first", () => {
    assert.deepEqual(detectPresentLanguages("你好世界"), ["zh"]);
    assert.deepEqual(detectPresentLanguages("Hello world"), ["en"]);
    assert.deepEqual(detectPresentLanguages("abc 你好"), ["zh"]);
  });
});
