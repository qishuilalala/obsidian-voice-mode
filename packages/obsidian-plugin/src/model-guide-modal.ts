import { Modal, type App } from "obsidian";

import { t } from "./i18n.ts";
import type { ModelDownloadProgress } from "./model-manager.ts";

export type ModelGuideKind = "vits" | "dictation";

export interface ModelGuideModalOptions {
  kind: ModelGuideKind;
  /** Starts the download and reports progress; resolves when finished. */
  download: (onProgress: (progress: ModelDownloadProgress) => void) => Promise<unknown>;
  /** Called when the user postpones setup. */
  onSkip?: () => void;
}

/**
 * First-run guide (P0-4): explains the one-time offline model download and lets the
 * user start it inline, with progress, instead of only pointing at settings.
 */
export class ModelGuideModal extends Modal {
  private statusEl: HTMLElement | null = null;
  private busy = false;

  private readonly options: ModelGuideModalOptions;

  constructor(app: App, options: ModelGuideModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    const title =
      this.options.kind === "vits"
        ? t("Download the local speech model")
        : t("Download the offline dictation models");
    this.titleEl.setText(title);
    this.contentEl.createEl("p", {
      text: t(
        "This is a one-time download (about 200 MB) stored outside the vault. After it finishes, local speech works fully offline.",
      ),
    });
    this.statusEl = this.contentEl.createEl("p", { cls: "vm-model-guide-status" });

    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const downloadButton = buttons.createEl("button", {
      text: t("Download now"),
      cls: "mod-cta",
    });
    downloadButton.addEventListener("click", () => {
      void this.runDownload();
    });
    const skipButton = buttons.createEl("button", { text: t("Use system speech for now") });
    skipButton.addEventListener("click", () => {
      this.options.onSkip?.();
      this.close();
    });
    // A11y: move focus to the primary action so keyboard users can act immediately.
    downloadButton.focus();
  }

  private async runDownload(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      await this.options.download((progress) => {
        const percent = Math.max(0, Math.min(100, Math.round(progress.percent ?? 0)));
        this.statusEl?.setText(t("Downloading… {0}%", percent));
      });
      this.statusEl?.setText(t("Download complete."));
    } catch (err) {
      this.statusEl?.setText(
        t("Download failed: {0}", err instanceof Error ? err.message : String(err)),
      );
    } finally {
      this.busy = false;
    }
  }
}
