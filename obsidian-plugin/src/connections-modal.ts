import { App, Editor, MarkdownView, Modal, Notice, TFile, setIcon } from "obsidian";
import KnowledgeWeaverPlugin from "./main";
import { embedBatch } from "./llm";
import { averageVector } from "./utils";
import { addAiLink, addAiLinks } from "./note-edits";

/** Модальное окно «Find connections»: похожие заметки для текущего файла + вставка [[ссылок]]. */
export class ConnectionsModal extends Modal {
  private results: { path: string; similarity: number }[] = [];
  private editor: Editor | null;

  constructor(private plugin: KnowledgeWeaverPlugin, private file: TFile, editor?: Editor | null) {
    super(plugin.app);
    this.editor = editor ?? this.activeEditor();
  }

  /** Редактор активной заметки (если она открыта на редактирование). */
  private activeEditor(): Editor | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.editor ?? null;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("kw-modal");

    const header = contentEl.createDiv("kw-header");
    setIcon(header.createSpan("kw-icon"), "git-fork");
    header.createSpan({ text: `Связи для: ${this.file.basename}` });

    const list = contentEl.createDiv("kw-list");
    const spinner = list.createDiv("kw-empty");
    spinner.setText("Ищу похожие заметки…");

    // Кнопка «добавить все связи» (видна после поиска, если есть редактор).
    const actions = contentEl.createDiv("kw-actions");
    const addAllBtn = actions.createEl("button", {
      text: "🔗 Вставить все ссылки в заметку",
      cls: "mod-cta",
    });
    addAllBtn.disabled = true;
    addAllBtn.onclick = async () => {
      if (!this.editor) return;
      const added = await addAiLinks(this.editor, this.results);
      new Notice(
        added > 0
          ? `Knowledge Weaver: вставлено ссылок — ${added}.`
          : "Knowledge Weaver: все связи уже есть в заметке."
      );
      if (added > 0) this.close();
    };

    void this.find(list, addAllBtn);
  }

  private async find(list: HTMLElement, addAllBtn: HTMLButtonElement): Promise<void> {
    try {
      const { chunks } = this.plugin.index;
      const mine = chunks.filter((c) => c.path === this.file.path);
      if (mine.length === 0) {
        list.empty();
        list.createDiv("kw-empty").setText("Эта заметка не проиндексирована. Выполните «Reindex vault».");
        return;
      }

      const [qv] = await embedBatch(this.plugin.llmConfig(), [await this.plugin.app.vault.read(this.file)]);
      const q = averageVector([{ path: this.file.path, idx: 0, text: "", vector: qv }, ...mine]);

      // Считаем сходство на уровне файлов: группируем по путям и берём max по чанкам.
      const best = new Map<string, number>();
      for (const c of chunks) {
        if (c.path === this.file.path) continue;
        const sim = cosine(q, c.vector);
        const cur = best.get(c.path) ?? -1;
        if (sim > cur) best.set(c.path, sim);
      }

      const threshold = this.plugin.settings.minSimilarity;
      const results = [...best.entries()]
        .filter(([, sim]) => sim >= threshold)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);
      this.results = results.map(([path, similarity]) => ({ path, similarity }));
      if (this.results.length > 0 && this.editor) addAllBtn.disabled = false;

      list.empty();
      if (results.length === 0) {
        list.createDiv("kw-empty").setText(`Похожих заметок не найдено (порог сходства: ${threshold}).`);
        return;
      }
      for (const { path, similarity: sim } of this.results) {
        const row = list.createDiv("kw-row");
        const link = row.createEl("a", { text: `${path} — ${(sim * 100).toFixed(0)}%`, cls: "kw-src-chip" });
        link.onclick = () => {
          this.close();
          void this.plugin.app.workspace.getLeaf("tab").openFile(this.plugin.app.vault.getAbstractFileByPath(path) as TFile);
        };
        if (this.editor) {
          const insertBtn = row.createEl("button", { text: "🔗", cls: "kw-insert-btn" });
          insertBtn.setAttribute("aria-label", `Вставить ссылку на ${path}`);
          insertBtn.onclick = async () => {
            const added = await addAiLink(this.editor!, path, sim);
            new Notice(added ? `Knowledge Weaver: ссылка на «${path}» вставлена.` : "Эта связь уже есть в заметке.");
            if (added) {
              insertBtn.disabled = true;
              insertBtn.setText("✓");
            }
          };
        }
      }
    } catch (e) {
      list.empty();
      list.createDiv("kw-error").setText(this.plugin.describeError(e));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

import { cosineSimilarity as cosine } from "./utils";
