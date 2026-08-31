import express from 'express';
import cors from 'cors';
import multer from 'multer';
import OpenAI from 'openai';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors()); // разрешаем запросы с dev-сервера Angular (localhost:4200)
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ------------------------------------------------------------------ *
 *  Глобальное in-memory хранилище векторов.
 *  Каждый объект: { id, project, fileName, chunkText, vector }
 *  ВАЖНО: при перезапуске сервера данные сбрасываются (для MVP OK).
 * ------------------------------------------------------------------ */
const globalKnowledge = [];

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB лимит загрузки

// Поддерживаемые расширения
const TEXT_EXT = new Set(['.txt', '.md']);
const CODE_EXT = new Set(['.js', '.py', '.json']);
const SUPPORTED_EXT = new Set([...TEXT_EXT, ...CODE_EXT]);

// Настройки чанкинга
const TEXT_CHUNK_SIZE = 500;
const TEXT_OVERLAP = 50;
const CODE_LINES_PER_CHUNK = 20;
const EMBEDDING_BATCH = 8; // эмбеддинги генерим батчами по 8
const SIMILARITY_THRESHOLD = 0.5;
const TOP_K = 3;

/* ------------------------------------------------------------------ *
 *  Chunking
 * ------------------------------------------------------------------ */
function chunkText(content) {
  if (content.length <= TEXT_CHUNK_SIZE) return [content];
  const chunks = [];
  let start = 0;
  while (start < content.length) {
    chunks.push(content.slice(start, start + TEXT_CHUNK_SIZE));
    start += TEXT_CHUNK_SIZE - TEXT_OVERLAP;
  }
  return chunks;
}

function chunkCode(content) {
  const lines = content.split('\n');
  const chunks = [];
  for (let i = 0; i < lines.length; i += CODE_LINES_PER_CHUNK) {
    chunks.push(lines.slice(i, i + CODE_LINES_PER_CHUNK).join('\n'));
  }
  return chunks;
}

function chunkByFilename(filename, content) {
  const ext = path.extname(filename).toLowerCase();
  if (CODE_EXT.has(ext)) return chunkCode(content);
  return chunkText(content); // .txt / .md
}

/* ------------------------------------------------------------------ *
 *  Косинусное сходство (чистая функция, без сторонних библиотек)
 * ------------------------------------------------------------------ */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/* ------------------------------------------------------------------ *
 *  Эмбеддинги батчами
 * ------------------------------------------------------------------ */
async function embedTexts(texts) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH);
    const res = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: batch
    });
    const ordered = [...res.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
    vectors.push(...ordered);
  }
  return vectors;
}

/* ------------------------------------------------------------------ *
 *  Системный промпт (жёсткая копия из agent.md)
 * ------------------------------------------------------------------ */
const SYSTEM_PROMPT = `# AGENT.md — Системный промпт AI-ассистента

## Роль
Ты — **Knowledge Weaver**, умный ассистент по работе с заметками и кодом. Ты помогаешь пользователю находить связи между его записями, проектами и задачами.

## Инструкции по поведению
1. **Строгость к контексту:** Отвечай ТОЛЬКО на основе предоставленного текста (чанков из загруженных файлов). Если ответа нет в контексте — скажи: «В ваших заметках нет информации по этому вопросу. Попробуйте загрузить другие файлы или уточнить запрос». НИКОГДА не выдумывай факты.
2. **Проектная привязка:** Если пользователь указал проект, удели особое внимание чанкам из этого проекта. Если данные из других проектов используются для аналогии, явно укажи это.
3. **Структура ответа:**
   - Сначала дай четкий, сжатый ответ по существу (2-3 предложения).
   - Если это код — покажи его в формате Markdown.
   - В конце обязательно перечисли **источники** в формате: [Источник: <имя_файла>] — <цитата из текста>.
4. **Работа с кодом:** Если в контексте есть код, а вопрос про логику работы — объясни код простыми словами, а затем приведи сам код как иллюстрацию.
5. **Негативный сценарий:** Если в контексте есть несколько противоречащих друг другу заметок, скажи об этом пользователю («В ваших заметках есть противоречия по этому поводу...») и приведи обе цитаты.

## Формат вывода (пример)
> **Ответ:** [Твой краткий ответ]
>
> **Обоснование:** [Почему ты так считаешь, ссылка на источник]
>
> **Источники:**
> - Файл project_alpha/notes.md: «...цитата...»
> - Файл config.json: «...цитата...»`;

