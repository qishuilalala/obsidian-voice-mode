/** Web Speech payloads carry prosody and timed breaks; binary audio reuses one HTMLAudioElement. */
import type { EmotionSegment, TtsEngine, TtsSynthOptions, TtsSynthResult } from "@voice-mode/core";
import { cancelTimeout, scheduleTimeout } from "@voice-mode/core/http-stream";
import type { AudioSink } from "./playback-queue.ts";

export const SYSTEM_TTS_MIME = "application/x-voice-mode-system-tts";

export interface SystemTtsSegment {
  text: string;
  whisper: boolean;
  preBreakMs: number;
  breakAfterMs: number;
  /** Per-segment rate multiplier from `<slow>` / `<fast>` scopes (default 1). */
  rateScale?: number;
}

export interface SystemTtsPayload {
  text: string;
  voice: string;
  rate: number;
  segments: SystemTtsSegment[];
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      cancelTimeout(timer);
      resolve();
    };
    const timer = scheduleTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function computeLeadingBreakMs(rawText: string): number {
  let sum = 0;
  let rest = rawText;
  const leadRe = /^\s*<\s*break\s+(\d+)\s*ms\s*>/i;
  while (true) {
    const m = leadRe.exec(rest);
    if (!m) break;
    sum += Math.min(5000, Math.max(0, Number(m[1] ?? 0)));
    rest = rest.slice(m[0].length);
  }
  return Math.min(10000, sum);
}

export function buildSystemTtsSegments(
  rawText: string,
  segments: readonly EmotionSegment[],
): SystemTtsSegment[] {
  if (segments.length === 0) return [];
  const leadingBreak = computeLeadingBreakMs(rawText);
  return segments.map((seg, idx) => {
    const attached = Math.max(0, Math.min(5000, seg.preBreakMs ?? 0));
    // `<slow>` / `<fast>` map to a per-segment rate multiplier on system speech.
    const rateScale = seg.slow ? 0.85 : seg.fast ? 1.15 : 1;
    if (idx === 0 && leadingBreak > 0) {
      const pre = Math.min(leadingBreak, attached);
      return {
        text: seg.text,
        whisper: seg.whisper,
        preBreakMs: pre,
        breakAfterMs: Math.max(0, attached - pre),
        rateScale,
      };
    }
    return {
      text: seg.text,
      whisper: seg.whisper,
      preBreakMs: 0,
      breakAfterMs: attached,
      rateScale,
    };
  });
}

export class SystemTtsEngine implements TtsEngine {
  readonly kind = "system" as const;
  readonly mime = SYSTEM_TTS_MIME;
  private defaultVoice = "";
  private defaultRate = 1;

  updateVoice(voice: string, rate?: number): void {
    this.defaultVoice = voice;
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      this.defaultRate = rate;
    }
  }

  async synthesize(
    text: string,
    options?: TtsSynthOptions & { segments?: SystemTtsSegment[] },
  ): Promise<TtsSynthResult> {
    const segments =
      options?.segments && options.segments.length > 0
        ? options.segments
        : [{ text, whisper: false, preBreakMs: 0, breakAfterMs: 0 }];
    const payload: SystemTtsPayload = {
      text,
      voice: options?.voice ?? this.defaultVoice,
      rate: options?.rate ?? this.defaultRate,
      segments,
    };
    return {
      audio: new TextEncoder().encode(JSON.stringify(payload)),
      mime: SYSTEM_TTS_MIME,
    };
  }

  interrupt(): void {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore browser speechSynthesis cancellation errors.
      }
    }
  }

  async close(): Promise<void> {
    this.interrupt();
  }
}

export class BrowserAudioSink implements AudioSink {
  private sharedAudio: HTMLAudioElement | null = null;
  private activeObjectUrl: string | null = null;
  private audioPlaying = false;

  async play(payload: TtsSynthResult, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    if (payload.mime === SYSTEM_TTS_MIME) {
      await this.playSystemUtterance(payload.audio, signal);
      return;
    }
    await this.playAudioBytes(payload, signal);
  }

