import { App, Notice, TFile, Vault } from "obsidian";
import { embedBatch, LLMConfig } from "./llm";
import { EMPTY_INDEX, IndexedFileMeta, IndexingProgress, PluginIndex } from "./types";
import { chunkContent, cleanMarkdownForEmbedding } from "./utils";

const EMBED_BATCH_SIZE = 8; // как в бэкенде (EMBEDDING_BATCH)

/**
 * Индексация Vault: сканирование файлов → чанкинг → эмбеддинги → PluginIndex.
 * Логика перенесена из Node.js-приложения, доступ к файлам — через Vault API.
 */
export class VaultIndexer {
  private cancelled = false;

  constructor(private app: App, private cfg: LLMConfig) {}

  cancel(): void {
    this.cancelled = true;
  }

  /** Файлы Vault, подходящие под выбранные расширения. */
  filesToIndex(extensions: string[]): TFile[] {
    const exts = extensions.map((e) => e.toLowerCase());
    return this.app.vault.getFiles().filter((f) => exts.includes(f.extension.toLowerCase()));
  }

  /**
   * Полная/инкрементальная индексация.
   * @param existing прежний индекс (для инкремента и переиспользования векторов)
   * @param force переиндексировать всё, даже неизменившиеся файлы
   * @param onProgress колбэк прогресса
   */
  async index(
    extensions: string[],
    existing: PluginIndex | null,
    force: boolean,
    onProgress?: (p: IndexingProgress) => void
  ): Promise<PluginIndex> {
    const modelChanged = !!existing && existing.embeddingModel !== this.cfg.embeddingModel;
    if (modelChanged) existing = null; // векторы разных моделей несравнимы

    const files = this.filesToIndex(extensions);
    if (files.length === 0) {
      new Notice("Knowledge Weaver: не найдено файлов для индексации (проверьте расширения в настройках).");
      return existing ?? { ...EMPTY_INDEX, embeddingModel: this.cfg.embeddingModel };
    }

    this.cancelled = false;
    const index: PluginIndex = {
      version: 1,
      embeddingModel: this.cfg.embeddingModel,
      files: force ? {} : { ...(existing?.files ?? {}) },
      chunks: force ? [] : [...(existing?.chunks ?? [])],
    };

    // Пути, которые останутся в индексе (удалённые файлы выбрасываем).
    const wanted = new Set(files.map((f) => f.path));
    if (!force) {
      index.chunks = index.chunks.filter((c) => wanted.has(c.path));
      for (const p of Object.keys(index.files)) if (!wanted.has(p)) delete index.files[p];
    }

    let batchTexts: string[] = [];
    let batchPaths: string[] = [];
    let batchIdx: number[] = [];
    let processed = 0;

    const flush = async () => {
      if (batchTexts.length === 0) return;
      const vectors = await embedBatch(this.cfg, batchTexts);
      for (let i = 0; i < vectors.length; i++) {
        index.chunks.push({ path: batchPaths[i], idx: batchIdx[i], text: batchTexts[i], vector: vectors[i] });
      }
      batchTexts = [];
      batchPaths = [];
      batchIdx = [];
    };

    for (const file of files) {
      if (this.cancelled) {
        new Notice("Knowledge Weaver: индексация остановлена.");
        break;
      }
      processed++;
      onProgress?.({ current: processed, total: files.length, path: file.path });

      const meta: IndexedFileMeta = { mtime: file.stat.mtime, chunks: 0 };
      const prev = !force ? existing?.files?.[file.path] : undefined;
      const unchanged = prev && prev.mtime === file.stat.mtime;

      if (!unchanged) {
        // Убираем старые чанки этого файла.
        index.chunks = index.chunks.filter((c) => c.path !== file.path);

        let raw = await this.read(file);
        if (raw !== null) {
          if (file.extension === "md") raw = cleanMarkdownForEmbedding(raw);
          const pieces = chunkContent(raw, file.extension);
          for (let i = 0; i < pieces.length; i++) {
            batchTexts.push(pieces[i]);
            batchPaths.push(file.path);
            batchIdx.push(i);
            if (batchTexts.length >= EMBED_BATCH_SIZE) await flush();
          }
          meta.chunks = pieces.length;
        }
      }
      index.files[file.path] = meta;

      // Периодически сохраняем, чтобы долгая индексация не терялась при падении.
      if (processed % 25 === 0) await this.persist(index);
    }

    await flush();
    await this.persist(index);
    return index;
  }

  /** Чтение файла через Vault API. Возвращает null, если прочитать не удалось. */
  private async read(file: TFile): Promise<string | null> {
    try {
      return await this.app.vault.read(file);
    } catch (e) {
      console.error(`[Knowledge Weaver] Не удалось прочитать ${file.path}:`, e);
      return null;
    }
  }

  /** Сохранение в данные плагина (localStorage Obsidian через saveData). */
  private persist(index: PluginIndex): Promise<void> {
    return this.persistFn?.(index) ?? Promise.resolve();
  }

  /** Функция сохранения подключается извне (this.saveData плагина). */
  persistFn: ((index: PluginIndex) => Promise<void>) | null = null;
}

/** Поиск топ-K чанков по запросу (вектор вопроса → косинусное сходство). */
export function searchChunks(
  index: PluginIndex,
  queryVector: number[],
  topK: number
): { path: string; text: string; similarity: number }[] {
  const scored = index.chunks.map((c) => ({
    path: c.path,
    text: c.text,
    similarity: dot(queryVector, c.vector),
  }));
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}

/** Скалярное произведение после нормализации эмбеддингов OpenAI = косинусное сходство. */
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

export type { Vault };