/* ------------------------------------------------------------------ *
 *  Роуты
 * ------------------------------------------------------------------ */

// Загрузка одного файла (multipart/form-data: поле file + текстовое поле project)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен (поле "file")' });
    }

    const project = (req.body.project || '').trim() || 'Без проекта';
    const ext = path.extname(req.file.originalname).toLowerCase();

    if (!SUPPORTED_EXT.has(ext)) {
      return res.status(400).json({
        error: `Неподдерживаемый тип файла "${ext}". Поддерживаются: .txt, .md, .js, .py, .json`
      });
    }

    const content = req.file.buffer.toString('utf8');
    const chunks = chunkByFilename(req.file.originalname, content);

    // ВАЖНО: пустые чанки (пустой файл) — не тратим токены на эмбеддинги
    if (chunks.length === 0) {
      return res.status(400).json({ error: 'Файл пустой, нечего индексировать' });
    }

    const vectors = await embedTexts(chunks);

    const baseId = `${req.file.originalname}-${Date.now()}`;
    chunks.forEach((chunk, i) => {
      globalKnowledge.push({
        id: `${baseId}-${i}`,
        project,
        fileName: req.file.originalname,
        chunkText: chunk,
        vector: vectors[i]
      });
    });

    return res.status(200).json({ message: 'OK', saved: chunks.length });
  } catch (err) {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      console.error('Upload limit error:', err.message);
      return res.status(413).json({ error: 'Файл превышает лимит 5MB' });
    }
    console.error('Upload error:', err);
    return res.status(500).json({ error: 'Ошибка при индексации файла' });
  }
});

// Вопрос к базе знаний
app.post('/api/query', async (req, res) => {
  try {
    const { question, project } = req.body || {};
    const q = (question || '').toString().trim();

    if (!q) {
      return res.status(400).json({ error: 'Вопрос не должен быть пустым' });
    }

    // 1. Пустая база
    if (globalKnowledge.length === 0) {
      return res.json({ answer: 'Нет загруженных данных', sources: [] });
    }

    // 2. Фильтр по проекту, если указан
    let candidates = globalKnowledge;
    if (project) {
      candidates = candidates.filter((c) => c.project === project);
    }
    if (candidates.length === 0) {
      return res.json({ answer: 'Не нашел информации в этом проекте', sources: [] });
    }

    // 3. Эмбеддинг вопроса
    const [qVector] = await embedTexts([q]);

    // 4. Косинусное сходство + топ-3 с порогом > 0.5
    const scored = candidates
      .map((c) => ({ ...c, score: cosineSimilarity(qVector, c.vector) }))
      .sort((a, b) => b.score - a.score);

    const top = scored.filter((c) => c.score > SIMILARITY_THRESHOLD).slice(0, TOP_K);

    if (top.length === 0) {
      return res.json({ answer: 'Не нашел информации в этом проекте', sources: [] });
    }

    // 5. Формируем контекст и зовём gpt-4o-mini
    const context = top
      .map(
        (c, i) =>
          `[Чанк ${i + 1} из файла "${c.fileName}" (проект: "${c.project}")]\n${c.chunkText}`
      )
      .join('\n\n---\n\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `КОНТЕКСТ (извлечён из загруженных файлов):\n${context}\n\n---\n\nВопрос пользователя: ${q}\n\nДай ответ строго на основе КОНТЕКСТА выше. Ничего не выдумывай.`
        }
      ]
    });

    const answer = completion.choices[0]?.message?.content?.trim() || '';
    const sources = top.map((c) => ({ fileName: c.fileName, chunkText: c.chunkText }));

    return res.json({ answer, sources });
  } catch (err) {
    console.error('Query error:', err);
    return res.status(500).json({ error: 'Ошибка при обработке запроса' });
  }
});

// Список уникальных проектов
app.get('/api/projects', async (req, res) => {
  try {
    const projects = [...new Set(globalKnowledge.map((c) => c.project))];
    return res.json({ projects });
  } catch (err) {
    console.error('Projects error:', err);
    return res.status(500).json({ error: 'Ошибка при получении проектов' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Knowledge Weaver backend listening on http://localhost:${PORT}`);
});