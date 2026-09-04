import { Editor, Notice } from "obsidian";

/**
 * Правки заметки: теги в frontmatter и AI-ссылки на связанные заметки.
 * Общие для модалов тегов и связей.
 */

/** Вставляет теги в YAML frontmatter (создаёт или расширяет поле tags). Идемпотентно. */
export async function addTagsToFrontmatter(editor: Editor, tags: string[]): Promise<void> {
  const fresh = tags.filter(Boolean);
  if (fresh.length === 0) return;
  const existing = parseExistingTags(editor);
  const merged = [...new Set([...existing, ...fresh])];

  const current = editor.getValue();
  const fmMatch = current.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const value = merged.join(", ");

  try {
    if (!fmMatch) {
      await editor.replaceRange(`---\ntags: [${value}]\n---\n\n`, { line: 0, ch: 0 });
    } else if (/^tags:/m.test(fmMatch[1])) {
      const fmLines = fmMatch[0].trimEnd().split("\n").length;
      const updated = fmMatch[1].replace(/^tags:.*$/m, `tags: [${value}]`);
      await editor.replaceRange(updated, { line: 0, ch: 0 }, { line: fmLines - 1, ch: 0 });
    } else {
      await editor.replaceRange(`tags: [${value}]\n`, { line: 1, ch: 0 });
    }
  } catch (e) {
    new Notice(`Не удалось изменить frontmatter: ${e}`);
  }
}

/** Уже существующие теги заметки (из YAML frontmatter). */
export function parseExistingTags(editor: Editor): string[] {
  const fm = editor.getValue().match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return [];
  const line = fm[1].match(/^tags:\s*(.+)$/m);
  if (!line) return [];
  return line[1]
    .replace(/[[\]]/g, "")
    .split(",")
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean);
}

const AI_LINK_MARKER = "AI Suggested:";

/**
 * Добавляет в конец заметки комментарий-ссылку на связанную заметку:
 * `<!-- AI Suggested: связан с [[Заметка]] (85%) -->`
 * Повторная вставка той же связи не дублируется (как экспорт в бэкенде).
 * @param targetPath путь до связанного файла в Vault.
 */
export async function addAiLink(editor: Editor, targetPath: string, similarity: number): Promise<boolean> {
  const name = basenameNoExt(targetPath);
  const content = editor.getValue();
  if (content.includes(`${AI_LINK_MARKER} связан с [[${name}]]`)) return false;
  const comment = `\n<!-- ${AI_LINK_MARKER} связан с [[${name}]] (${Math.round(similarity * 100)}%) -->\n`;
  const last = editor.lastLine();
  await editor.replaceRange(comment, { line: last, ch: editor.getLine(last).length });
  return true;
}

/** Добавляет сразу несколько связей. Возвращает число реально вставленных. */
export async function addAiLinks(
  editor: Editor,
  links: { path: string; similarity: number }[]
): Promise<number> {
  let added = 0;
  for (const l of links) {
    if (await addAiLink(editor, l.path, l.similarity)) added++;
  }
  return added;
}

function basenameNoExt(path: string): string {
  return path.replace(/\.[^.]+$/, "").split("/").pop() ?? path;
}
