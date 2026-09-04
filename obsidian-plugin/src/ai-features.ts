import { App, Editor, Modal, Notice, setIcon } from "obsidian";
import KnowledgeWeaverPlugin from "./main";
import { chatCompletion, extractJson } from "./llm";
import { addTagsToFrontmatter, parseExistingTags } from "./note-edits";

/** Модал «Suggest tags»: предложение тегов + добавление в frontmatter заметки. */
export class TagsModal extends Modal {
  private selected = new Set<string>();

  constructor(private plugin: KnowledgeWeaverPlugin, private editor: Editor) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("kw-modal");

    const header = contentEl.createDiv("kw-header");
    setIcon(header.createSpan("kw-icon"), "tags");
    header.createSpan({ text: "Предложенные теги" });

    const list = contentEl.createDiv("kw-list");
    const spinner = list.createDiv("kw-empty");
    spinner.setText("Анализирую заметку…");

    const actions = contentEl.createDiv("kw-actions");
    const addBtn = actions.createEl("button", { text: "Добавить выбранные в frontmatter", cls: "mod-cta" });
    addBtn.disabled = true;
    addBtn.onclick = () => void this.apply();

    void this.suggest(list, addBtn);
  }

  private async suggest(list: HTMLElement, addBtn: HTMLButtonElement): Promise<void> {
    try {
      const content = this.editor.getValue().slice(0, 6000);
      const cfg = this.plugin.llmConfig();
      const raw = await chatCompletion(
        cfg,
        `Ты — ассистент по тегированию заметок в Obsidian. Предложи теги (нижний регистр, латиница или кириллица, без пробелов, без символа #). Верни СТРОГО JSON-массив строк, не более ${this.plugin.settings.maxTags} тегов.`,
        `Заметка:\n\n${content}`,
        0.2
      );
      const tags = (extractJson(raw) as string[]).slice(0, this.plugin.settings.maxTags);
      list.empty();
      if (!Array.isArray(tags) || tags.length === 0) {
        list.createDiv("kw-empty").setText("Модель не предложила тегов.");
        return;
      }
      const existing = parseExistingTags(this.editor);
      for (const t of tags) {
        const tag = String(t).replace(/^#/, "").replace(/\s+/g, "-");
        if (!tag) continue;
        const chip = list.createEl("a", {
          text: `#${tag}${existing.includes(tag) ? " ✓" : ""}`,
          cls: "kw-tag-chip",
        });
        if (existing.includes(tag)) chip.addClass("kw-tag-existing");
        chip.onclick = () => {
          if (this.selected.has(tag)) {
            this.selected.delete(tag);
            chip.removeClass("kw-tag-selected");
          } else {
            this.selected.add(tag);
            chip.addClass("kw-tag-selected");
          }
          addBtn.disabled = this.selected.size === 0;
        };
      }
    } catch (e) {
      list.empty();
      list.createDiv("kw-error").setText(this.plugin.describeError(e));
    }
  }

  private parseExistingTags(): string[] {
    const fm = this.editor.getValue().match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return [];
    const line = fm[1].match(/^tags:\s*(.+)$/m);
    if (!line) return [];
    return line[1]
      .replace(/[[\]]/g, "")
      .split(",")
      .map((t) => t.trim().replace(/^#/, ""))
      .filter(Boolean);
  }

  /** Добавляет выбранные теги через общий хелпер (идемпотентно). */
  private async apply(): Promise<void> {
    if (this.selected.size === 0) return;
    await addTagsToFrontmatter(this.editor, [...this.selected]);
    new Notice("Knowledge Weaver: теги добавлены.");
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Авто-тегирование: LLM предлагает теги и они СРАЗУ добавляются в frontmatter
 * (объединяются с существующими, без ручного выбора).
 */
export async function autoTagNote(plugin: KnowledgeWeaverPlugin, editor: Editor): Promise<void> {
  if (!plugin.checkConfig()) return;
  const content = editor.getValue().slice(0, 6000);
  if (!content.trim()) {
    new Notice("Knowledge Weaver: заметка пуста — тегировать нечего.");
    return;
  }
  try {
    new Notice("Knowledge Weaver: подбираю теги…");
    const raw = await chatCompletion(
      plugin.llmConfig(),
      `Ты — ассистент по тегированию заметок в Obsidian. Предложи теги (нижний регистр, без пробелов, без символа #). Верни СТРОГО JSON-массив строк, не более ${plugin.settings.maxTags} тегов.`,
      `Заметка:\n\n${content}`,
      0.2
    );
    const parsed = extractJson(raw) as string[];
    const tags = (Array.isArray(parsed) ? parsed : [])
      .slice(0, plugin.settings.maxTags)
      .map((t) => String(t).replace(/^#/, "").replace(/\s+/g, "-"))
      .filter(Boolean);
    if (tags.length === 0) {
      new Notice("Knowledge Weaver: модель не предложила тегов.");
      return;
    }
    await addTagsToFrontmatter(editor, tags);
    new Notice(`Knowledge Weaver: добавлены теги — ${tags.map((t) => "#" + t).join(" ")}`, 6000);
  } catch (e) {
    new Notice(plugin.describeError(e), 8000);
  }
}

/** Команда «Generate diagram from selection»: выделенный текст → Mermaid → вставка в заметку. */
export async function generateDiagramFromSelection(plugin: KnowledgeWeaverPlugin, editor: Editor): Promise<void> {
  if (!plugin.checkConfig()) return;
  const selection = editor.getSelection().trim();
  if (!selection) {
    new Notice("Knowledge Weaver: выделите текст, из которого нужно построить схему.");
    return;
  }
  try {
    new Notice("Knowledge Weaver: генерирую Mermaid-схему…");
    const cfg = plugin.llmConfig();
    const code = await chatCompletion(
      cfg,
      "Ты — генератор диаграмм. Верни ТОЛЬКО Mermaid-код без пояснений и без блоков ```.",
      `Построй Mermaid-диаграмму (graph TD или flowchart) по тексту:\n\n${selection}`,
      0.2
    );
    const mermaid = code.replace(/```[a-z]*\n?|```/g, "").trim();
    if (!mermaid) throw new Error("Модель вернула пустой код.");
    await editor.replaceSelection(`\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`);
    new Notice("Knowledge Weaver: Mermaid-схема вставлена.");
  } catch (e) {
    new Notice(plugin.describeError(e));
  }
}
