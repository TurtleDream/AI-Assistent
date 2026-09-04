import { TFile } from "obsidian";
import { IndexChunk } from "./types";

/** Косинусное сходство — перенесено из бэкенда (чистая функция, без зависимостей). */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export function isCodeFile(ext: string): boolean {
  return ["js", "ts", "py", "json", "css", "html", "sh", "c", "cpp", "java"].includes(ext);
}

/**
 * Чанкинг — та же логика, что в бэкенд-приложении:
 * текст (.md/.txt) — по 500 символов с перекрытием 50,
 * код (.js/.py/…) — по 20 строк.
 */
export function chunkContent(content: string, ext: string): string[] {
  if (isCodeFile(ext)) {
    return chunkByLines(content, 20);
  }
  return chunkByChars(content, 500, 50);
}

function chunkByChars(text: string, size: number, overlap: number): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks: string[] = [];
  let pos = 0;
  while (pos < clean.length) {
    chunks.push(clean.slice(pos, pos + size).trim());
    pos += size - overlap;
  }
  return chunks.filter((c) => c.length > 0);
}

function chunkByLines(text: string, linesPerChunk: number): string[] {
  const lines = text.split(/\r?\n/);
  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i += linesPerChunk) {
    const chunk = lines.slice(i, i + linesPerChunk).join("\n").trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

/** Средний вектор по чанкам файла (для «Find connections» на уровне файла). */
export function averageVector(chunks: IndexChunk[]): number[] {
  const len = chunks[0].vector.length;
  const avg = new Array<number>(len).fill(0);
  for (const c of chunks) {
    for (let i = 0; i < len; i++) avg[i] += c.vector[i] ?? 0;
  }
  for (let i = 0; i < len; i++) avg[i] /= chunks.length;
  return avg;
}

/** Убирает YAML frontmatter и [[wiki-ссылки]] → текст, чтобы не шуметь в эмбеддингах. */
export function cleanMarkdownForEmbedding(content: string): string {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .replace(/\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, (_m, p1: string) => p1.split("/").pop() ?? p1)
    .trim();
}

export function displayName(path: string): string {
  return path.replace(/\.[^.]+$/, "").split("/").pop() ?? path;
}
