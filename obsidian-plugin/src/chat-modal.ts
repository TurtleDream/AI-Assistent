import { App, Modal, MarkdownRenderer, setIcon } from "obsidian";
import KnowledgeWeaverPlugin from "./main";
import { embedBatch, ragAnswer } from "./llm";
import { searchChunks } from "./indexer";

/**
 * Модальное окно RAG-чата: вопрос → векторный поиск по индексу → LLM →
 * ответ с кликабельными источниками (открывают файл в Vault).
 */
export class ChatModal extends Modal {
  private history = "";
  private busy = false;

  constructor(private plugin: KnowledgeWeaverPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("kw-chat");

    const header = this.contentEl.createDiv("kw-header");
    setIcon(header.createSpan("kw-icon"), "sparkles");
    header.createSpan({ text: "Knowledge Weaver — чат по заметкам" });

    const log = this.contentEl.createDiv("kw-chat-log");
    this.renderEmpty(log);

    const inputRow = this.contentEl.createDiv("kw-input-row");
    const input = inputRow.createEl("textarea", { placeholder: "Спросите что-нибудь по вашим заметкам… (Enter — отправить)" });
    const sendBtn = inputRow.createEl("button", { text: "Спросить" });

    const ask = async () => {
      const question = input.value.trim();
      if (!question || this.busy) return;
      if (!this.plugin.checkConfig()) return;
      input.value = "";
      this.busy = true;
      sendBtn.disabled = true;

      log.empty();
      const q = log.createDiv("kw-msg kw-msg-user");
      q.createSpan({ text: "Вы: " }).addClass("kw-msg-role");
      q.createSpan({ text: question });

      const a = log.createDiv("kw-msg kw-msg-ai");
      a.createSpan({ text: "AI: " }).addClass("kw-msg-role");
      const spinner = a.createSpan("kw-spinner");
      spinner.setText("Думаю…");

      try {
        const cfg = this.plugin.llmConfig();
        const [qv] = await embedBatch(cfg, [question]);
        const hits = searchChunks(this.plugin.index, qv, this.plugin.settings.topK);

        if (hits.length === 0) {
          spinner.remove();
          a.createSpan({ text: "Индекс пуст — сначала выполните «Reindex vault» в настройках или командной палитре." });
        } else {
          const { answer } = await ragAnswer(cfg, question, hits.map((h) => h.text), hits.map((h) => h.path));
          spinner.remove();
          const contentEl = a.createDiv("kw-answer");
          await MarkdownRenderer.render(this.app, answer, contentEl, "", this.plugin);

          // Кликабельные источники — ключевая фича для Obsidian.
          const seen = new Set<string>();
          const src = a.createDiv("kw-sources");
          src.createSpan({ text: "Источники: " }).addClass("kw-msg-role");
          for (const h of hits) {
            if (seen.has(h.path)) continue;
            seen.add(h.path);
            const chip = src.createEl("a", { text: h.path, cls: "kw-src-chip" });
            chip.onclick = () => {
              this.close();
              this.plugin.openFile(h.path);
            };
          }
          this.history += `\n\nВы: ${question}\nAI: ${answer}`;
        }
      } catch (e) {
        spinner.remove();
        a.createDiv("kw-error").setText(this.plugin.describeError(e));
      } finally {
        this.busy = false;
        sendBtn.disabled = false;
        input.focus();
      }
    };

    sendBtn.onclick = ask;
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        void ask();
      }
    });
    setTimeout(() => input.focus(), 50);
  }

  private renderEmpty(log: HTMLElement): void {
    if (this.history) {
      const prev = log.createDiv("kw-msg kw-msg-ai");
      prev.createSpan({ text: "AI: " }).addClass("kw-msg-role");
      prev.createSpan({ text: this.history.trim() });
      return;
    }
    log.createDiv("kw-empty").setText(
      "Задайте вопрос — я найду ответ по чанкам ваших заметок (RAG). Индексируется: " +
        (Object.keys(this.plugin.index.files).length || 0) + " файлов."
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
