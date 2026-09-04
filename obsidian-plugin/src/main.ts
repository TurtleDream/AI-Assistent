import { Command, Editor, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { ChatModal } from "./chat-modal";
import { ConnectionsModal } from "./connections-modal";
import { TagsModal, autoTagNote, generateDiagramFromSelection } from "./ai-features";
import { KnowledgeWeaverSettingTab, DEFAULT_SETTINGS, KnowledgeWeaverSettings } from "./settings";
import { VaultIndexer } from "./indexer";
import { EMPTY_INDEX, PluginIndex } from "./types";
import { LLMConfig } from "./llm";

export default class KnowledgeWeaverPlugin extends Plugin {
  settings: KnowledgeWeaverSettings = DEFAULT_SETTINGS;
  index: PluginIndex = EMPTY_INDEX;
  private indexing = false;

  async onload(): Promise<void> {
    const data = (await this.loadData()) as { index?: PluginIndex; settings?: Partial<KnowledgeWeaverSettings> } | null;
    this.index = data?.index && data.index.version === 1 ? data.index : EMPTY_INDEX;

    await this.loadSettings(data?.settings);

    // Команда открытия основного интерфейса (RAG-чат).
    this.addCommand({
      id: "open-knowledge-weaver",
      name: "Open Knowledge Weaver",
      callback: () => new ChatModal(this).open(),
    });

    // Команда переиндексации Vault.
    this.addCommand({
      id: "reindex-vault",
      name: "Reindex vault",
      callback: () => this.reindexVault(true),
    });

    // Поиск связей для текущей заметки (+ вставка ссылок).
    this.addCommand({
      id: "find-connections",
      name: "Find connections for this note",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          new ConnectionsModal(this, file, view?.editor ?? null).open();
        }
        return true;
      },
    });

    // Предложение тегов для текущей заметки.
    this.addCommand({
      id: "suggest-tags",
      name: "Suggest tags for this note",
      editorCallback: (editor: Editor) => {
        new TagsModal(this, editor).open();
      },
    });

    // Авто-тегирование: предлагает теги и сразу добавляет их в frontmatter.
    this.addCommand({
      id: "auto-tag-note",
      name: "Auto-tag this note",
      editorCallback: (editor: Editor) => {
        void autoTagNote(this, editor);
      },
    });

    // Mermaid-схема из выделенного текста.
    this.addCommand({
      id: "generate-diagram",
      name: "Generate diagram from selection",
      editorCheckCallback: (checking: boolean, editor: Editor) => {
        const hasSelection = editor.getSelection().length > 0;
        if (!hasSelection) return false;
        if (!checking) void generateDiagramFromSelection(this, editor);
        return true;
      },
    });

    // Иконка на ленте.
    this.addRibbonIcon("sparkles", "Open Knowledge Weaver", () => new ChatModal(this).open());

    // Контекстное меню редактора.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        menu.addItem((i) =>
          i.setTitle("Knowledge Weaver: авто-теги").setIcon("tags").onClick(() => void autoTagNote(this, editor))
        );
        menu.addItem((i) =>
          i.setTitle("Knowledge Weaver: схема из выделенного").setIcon("diagram").onClick(() => void generateDiagramFromSelection(this, editor))
        );
      })
    );

    this.addSettingTab(new KnowledgeWeaverSettingTab(this.app, this));
  }

  onunload(): void {
    // Obsidian сам снимает все registerEvent/commands — чистить нечего.
  }

  async loadSettings(saved?: Partial<KnowledgeWeaverSettings>): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ index: this.index, settings: this.settings });
  }

  llmConfig(): LLMConfig {
    return {
      provider: this.settings.provider,
      apiKey: this.settings.apiKey,
      baseUrl: this.settings.baseUrl,
      chatModel: this.settings.chatModel,
      embeddingModel: this.settings.embeddingModel,
      yandexFolderId: this.settings.yandexFolderId,
    };
  }

  checkConfig(): boolean {
    if (this.settings.provider === "yandex" && !this.settings.yandexFolderId) {
      new Notice("Knowledge Weaver: для YandexGPT укажите Folder ID в настройках плагина.");
      return false;
    }
    if (!this.settings.apiKey) {
      new Notice("Knowledge Weaver: укажите API-ключ в настройках плагина.");
      return false;
    }
    return true;
  }

  describeError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("401") || msg.includes("403")) {
      if (this.settings.provider === "yandex") {
        return "Ошибка авторизации Yandex: проверьте API-ключ (Api-Key), Folder ID и регион (гео-блокировка 403).";
      }
      return "Ошибка авторизации: проверьте API-ключ в настройках.";
    }
    if (msg.includes("404") && this.settings.provider === "yandex")
      return "Yandex: model_not_found — убедитесь, что modelUri содержит /latest (добавляется автоматически).";
    if (msg.includes("429")) return "Слишком много запросов к API (429). Подождите немного.";
    if (/сетев|network|fetch|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|aborted/i.test(msg))
      return `Проблема с сетью: проверьте Base URL, подключение и прокси/VPN.\n${msg}`;
    return `Ошибка: ${msg}`;
  }

  openFile(path: string): void {
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (abstract instanceof TFile) {
      void this.app.workspace.getLeaf("tab").openFile(abstract);
    } else {
      new Notice(`Файл не найден: ${path}`);
    }
  }

  /** Полная переиндексация Vault с прогрессом в Notice. */
  async reindexVault(force: boolean): Promise<void> {
    if (this.indexing) {
      new Notice("Knowledge Weaver: индексация уже идёт.");
      return;
    }
    if (!this.checkConfig()) return;

    this.indexing = true;
    const extensions = this.settings.extensions
      .split(",")
      .map((e) => e.trim().replace(/^\./, ""))
      .filter(Boolean);

    const notice = new Notice("Knowledge Weaver: индексация…", 0);
    const indexer = new VaultIndexer(this.app, this.llmConfig());
    indexer.persistFn = async (idx) => {
      this.index = idx;
      await this.saveData({ index: idx, settings: this.settings });
    };

    try {
      this.index = await indexer.index(extensions, this.index, force, (p) => {
        notice.setMessage(
          `Knowledge Weaver: индексация ${p.current}/${p.total}\n${p.path}`
        );
      });
      notice.hide();
      new Notice(
        `Knowledge Weaver: индекс обновлён — файлов: ${Object.keys(this.index.files).length}, чанков: ${this.index.chunks.length}.`
      );
    } catch (e) {
      notice.hide();
      new Notice(this.describeError(e), 8000);
    } finally {
      this.indexing = false;
    }
  }
}
