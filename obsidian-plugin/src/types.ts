/** Типы, общие для модулей плагина. */

export interface IndexChunk {
  /** Путь к файлу внутри Vault (vault-relative path). */
  path: string;
  /** Порядковый номер чанка внутри файла. */
  idx: number;
  /** Текст чанка. */
  text: string;
  /** Вектор эмбеддинга. */
  vector: number[];
}

export interface IndexedFileMeta {
  /** Размер файла (mtime) на момент индексации — для инкрементальной переиндексации. */
  mtime: number;
  chunks: number;
}

/** Данные, которые плагин сохраняет через this.saveData(). */
export interface PluginIndex {
  /** Формат (на будущее). */
  version: 1;
  /** Какой embedding-моделью построен индекс (чтобы не смешивать векторы). */
  embeddingModel: string;
  /** Метаданные проиндексированных файлов. */
  files: Record<string, IndexedFileMeta>;
  /** Все чанки с векторами. */
  chunks: IndexChunk[];
}

export interface IndexingProgress {
  current: number;
  total: number;
  path: string;
}

export interface AIResponse {
  answer: string;
}

export interface ConnectionSuggestion {
  path: string;
  similarity: number;
}

export const EMPTY_INDEX: PluginIndex = {
  version: 1,
  embeddingModel: "",
  files: {},
  chunks: [],
};