  pause(): void {
    if (this.audioPlaying && this.sharedAudio) {
      this.sharedAudio.pause();
    } else if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.pause();
    }
  }

  resume(): void {
    if (this.audioPlaying && this.sharedAudio) {
      void this.sharedAudio.play().catch(() => undefined);
    } else if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.resume();
    }
  }

  stop(): void {
    this.resetSharedAudio();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore cancellation errors.
      }
    }
  }

  private resetSharedAudio(): void {
    this.audioPlaying = false;
    if (this.sharedAudio) {
      try {
        this.sharedAudio.onended = null;
        this.sharedAudio.onerror = null;
        this.sharedAudio.pause();
        this.sharedAudio.removeAttribute("src");
        this.sharedAudio.load();
      } catch {
        // Ignore media element reset errors.
      }
    }
    if (this.activeObjectUrl && typeof URL !== "undefined") {
      try {
        URL.revokeObjectURL(this.activeObjectUrl);
      } catch {
        // Ignore revoke errors.
      }
      this.activeObjectUrl = null;
    }
  }

  private async speakSingleSystemSegment(
    text: string,
    voiceName: string,
    rate: number,
    whisper: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted || !text.trim()) return;
    const synth =
      typeof window !== "undefined" && "speechSynthesis" in window
        ? window.speechSynthesis
        : null;
    const UtteranceCtor =
      typeof SpeechSynthesisUtterance !== "undefined"
        ? SpeechSynthesisUtterance
        : null;
    const voices = synth ? synth.getVoices() : [];

    if (!synth || !UtteranceCtor || voices.length === 0) {
      const durationMs = Math.min(900, Math.max(100, text.length * 16));
      await abortableDelay(durationMs, signal);
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        cancelTimeout(safetyTimer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        try {
          synth.cancel();
        } catch {
          // Ignore cancellation errors.
        }
        finish();
      };

      const utterance = new UtteranceCtor(text);
      if (voiceName) {
        const matched = voices.find(
          (v) =>
            v.name === voiceName ||
            v.voiceURI === voiceName ||
            v.lang === voiceName,
        );
        if (matched) utterance.voice = matched;
      }
      utterance.rate = rate || 1;
      utterance.volume = whisper ? 0.65 : 1;
      utterance.onend = finish;
      utterance.onerror = finish;

      const maxExpectedMs = Math.min(20000, Math.max(2500, text.length * 120));
      const safetyTimer = scheduleTimeout(finish, maxExpectedMs);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        synth.cancel();
        synth.speak(utterance);
      } catch {
        finish();
      }
    });
  }

  private async playSystemUtterance(
    encoded: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    const parsed = JSON.parse(
      new TextDecoder().decode(encoded),
    ) as SystemTtsPayload;
    const segs =
      Array.isArray(parsed.segments) && parsed.segments.length > 0
        ? parsed.segments
        : [{ text: parsed.text, whisper: false, preBreakMs: 0, breakAfterMs: 0 }];

    for (const seg of segs) {
      if (signal.aborted) return;
      if (seg.preBreakMs > 0) {
        await abortableDelay(seg.preBreakMs, signal);
      }
      if (signal.aborted) return;
      await this.speakSingleSystemSegment(
        seg.text,
        parsed.voice,
        parsed.rate * (seg.rateScale ?? 1),
        seg.whisper,
        signal,
      );
      if (signal.aborted) return;
      if (seg.breakAfterMs > 0) {
        await abortableDelay(seg.breakAfterMs, signal);
      }
    }
  }

  private async playAudioBytes(
    payload: TtsSynthResult,
    signal: AbortSignal,
  ): Promise<void> {
    if (typeof Audio === "undefined" || typeof URL === "undefined") {
      await abortableDelay(80, signal);
      return;
    }
    this.resetSharedAudio();
    const copy = new Uint8Array(payload.audio.byteLength);
    copy.set(payload.audio);
    const blob = new Blob([copy], { type: payload.mime || "audio/wav" });
    const objectUrl = URL.createObjectURL(blob);
    const audio = (this.sharedAudio ??= new Audio());
    audio.src = objectUrl;
    this.activeObjectUrl = objectUrl;
    this.audioPlaying = true;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.resetSharedAudio();
        resolve();
      };
      const onAbort = () => {
        finish();
      };
      audio.onended = finish;
      audio.onerror = finish;
      signal.addEventListener("abort", onAbort, { once: true });
      void audio.play().catch(() => finish());
    });
  }
}
