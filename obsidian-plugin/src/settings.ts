import { App, PluginSettingTab, Setting } from "obsidian";
import KnowledgeWeaverPlugin from "./main";

export type LLMProvider = "openai" | "yandex";

export interface KnowledgeWeaverSettings {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  yandexFolderId: string;
  extensions: string;
  topK: number;
  minSimilarity: number;
  maxTags: number;
}

export const YANDEX_BASE_URL = "https://llm.api.cloud.yandex.net";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

export const DEFAULT_SETTINGS: KnowledgeWeaverSettings = {
  provider: "openai",
  apiKey: "",
  baseUrl: OPENAI_BASE_URL,
  chatModel: "gpt-4o-mini",
  embeddingModel: "text-embedding-3-small",
  yandexFolderId: "",
  extensions: "md, txt, js, py",
  topK: 5,
  minSimilarity: 0.5,
  maxTags: 5,
};

export class KnowledgeWeaverSettingTab extends PluginSettingTab {
  plugin: KnowledgeWeaverPlugin;

  constructor(app: App, plugin: KnowledgeWeaverPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Knowledge Weaver AI").setHeading();

    new Setting(containerEl)
      .setName("Провайдер LLM")
      .setDesc("OpenAI-совместимый API или YandexGPT (собственный формат foundationModels).")
      .addDropdown((d) =>
        d
          .addOption("openai", "OpenAI-совместимый (OpenAI, DeepSeek, OpenRouter…)")
          .addOption("yandex", "YandexGPT")
          .setValue(this.plugin.settings.provider)
          .onChange(async (v) => {
            const provider = v as LLMProvider;
            this.plugin.settings.provider = provider;
            // При смене провайдера подставляем его base URL и модели по умолчанию
            // (как это делает бэкенд при смене provider).
            if (provider === "yandex") {
              if (this.plugin.settings.baseUrl === OPENAI_BASE_URL || !this.plugin.settings.baseUrl) {
                this.plugin.settings.baseUrl = YANDEX_BASE_URL;
              }
              if (this.plugin.settings.chatModel.startsWith("gpt-")) this.plugin.settings.chatModel = "yandexgpt-lite";
              if (this.plugin.settings.embeddingModel.startsWith("text-embedding")) this.plugin.settings.embeddingModel = "text-search-doc";
            } else {
              if (this.plugin.settings.baseUrl === YANDEX_BASE_URL) this.plugin.settings.baseUrl = OPENAI_BASE_URL;
              if (this.plugin.settings.chatModel.startsWith("yandexgpt")) this.plugin.settings.chatModel = "gpt-4o-mini";
              if (this.plugin.settings.embeddingModel.startsWith("text-search")) this.plugin.settings.embeddingModel = "text-embedding-3-small";
            }
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.provider === "yandex") {
      new Setting(containerEl)
        .setName("Folder ID (Yandex Cloud)")
        .setDesc("Обязателен для YandexGPT — входит в modelUri. Например: b1gxxxxxx")
        .addText((t) =>
          t.setPlaceholder("b1gxxxxxx")
            .setValue(this.plugin.settings.yandexFolderId)
            .onChange(async (v) => {
              this.plugin.settings.yandexFolderId = v.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("API-ключ")
      .setDesc("Ключ OpenAI-совместимого провайдера. Хранится локально в данных плагина.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("OpenAI-совместимый API: OpenAI, DeepSeek (https://api.deepseek.com/v1), OpenRouter, локальный сервер и т.д.")
      .addText((t) =>
        t.setValue(this.plugin.settings.baseUrl).onChange(async (v) => {
          this.plugin.settings.baseUrl = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Chat-модель (LLM)")
      .setDesc("Модель для RAG-ответов, тегов и схем.")
      .addText((t) =>
        t.setPlaceholder("gpt-4o-mini / deepseek-chat / ...")
          .setValue(this.plugin.settings.chatModel)
          .onChange(async (v) => {
            this.plugin.settings.chatModel = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Embedding-модель")
      .setDesc("Модель эмбеддингов для индексации. Смена модели требует переиндексации.")
      .addText((t) =>
        t.setValue(this.plugin.settings.embeddingModel).onChange(async (v) => {
          this.plugin.settings.embeddingModel = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Расширения файлов для индексации")
      .setDesc("Через запятую. Например: md, txt, js, py")
      .addText((t) =>
        t.setValue(this.plugin.settings.extensions).onChange(async (v) => {
          this.plugin.settings.extensions = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Топ чанков для RAG")
      .setDesc("Сколько наиболее похожих чанков отправлять модели.")
      .addSlider((s) =>
        s.setLimits(1, 15, 1).setValue(this.plugin.settings.topK).setDynamicTooltip().onChange(async (v) => {
          this.plugin.settings.topK = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Порог сходства для связей")
      .setDesc("Минимальное косинусное сходство (0–1), чтобы заметка попала в «Find connections».")
      .addSlider((s) =>
        s.setLimits(0, 1, 0.05).setValue(this.plugin.settings.minSimilarity).setDynamicTooltip().onChange(async (v) => {
          this.plugin.settings.minSimilarity = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Максимум тегов")
      .setDesc("Сколько тегов максимум предлагает AI для заметки.")
      .addSlider((s) =>
        s.setLimits(1, 10, 1).setValue(this.plugin.settings.maxTags).setDynamicTooltip().onChange(async (v) => {
          this.plugin.settings.maxTags = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Индекс")
      .setDesc(
        this.plugin.index.chunks.length > 0
          ? `Проиндексировано файлов: ${Object.keys(this.plugin.index.files).length}, чанков: ${this.plugin.index.chunks.length} (модель: ${this.plugin.index.embeddingModel}).`
          : "Индекс пуст. Запустите «Knowledge Weaver: Reindex vault»."
      )
      .addButton((b) =>
        b.setButtonText("🔄 Переиндексировать всё").setCta().onClick(() => this.plugin.reindexVault(true))
      )
      .addButton((b) =>
        b.setButtonText("🗑️ Очистить индекс").onClick(async () => {
          this.plugin.index = { version: 1, embeddingModel: "", files: {}, chunks: [] };
          await this.plugin.saveSettings();
          this.display();
        })
      );
  }
}
