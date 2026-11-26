import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXPRESSION_CAPS,
  EXPRESSION_FACETS,
  analyzeExpression,
  coveredEngineKinds,
  getExpressionCaps,
  selectableFacets,
  supportsFacet,
  unsupportedFacets,
} from "../src/expression-caps.ts";

describe("expression caps contract (E1)", () => {
  it("exposes the 13 facets and covers every engine kind", () => {
    assert.equal(EXPRESSION_FACETS.length, 13);
    for (const kind of coveredEngineKinds()) {
      assert.ok(EXPRESSION_CAPS[kind], `caps missing for ${kind}`);
      assert.equal(EXPRESSION_CAPS[kind].engine, kind);
    }
  });

  it("falls back to the system engine for unknown values", () => {
    assert.equal(getExpressionCaps("nope").engine, "system");
    assert.equal(getExpressionCaps(undefined).engine, "system");
  });

  it("maps each engine to its honest facets", () => {
    assert.deepEqual(selectableFacets("system"), ["voices", "rate", "pause"]);
    assert.deepEqual(selectableFacets("kokoro-daemon"), ["voices", "rate", "pause", "whisper"]);
    assert.ok(supportsFacet("kokoro-daemon", "whisper"));
    assert.ok(!supportsFacet("system", "whisper"));
    assert.equal(EXPRESSION_CAPS["kokoro-daemon"].maxPauseMs, 5000);
    assert.equal(EXPRESSION_CAPS.system.maxPauseMs, 0);
    assert.equal(EXPRESSION_CAPS["openai-compat"].emotion, "instructions");
    assert.equal(EXPRESSION_CAPS.system.emotion, "none");
  });

  it("lists unsupported facets instead of silently dropping them", () => {
    assert.deepEqual(unsupportedFacets("system", ["rate", "emotion", "whisper"]), ["emotion", "whisper"]);
    assert.deepEqual(unsupportedFacets("kokoro-daemon", ["rate", "whisper"]), []);
  });

  it("degrades emotion to plain text on non-emotional engines and marks others not-applied", () => {
    const analysis = analyzeExpression("system", ["rate", "emotion", "whisper", "pause"]);
    assert.deepEqual(analysis.supported, ["rate", "pause"]);
    assert.deepEqual(analysis.degraded, [
      { facet: "emotion", behavior: "plain-text" },
      { facet: "whisper", behavior: "not-applied" },
    ]);
    const daemon = analyzeExpression("kokoro-daemon", ["whisper", "emotion"]);
    assert.deepEqual(daemon.supported, ["whisper"]);
    assert.deepEqual(daemon.degraded, [{ facet: "emotion", behavior: "plain-text" }]);
  });

  it("keeps instruction-based emotion engines fully supported", () => {
    const analysis = analyzeExpression("mimo", ["emotion", "instructions", "rate"]);
    assert.deepEqual(analysis.supported, ["emotion", "instructions", "rate"]);
    assert.deepEqual(analysis.degraded, []);
    assert.deepEqual(selectableFacets("openai-compat"), ["voices", "rate", "instructions", "emotion"]);
  });
});
