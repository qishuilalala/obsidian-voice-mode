import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ENDPOINT_POLICY,
  resolveEndpointPolicy,
  ALLOWED_MODEL_HOSTNAMES,
  MODEL_MIRROR_PROBE_TIMEOUT_MS,
  validateModelHost,
  redirectHostAllowed,
  isSafeModelRel,
  ASR_ENGINE_KINDS,
  TTS_ENGINE_KINDS,
  LLM_PRESET_IDS,
  asAsrEngineKind,
  asTtsEngineKind,
  asLlmPresetId,
  isLocalTtsEngine,
  isCloudTtsEngine,
  TTS_OPENAI_PRESETS,
  resolveTtsOpenAiPreset,
  ttsPresetRequiresKey,
  VITS_SPEAKERS,
  KOKORO_VOICES,
  findVitsSpeaker,
  findKokoroVoice,
} from '../src/index.ts'

describe('contracts: endpoint policy and model mirror allowlist', () => {
  it('enforces unified 60s maxSpeechSec and default VAD thresholds', () => {
    assert.deepEqual(DEFAULT_ENDPOINT_POLICY, {
      silenceMs: 1500,
      maxSpeechSec: 60,
      vadThreshold: 0.5,
      detectVadThreshold: 0.35,
    })
    assert.equal(MODEL_MIRROR_PROBE_TIMEOUT_MS, 8000)

    const clamped = resolveEndpointPolicy({
      silenceMs: Number.NaN,
      maxSpeechSec: 9999,
      vadThreshold: -1,
      detectVadThreshold: 2,
    })
    assert.deepEqual(clamped, {
      silenceMs: 1500,
      maxSpeechSec: 300,
      vadThreshold: 0.05,
      detectVadThreshold: 0.99,
    })
  })

  it('validates model mirror allowlist and redirect destinations strictly', () => {
    assert.deepEqual(ALLOWED_MODEL_HOSTNAMES, ['huggingface.co', 'hf.co', 'hf-mirror.com'])

    assert.equal(validateModelHost('https://huggingface.co/foo'), 'https://huggingface.co')
    assert.equal(validateModelHost('https://hf-mirror.com'), 'https://hf-mirror.com')
    assert.equal(validateModelHost('http://huggingface.co'), null)
    assert.equal(validateModelHost('https://user:pass@huggingface.co'), null)
    assert.equal(validateModelHost('https://evil-huggingface.co'), null)
    assert.equal(validateModelHost('https://mirror.internal.example', false), null)
    assert.equal(
      validateModelHost('https://mirror.internal.example/models', true),
      'https://mirror.internal.example',
    )

    // Post-redirect checks (LFS subdomains allowed, lookalikes/http rejected)
    assert.equal(redirectHostAllowed('https://cdn-lfs.huggingface.co/blob/123'), true)
    assert.equal(redirectHostAllowed('https://us.aws.cdn.hf.co/file'), true)
    assert.equal(redirectHostAllowed('https://cdn.hf-mirror.com/file'), true)
    assert.equal(redirectHostAllowed('http://cdn-lfs.huggingface.co/blob/123'), false)
    assert.equal(redirectHostAllowed('https://evil-hf.co/blob/123'), false)
    assert.equal(redirectHostAllowed('https://attacker.example/file', false), false)
    assert.equal(redirectHostAllowed('https://attacker.example/file', true), true)

    assert.equal(isSafeModelRel('espeak-ng-data/phontab', 'espeak-ng-data'), true)
    assert.equal(isSafeModelRel('espeak-ng-data/../secret', 'espeak-ng-data'), false)
    assert.equal(isSafeModelRel('espeak-ng-data\\phontab', 'espeak-ng-data'), false)
    assert.equal(isSafeModelRel('/etc/passwd'), false)
  })
})

describe('engine-kind and voice-catalog', () => {
  it('provides single-source-of-truth engine kinds and catalog lookups without hardcoded secrets', () => {
    assert.deepEqual(ASR_ENGINE_KINDS, ['sensevoice-wasm', 'zipformer-wasm', 'openai-compat', 'daemon'])
    assert.deepEqual(TTS_ENGINE_KINDS, ['system', 'vits-wasm', 'kokoro-daemon', 'openai-compat', 'mimo'])
    assert.equal(LLM_PRESET_IDS.length, 11)
    assert.equal(asAsrEngineKind('unknown'), 'sensevoice-wasm')
    assert.equal(asTtsEngineKind('unknown'), 'system')
    assert.equal(asLlmPresetId('unknown'), 'deepseek')
    assert.equal(isLocalTtsEngine('vits-wasm'), true)
    assert.equal(isCloudTtsEngine('mimo'), true)

    assert.equal(VITS_SPEAKERS.length, 5)
    assert.equal(KOKORO_VOICES.length, 103)
    assert.equal(findVitsSpeaker('suyingxue')?.sid, 0)
    assert.equal(findKokoroVoice('zf_xiaobei')?.sid, 48)

    assert.equal(ttsPresetRequiresKey('siliconflow-cosyvoice2'), true)
    assert.equal(ttsPresetRequiresKey('selfhosted-kokoro'), false)
    assert.equal(resolveTtsOpenAiPreset('__proto__'), null)

    const serializedCatalog = JSON.stringify(TTS_OPENAI_PRESETS)
    assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(serializedCatalog))
  })
})
