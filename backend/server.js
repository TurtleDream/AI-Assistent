import express from 'express';
import cors from 'cors';
import multer from 'multer';
import OpenAI from 'openai';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { DatabaseSync } from 'node:sqlite';
import fg from 'fast-glob';
import { watch as createWatcher } from 'chokidar';

dotenv.config();

const app = express();
app.use(cors()); // разрешаем запросы с dev-сервера Angular (localhost:4200)
app.use(express.json());

/* ------------------------------------------------------------------ *
 *  Конфигурация LLM (in-memory).
 *  Значения можно задать в .env (fallback) ИЛИ через POST /api/config
 *  (поля задаются в интерфейсе).
 * ------------------------------------------------------------------ */
const LLM_DEFAULTS = {
  // Провайдер: 'openai' (и OpenAI-совместимые) или 'yandex' (YandexGPT)
  provider: process.env.LLM_PROVIDER || 'openai',
  // Провайдер / OpenAI-совместимый baseURL (для openai-провайдеров)
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  // Ключ API (в памяти; может быть передан из UI)
  apiKey: process.env.OPENAI_API_KEY || '',
  // Chat-модель для ответов
  chatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
  // Embedding-модель для индексации и запросов
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-search-query',
  // Embedding-модель для YandexGPT (используется в modelUri; свои модели:
  // text-search-doc / text-search-query; НЕ OpenAI-модели типа text-embedding-3-small!
  yandexEmbeddingModel: process.env.YANDEX_EMBEDDING_MODEL || 'text-search-doc',
  // Обязателен для YandexGPT (входит в modelUri и x-folder-id)
  yandexFolderId: process.env.YANDEX_FOLDER_ID || ''
};

const YANDEX_BASE = 'https://llm.api.cloud.yandex.net';
const YANDEX_PROVIDERS = ['yandex'];

// ВАЖНО: локальный ввод ключа может понадобиться даже если в .env пусто.
const llmConfig = { ...LLM_DEFAULTS };

function getLLMConfig() {
  return { ...llmConfig };
}

// Создаём клиент под текущую конфигурацию (поддержка OpenAI-совместимых API).
function createClient() {
  return new OpenAI({
    apiKey: llmConfig.apiKey || 'no-key',
    baseURL: llmConfig.baseURL || undefined
  });
}

// Кэш последнего созданного клиента, чтобы не плодить инстансы.
let client = null;
function getClient() {
  if (!client) client = createClient();
  return client;
}
function resetClient() {
  client = null;
}

/* ------------------------------------------------------------------ *
 *  Известные модели (для подсказок в UI).
 *  Можно ввести произвольную свою.
 * ------------------------------------------------------------------ */
const KNOWN_CHAT_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4',
  'gpt-3.5-turbo',
  'o1-mini',
  'o1',
  'gpt-4.1-mini',
  'gpt-4.1',
  'deepseek-chat',
  'deepseek-reasoner',
  'claude-3-5-sonnet',
  'claude-3-5-haiku'
];

const KNOWN_EMBEDDING_MODELS = [
  'text-embedding-3-small',
  'text-embedding-3-large',
  'text-embedding-ada-002'
];

// Модели YandexGPT (подсказки для UI, можно ввести свою)
const YANDEX_CHAT_MODELS = ['yandexgpt-lite', 'yandexgpt', 'yandexgpt-pro', 'yandexgpt-32k'];
const YANDEX_EMBEDDING_MODELS = ['text-search-doc', 'text-search-query'];

/* ------------------------------------------------------------------ *
 *  Постоянное хранилище: встроенный SQLite (node:sqlite, Node.js 22.5+).
 *  Замена прежнего LevelDB + in-memory зеркала globalKnowledge.
 *  Файл БД: ./db/knowledge.sqlite
 * ------------------------------------------------------------------ */
const DB_DIR = path.join(process.cwd(), 'db');
const DB_PATH = path.join(DB_DIR, 'knowledge.sqlite');

let db = null;

// Миграция при старте: создаёт таблицы documents и chunks (если не существуют).
//  - documents.id         — уникальный id документа, на который ссылаются чанки
//  - documents.doc_vector — УСРЕДНЁННЫЙ вектор документа (TEXT, JSON-массив)
//  - chunks.vector        — вектор чанка (TEXT, JSON-массив); ищем по чанкам
function migrateSchema() {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS documents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project    TEXT NOT NULL,
      fileName   TEXT NOT NULL,
      ext        TEXT NOT NULL DEFAULT '',
      fileSize   INTEGER NOT NULL DEFAULT 0,
      chunkCount INTEGER NOT NULL DEFAULT 0,
      doc_vector TEXT,
      createdAt  TEXT NOT NULL,
      path       TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id          TEXT PRIMARY KEY,
      document_id INTEGER NOT NULL,
      project     TEXT NOT NULL,
      fileName    TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      chunkText   TEXT NOT NULL,
      vector      TEXT,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tags (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS doc_tags (
      doc_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (doc_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS document_relations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id  INTEGER NOT NULL,
      target_id  INTEGER NOT NULL,
      similarity REAL NOT NULL DEFAULT 0,
      type       TEXT NOT NULL DEFAULT 'ai',
      createdAt  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project);
    CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
    CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project);
    CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
  `);

  // Миграция для существующих БД: добавляем колонку type (тип связи: 'ai' или
  // 'wiki_link'), если она ещё не присутствует в старом файле базы.
  const relCols = db.prepare('PRAGMA table_info(document_relations)').all();
  if (!relCols.some((c) => c.name === 'type')) {
    db.exec("ALTER TABLE document_relations ADD COLUMN type TEXT NOT NULL DEFAULT 'ai'");
  }
}

// Открытие БД и выполнение миграции (вызывается при старте сервера).
function openDatabase() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  migrateSchema();
  console.log(`[db] SQLite подключён: ${DB_PATH}`);
}

// Полная очистка таблиц (удаление документов каскадно удаляет их чанки).
function clearAllFromDb() {
  db.exec('DELETE FROM doc_tags;');
  db.exec('DELETE FROM document_relations;');
  db.exec('DELETE FROM tags;');
  db.exec('DELETE FROM chunks;');
  db.exec('DELETE FROM documents;');
  console.log('[db] База данных полностью очищена');
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB лимит загрузки
const MAX_FILES = 10; // максимальное количество файлов за одну загрузку

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

// Усреднённый вектор (для documents.doc_vector): покомпонентное среднее
// всех векторов чанков документа. Возвращает обычный массив чисел.
function averageVectors(vectors) {
  if (!vectors || vectors.length === 0) return [];
  const dims = vectors[0].length;
  const sum = new Array(dims).fill(0);
  for (const v of vectors) {
    for (let d = 0; d < dims; d++) sum[d] += v[d];
  }
  return sum.map((x) => x / vectors.length);
}

/* ------------------------------------------------------------------ *
 *  Настройки приложения (ключ → значение в таблице settings)
 * ------------------------------------------------------------------ */
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

// Нормализация пути рабочей папки: абсолютный путь, виндовые слэши → прямые
// (fast-glob и сравнение по path работают с прямыми слэшами).
function normalizeWorkspacePath(p) {
  return path.resolve(String(p).trim()).replace(/\\/g, '/');
}

/* ------------------------------------------------------------------ *
 *  Obsidian-совместимость: YAML Frontmatter и внутренние wiki-ссылки.
 * ------------------------------------------------------------------ */

// Извлекает теги и алиасы из YAML Frontmatter (если он есть) для .md-файлов.
// Поддерживает оба синтаксиса Obsidian:
//   tags: [a, b]   ИЛИ   tags:
//                           - a
//                           - b
function parseFrontmatter(content) {
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(content || '');
  if (!m) return { tags: [], aliases: [], body: content || '' };
  const fm = m[1];

  const parseList = (key) => {
    // Ищем строку с ключом в frontmatter.
    const allLines = fm.split(/\r?\n/);
    const startIdx = allLines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
    if (startIdx === -1) return [];
    const header = allLines[startIdx];
    const after = (header.match(/:\s*(.*)$/) || [])[1] || '';

    // "key: [a, b, c]"
    if (after.startsWith('[') && after.endsWith(']')) {
      return after
        .slice(1, -1)
        .split(',')
        .map((s) => s.replace(/['"]/g, '').trim())
        .filter(Boolean);
    }
    // "key: a, b, c"
    if (after.trim().length > 0) {
      return after
        .split(',')
        .map((s) => s.replace(/['"]/g, '').trim())
        .filter(Boolean);
    }
    // "key:" + последующие строки вида "  - значение" до следующего top-level ключа.
    const items = [];
    for (let i = startIdx + 1; i < allLines.length; i++) {
      const l = allLines[i];
      // следующий frontmatter-ключ (без отступа) — прекращаем сбор списка
      if (/^[A-Za-z_][\w-]*\s*:/.test(l)) break;
      const m = l.match(/^\s*[-*]\s+(.+)$/);
      if (m) {
        const val = m[1].trim().replace(/['"]/g, '');
        if (val) items.push(val);
      }
    }
    return items.filter(Boolean);
  };

  return {
    tags: parseList('tags'),
    aliases: parseList('aliases'),
    body: content
  };
}

// Находит все внутренние wiki-ссылки вида [[ИмяФайла]] / [[ИмяФайла|Текст]].
// Имя целевого файла берётся до символов "|" и "#" и пары квадратных скобок.
function parseWikiLinks(content) {
  const re = /\[\[(.*?)\]\]/g;
  const names = [];
  let m;
  while ((m = re.exec(content || ''))) {
    const raw = (m[1] || '').split('|')[0].split('#')[0].trim();
    if (raw) names.push(raw);
  }
  return [...new Set(names)];
}

// Сохраняет полученные из frontmatter теги в tags и doc_tags для документа.
// Возвращает количество сохранённых тегов.
function indexFrontmatterTags(documentId, content, ext) {
  if (ext !== '.md') return 0;
  const { tags } = parseFrontmatter(content);
  if (!tags.length) return 0;

  const insertTag = db.prepare(
    'INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING'
  );
  const insertRel = db.prepare(
    'INSERT OR IGNORE INTO doc_tags (doc_id, tag_id) VALUES (?, ?)'
  );
  let saved = 0;
  for (const raw of tags) {
    const name = String(raw).trim().toLowerCase();
    if (!name) continue;
    insertTag.run(name);
    const row = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
    if (!row) continue;
    insertRel.run(documentId, Number(row.id));
    saved++;
  }
  return saved;
}

// Создаёт связи типа wiki_link (сила 1.0) между документом и целевыми файлами,
// на которые указывают внутренние [[...]]-ссылки. Целевые файлы ищутся по имени
// (без расширения) среди уже проиндексированных документов.
function indexWikiLinks(documentId, content) {
  const targets = parseWikiLinks(content);
  if (!targets.length) return 0;

  const docs = db.prepare('SELECT id, fileName FROM documents').all();
  const nameToId = new Map();
  for (const d of docs) {
    const base = path.basename(d.fileName).replace(/\.[^.]+$/, '');
    if (!nameToId.has(base)) nameToId.set(base, Number(d.id));
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO document_relations
       (source_id, target_id, similarity, type, createdAt)
     VALUES (?, ?, 1.0, 'wiki_link', ?)`
  );
  let saved = 0;
  for (const t of targets) {
    const targetId = nameToId.get(t);
    if (!targetId || targetId === documentId) continue;
    insert.run(documentId, targetId, new Date().toISOString());
    saved++;
  }
  return saved;
}

/* ------------------------------------------------------------------ *
 *  Индексация контента файла (общий хелпер для upload и scan)
 * ------------------------------------------------------------------ */
// Принимает готовый контент файла; чанкует, генерит эмбеддинги и сохраняет
// документ + чанки в БД. Если по filePath уже есть документ — пропускает.
async function indexContent({ project, fileName, ext, fileSize, content, filePath }) {
  const chunks = chunkByFilename(fileName, content);
  if (chunks.length === 0) {
    const e = new Error('Файл пустой, нечего индексировать');
    e.empty = true;
    throw e;
  }

  // Дубликат по абсолютному пути (для scan). У загруженных через UI файлов
  // path пустой, поэтому проверка не мешает повторной ручной загрузке.
  const existing = db
    .prepare('SELECT id FROM documents WHERE path = ? AND path != \'\' LIMIT 1')
    .get(filePath || '');
  if (existing) return { saved: 0, skipped: true, chunkCount: 0 };

  // Дедупликация по имени файла: файл, просканированный из рабочей папки,
  // не индексируется, если документ с таким именем уже загружен вручную
  // (в любой проект) или лежит по другому пути.
  if (filePath) {
    const dup = db
      .prepare(
        `SELECT id FROM documents
         WHERE fileName = ? AND (path IS NULL OR path = '' OR path != ?)
         LIMIT 1`
      )
      .get(fileName, filePath);
    if (dup) return { saved: 0, skipped: true, duplicate: true, chunkCount: 0 };
  }

  const vectors = await embedTexts(chunks);
  const docVector = averageVectors(vectors);

  const insertDoc = db.prepare(
    `INSERT INTO documents (project, fileName, ext, fileSize, chunkCount, doc_vector, createdAt, path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertChunk = db.prepare(
    `INSERT INTO chunks (id, document_id, project, fileName, chunk_index, chunkText, vector)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const docResult = insertDoc.run(
    project,
    fileName,
    ext,
    fileSize,
    chunks.length,
    JSON.stringify(docVector),
    new Date().toISOString(),
    filePath || ''
  );
  const documentId = Number(docResult.lastInsertRowid);

  const baseId = `${fileName}-${Date.now()}-${documentId}`;
  for (let i = 0; i < chunks.length; i++) {
    insertChunk.run(
      `${baseId}-${i}`,
      documentId,
      project,
      fileName,
      i,
      chunks[i],
      JSON.stringify(vectors[i])
    );
  }

  // Obsidian-совместимость: парсим YAML Frontmatter (теги) и внутренние
  // [[wiki-ссылки]] для созданного документа.
  const tagsSaved = indexFrontmatterTags(documentId, content, ext);
  const wikiLinksSaved = indexWikiLinks(documentId, content);

  return {
    saved: chunks.length,
    skipped: false,
    chunkCount: chunks.length,
    tagsSaved,
    wikiLinks: wikiLinksSaved
  };
}

/* ------------------------------------------------------------------ *
 *  YandexGPT адаптер (свой формат foundationModels/v1, НЕ OpenAI).
 *  Авторизация: Authorization: Api-Key <ключ> + заголовок x-folder-id.
 * ------------------------------------------------------------------ */
function yandexHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Api-Key ${llmConfig.apiKey || ''}`
  };
  if (llmConfig.yandexFolderId) headers['x-folder-id'] = llmConfig.yandexFolderId;
  return headers;
}

function yandexBase() {
  // Для Яндекс-адаптера НЕ используем baseURL в формате OpenAI (…/v1, api.openai.com).
  // Яндекс-эндпоинты фиксированы: {base}/foundationModels/v1/...
  let base = (llmConfig.baseURL || '').trim();
  // Нормализация: убираем хвостовые слэши и типовой суффикс версии /v1,
  // иначе путь повторится. Используем кастомный base только если он Yandex-совместимый.
  base = base.replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (base && /yandex|yb\.cloud|llm\.api\.cloud/i.test(base)) return base;
  return YANDEX_BASE; // https://llm.api.cloud.yandex.net
}

function yandexEmbedUrl() {
  return `${yandexBase()}/foundationModels/v1/textEmbedding`;
}
function yandexChatUrl() {
  return `${yandexBase()}/foundationModels/v1/completion`;
}

function yandexChatUri() {
  return `gpt://${llmConfig.yandexFolderId || '${folder}'}/${llmConfig.chatModel}/latest`;
}
function yandexEmbedUri() {
  return `emb://${llmConfig.yandexFolderId || '${folder}'}/${llmConfig.yandexEmbeddingModel}/latest`;
}

async function yandexHttpError(res, modelUri) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  const code = data?.error?.code || '';
  const message = data?.error?.message || text.slice(0, 500);
  const uriHint = modelUri ? ` (modelUri: "${modelUri}")` : '';

  if (code === 'unsupported_country_region_territory') {
    throw new Error(
      'YandexGPT: регион не поддерживается (403 unsupported_country_region_territory). ' +
        'Yandex Cloud отклоняет запросы из вашей страны/IP. Используйте VPN, прокси или ' +
        'сервер в поддерживаемом регионе либо переключите провайдера на OpenAI-совместимый.'
    );
  }
  if (res.status === 401 || code === 'invalid_api_key' || code === 'auth.failed') {
    throw new Error('YandexGPT: неверный API-ключ (401). Проверьте ключ в настройках.');
  }
  if (code === 'model_not_found' || res.status === 404) {
    throw new Error(
      `YandexGPT: модель или Folder ID некорректны (404)${uriHint}. ` +
        `Ответ сервера: ${message}` +
        ' Проверьте Folder ID и имя модели. Формат URI: emb://<folder_id>/<модель>/latest. ' +
        'Убедитесь, что в Yandex Cloud включён доступ к генеративным моделям (Foundation Models) ' +
        'и у сервисного аккаунта есть роль для их вызова.'
    );
  }
  if (res.status === 429) {
    throw new Error('YandexGPT: превышен лимит запросов (429). Попробуйте позже.');
  }
  throw new Error(`YandexGPT API error ${res.status}: ${message}${uriHint}`);
}

// Возвращает понятное пользователю сообщение об ошибке (для известных случаев),
// иначе — запасной текст.
function friendlyError(err, fallback) {
  if (err?.message && err.message.startsWith('YandexGPT')) return err.message;
  return fallback;
}

// Эмбеддинг одного текста через Yandex textEmbedding
async function yandexEmbedOne(text) {
  const modelUri = yandexEmbedUri();
  const url = yandexEmbedUrl();
  const body = JSON.stringify({ modelUri, text });
  console.log(`[YandexGPT] embed → ${url}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: yandexHeaders(),
    body
  });
  if (!res.ok) {
    console.log(`[YandexGPT] embed request: URL=${url} body=${body}`);
    await yandexHttpError(res, modelUri);
  }
  const data = await res.json();
  if (!Array.isArray(data.embedding)) throw new Error('YandexGPT: нет поля embedding в ответе');
  return data.embedding;
}

// Ответ от YandexGPT (chat complete)
async function yandexChat(systemPrompt, userPrompt) {
  const modelUri = yandexChatUri();
  const url = yandexChatUrl();
  const body = JSON.stringify({
    modelUri,
    completionOptions: { temperature: 0.1, maxTokens: '2000' },
    messages: [
      { role: 'system', text: systemPrompt },
      { role: 'user', text: userPrompt }
    ]
  });
  console.log(`[YandexGPT] chat → ${url}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: yandexHeaders(),
    body
  });
  if (!res.ok) {
    console.log(`[YandexGPT] chat request: URL=${url} body=${body.slice(0, 300)}`);
    await yandexHttpError(res, modelUri);
  }
  const data = await res.json();
  const text = data?.result?.alternatives?.[0]?.message?.text;
  return (text || '').trim();
}

// Ответ от OpenAI (gpt-4o-mini и любые OpenAI-совместимые)
async function openaiChat(systemPrompt, userPrompt) {
  const completion = await getClient().chat.completions.create({
    model: llmConfig.chatModel,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  });
  return completion.choices[0]?.message?.content?.trim() || '';
}

// Универсальная генерация ответа по активному провайдеру
function generateAnswer(systemPrompt, userPrompt) {
  if (llmConfig.provider === 'yandex') return yandexChat(systemPrompt, userPrompt);
  return openaiChat(systemPrompt, userPrompt);
}

/* ------------------------------------------------------------------ *
 *  Эмбеддинги
 * ------------------------------------------------------------------ */
async function embedTexts(texts) {
  // Yandex: только по одному тексту за запрос
  if (llmConfig.provider === 'yandex') {
    const vectors = [];
    for (const t of texts) vectors.push(await yandexEmbedOne(t));
    return vectors;
  }

  // OpenAI: батчами по EMBEDDING_BATCH
  const vectors = [];
  const client = getClient();
  const model = llmConfig.embeddingModel;
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH);
    const res = await client.embeddings.create({
      model,
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
 *  Проект локально просканированных файлов.
 *  Псевдопроект «Локальная папка» больше не создаётся: просканированные
 *  файлы относятся к проекту с именем рабочей папки, а файлы, уже
 *  загруженные вручную (по имени), не дублируются.
 * ------------------------------------------------------------------ */

function localProjectName() {
  const ws = getSetting('workspacePath');
  return ws ? path.basename(ws) : 'Локальная папка';
}

// Удаляет из БД дубли: документы из «Локальная папка», чьё имя уже есть
// в другом проекте (загружены вручную). Оставшиеся локальные документы
// переносит в проект с именем рабочей папки.
function cleanupLocalFolderDuplicates() {
  const dupRows = db
    .prepare(
      `SELECT d.id FROM documents d
       WHERE d.project = 'Локальная папка'
         AND EXISTS (
           SELECT 1 FROM documents o
           WHERE o.fileName = d.fileName AND o.id != d.id
             AND (o.path IS NULL OR o.path = '' OR o.path != d.path)
         )`
    )
    .all();
  for (const { id } of dupRows) {
    const docId = Number(id);
    db.prepare('DELETE FROM document_relations WHERE source_id = ? OR target_id = ?').run(docId, docId);
    db.prepare('DELETE FROM doc_tags WHERE doc_id = ?').run(docId);
    db.prepare('DELETE FROM chunks WHERE document_id = ?').run(docId);
    db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
  }
  if (dupRows.length) {
    console.log(`[scan] Удалено дублей из «Локальная папка»: ${dupRows.length}`);
  }

  // Переименовываем сам псевдопроект в имя рабочей папки.
  const target = localProjectName();
  if (target !== 'Локальная папка') {
    const renamedDocs = db
      .prepare("UPDATE documents SET project = ? WHERE project = 'Локальная папка'")
      .run(target).changes;
    if (renamedDocs > 0) {
      db.prepare("UPDATE chunks SET project = ? WHERE project = 'Локальная папка'").run(target);
      console.log(`[scan] Проект «Локальная папка» переименован в «${target}» (${renamedDocs} док.)`);
    }
  }
}

// Текущее состояние фонового сканирования (для отображения прогресса в UI).
let scanState = {
  running: false,
  total: 0,
  processed: 0,
  newIndexed: 0,
  errors: [],
  current: ''
};

/* ------------------------------------------------------------------ *
 *  Автоматическое обновление индекса при изменении файлов (chokidar).
 *  Переиндексируется только конкретный изменённый файл: удаляем старые
 *  чанки и теги, затем создаём новые. Удалённые файлы убираются из БД.
 * ------------------------------------------------------------------ */
let workspaceWatcher = null;
const watchTimers = new Map(); // нормализованный путь → таймер дебаунса

// Полностью удаляет документ из БД (чанки, теги, связи) по абсолютному пути.
function removeDocumentByPath(filePath) {
  const doc = db.prepare('SELECT id FROM documents WHERE path = ?').get(filePath);
  if (!doc) return null;
  const docId = Number(doc.id);
  db.prepare('DELETE FROM document_relations WHERE source_id = ? OR target_id = ?').run(docId, docId);
  db.prepare('DELETE FROM doc_tags WHERE doc_id = ?').run(docId);
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(docId);
  db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
  return docId;
}

// Переиндексирует один файл: удаляет старое состояние и индексирует заново.
async function reindexFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXT.has(ext)) return { saved: 0, changed: false };
  removeDocumentByPath(filePath);
  const [content, fileStat] = await Promise.all([
    fs.promises.readFile(filePath, 'utf8'),
    fs.promises.stat(filePath)
  ]);
  const result = await indexContent({
    project: localProjectName(),
    fileName: path.basename(filePath),
    ext,
    fileSize: fileStat.size,
    content,
    filePath
  });
  return { ...result, changed: !result.skipped };
}

// Дебаунс: несколько быстрых событий на один файл схлопываются в одно переиндексирование.
function scheduleReindex(filePath) {
  const key = path.normalize(filePath);
  clearTimeout(watchTimers.get(key));
  const timer = setTimeout(async () => {
    watchTimers.delete(key);
    try {
      const r = await reindexFile(key);
      if (r.changed) {
        console.log(`[watch] Переиндексировано: ${key} (чанков: ${r.saved})`);
      }
    } catch (err) {
      console.error(`[watch] Ошибка переиндексации ${key}:`, err.message);
    }
  }, 600);
  watchTimers.set(key, timer);
}

// Удаление файла из workspace — удаляем его записи из индекса.
function scheduleDelete(filePath) {
  const key = path.normalize(filePath);
  const removed = removeDocumentByPath(key);
  if (removed) console.log(`[watch] Удалено из индекса: ${key}`);
}

function startWatcher(folderPath) {
  stopWatcher();
  if (!folderPath || !fs.existsSync(folderPath)) return;
  workspaceWatcher = createWatcher(folderPath, {
    persistent: true,
    ignoreInitial: true, // уже существующие файлы не индексируем — это делает /api/scan
    ignorePermissionErrors: true,
    ignored: (p) => /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(p),
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
  });

  workspaceWatcher.on('add', (p) => scheduleReindex(p));
  workspaceWatcher.on('change', (p) => scheduleReindex(p));
  workspaceWatcher.on('unlink', (p) => scheduleDelete(p));
  workspaceWatcher.on('error', (err) => console.error('[watch] Ошибка watcher:', err));
  console.log(`[watch] Следим за изменениями: ${folderPath}`);
}

function stopWatcher() {
  if (workspaceWatcher) {
    workspaceWatcher.close().catch(() => {});
    workspaceWatcher = null;
  }
  for (const t of watchTimers.values()) clearTimeout(t);
  watchTimers.clear();
}

// Пересобирает связи wiki_link между всеми локальными .md-файлами (без вызова
// API эмбеддингов). Нужно, чтобы прямые [[...]]-ссылки на файлы, которые были
// проиндексированы раньше, устанавливались и при произвольном порядке обхода.
// INSERT OR IGNORE делает функцию идемпотентной — дубликаты не создаются.
function rebuildWikiLinks() {
  const docs = db
    .prepare("SELECT id, fileName, path FROM documents WHERE path != ''")
    .all();
  let added = 0;
  for (const d of docs) {
    if (!String(d.fileName).toLowerCase().endsWith('.md')) continue;
    let content = '';
    try {
      content = fs.readFileSync(d.path, 'utf8');
    } catch {
      continue;
    }
    added += indexWikiLinks(Number(d.id), content);
  }
  return added;
}

// Задание папки для локального сканирования (хранится в таблице settings).
app.post('/api/set-workspace', async (req, res) => {
  try {
    const raw = (req.body && req.body.folderPath) || '';
    const folderPath = normalizeWorkspacePath(raw);
    if (!folderPath) {
      return res.status(400).json({ error: 'Не указан путь к папке (folderPath)' });
    }
    if (!fs.existsSync(folderPath)) {
      return res.status(400).json({ error: 'Папка не найдена на диске' });
    }
    const stat = fs.statSync(folderPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Указанный путь не является папкой' });
    }
    setSetting('workspacePath', folderPath);
    startWatcher(folderPath);
    console.log(`[scan] Рабочая папка установлена: ${folderPath}`);
    return res.json({ ok: true, folderPath });
  } catch (err) {
    console.error('Set-workspace error:', err);
    return res.status(500).json({ error: 'Ошибка при установке папки' });
  }
});

// Рекурсивный обход рабочей папки и индексация новых файлов.
// Расширения: .md, .txt, .js, .py, .json (текст → 500 символов, код → 20 строк).
const SCAN_EXT = ['md', 'txt', 'js', 'py', 'json'];
const SCAN_IGNORE = ['**/node_modules/**', '**/.git/**'];

app.get('/api/scan', async (req, res) => {
  try {
    if (scanState.running) {
      return res.status(409).json({ error: 'Сканирование уже выполняется' });
    }

    const workspace = getSetting('workspacePath');
    if (!workspace) {
      return res.status(400).json({ error: 'Сначала укажите папку в настройках' });
    }
    if (!fs.existsSync(workspace)) {
      return res.status(400).json({ error: 'Рабочая папка больше не существует' });
    }

    // Чистим дубли и переименовываем псевдопроект «Локальная папка».
    cleanupLocalFolderDuplicates();

    // Собираем все файлы нужных расширений (абсолютные пути, прямые слэши).
    const paths = fg.sync(`**/*.{${SCAN_EXT.join(',')}}`, {
      cwd: workspace,
      absolute: true,
      onlyFiles: true,
      dot: false,
      ignore: SCAN_IGNORE
    });

    scanState.running = true;
    scanState.total = paths.length;
    scanState.processed = 0;
    scanState.newIndexed = 0;
    scanState.errors = [];
    scanState.current = '';

    const errors = [];
    let newIndexed = 0;

    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      scanState.processed = i + 1;
      scanState.current = p;
      try {
        // Пропускаем уже проиндексированные файлы (по абсолютному path).
        const existing = db
          .prepare('SELECT id FROM documents WHERE path = ? LIMIT 1')
          .get(p);
        if (existing) continue;

        const [content, fileStat] = await Promise.all([
          fs.promises.readFile(p, 'utf8'),
          fs.promises.stat(p)
        ]);

        const fileName = path.basename(p);
        const ext = path.extname(p).toLowerCase();

        const result = await indexContent({
          project: localProjectName(),
          fileName,
          ext,
          fileSize: fileStat.size,
          content,
          filePath: p
        });

        if (result.saved > 0) {
          newIndexed++;
          scanState.newIndexed = newIndexed;
        }
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        errors.push({ file: p, error: msg });
        scanState.errors = errors;
      }
    }

    // Пересобираем wiki-связи, чтобы установить прямые [[ссылки]] на файлы,
    // проиндексированные раньше (независимо от порядка обхода папки).
    const wikiAdded = rebuildWikiLinks();

    scanState.running = false;
    scanState.current = '';
    console.log(
      `[scan] Готово: просканировано ${paths.length}, новых ${newIndexed}, wiki-связей ${wikiAdded}, ошибок ${errors.length}`
    );
    return res.json({ totalScanned: paths.length, newIndexed, errors });
  } catch (err) {
    scanState.running = false;
    console.error('Scan error:', err);
    return res.status(500).json({ error: friendlyError(err, 'Ошибка при сканировании папки') });
  }
});

// Прогресс фонового сканирования (опрашивается UI каждые ~500мс).
app.get('/api/scan/progress', async (req, res) => {
  return res.json({
    running: scanState.running,
    total: scanState.total,
    processed: scanState.processed,
    newIndexed: scanState.newIndexed,
    errors: scanState.errors,
    current: scanState.current,
    percent: scanState.total
      ? Math.min(100, Math.round((scanState.processed / scanState.total) * 100))
      : 0
  });
});

// Загрузка одного или нескольких файлов (multipart/form-data: поле file[] + текстовое поле project)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES }
});

app.post('/api/upload', upload.array('file'), async (req, res) => {
  try {
    // req.files — массив (upload.array), req.file — одиночный (обратная совместимость)
    const files = Array.isArray(req.files) && req.files.length
      ? req.files
      : (req.file ? [req.file] : []);

    if (files.length === 0) {
      return res.status(400).json({ error: 'Файлы не загружены (поле "file")' });
    }

    const project = (req.body.project || '').trim() || 'Без проекта';
    const results = [];
    let totalSaved = 0;

    // Подготовленные выражения (один раз, переиспользуем в цикле).
    const insertDoc = db.prepare(
      `INSERT INTO documents (project, fileName, ext, fileSize, chunkCount, doc_vector, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertChunk = db.prepare(
      `INSERT INTO chunks (id, document_id, project, fileName, chunk_index, chunkText, vector)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    for (let idx = 0; idx < files.length; idx++) {
      const f = files[idx];
      const ext = path.extname(f.originalname).toLowerCase();
      const base = { fileName: f.originalname };

      if (!SUPPORTED_EXT.has(ext)) {
        results.push({
          ...base,
          ok: false,
          error: `Неподдерживаемый тип файла "${ext}". Поддерживаются: .txt, .md, .js, .py, .json`
        });
        continue;
      }

      const content = f.buffer.toString('utf8');
      const chunks = chunkByFilename(f.originalname, content);

      // ВАЖНО: пустые чанки (пустой файл) — не тратим токены на эмбеддинги
      if (chunks.length === 0) {
        results.push({ ...base, ok: false, error: 'Файл пустой, нечего индексировать' });
        continue;
      }

      // Проверка дубликатов через БД: если файл с таким же именем И тем же
      // проектом уже загружен — пропускаем повторное индексирование, чтобы не
      // тратить токены и не плодить копии. ЛОГИКА выбора: "skip", а не перезапись.
      const existing = db
        .prepare('SELECT id FROM documents WHERE fileName = ? AND project = ? LIMIT 1')
        .get(f.originalname, project);
      if (existing) {
        results.push({
          ...base,
          ok: true,
          skipped: true,
          saved: 0,
          error: 'Файл с таким именем уже загружен в этот проект — пропущен'
        });
        continue;
      }

      const vectors = await embedTexts(chunks);

      // Усреднённый вектор документа — отдельное поле documents.doc_vector (TEXT-JSON).
      const docVector = averageVectors(vectors);

      // 1) Сначала документ (получаем его id), потом — чанки, ссылающиеся на него.
      const docResult = insertDoc.run(
        project,
        f.originalname,
        ext,
        f.size,
        chunks.length,
        JSON.stringify(docVector),
        new Date().toISOString()
      );
      const documentId = Number(docResult.lastInsertRowid);

      // 2) Чанки файла: вектор каждого чанка храним как TEXT (JSON-массив).
      const baseId = `${f.originalname}-${Date.now()}-${idx}`;
      for (let i = 0; i < chunks.length; i++) {
        insertChunk.run(
          `${baseId}-${i}`,
          documentId,
          project,
          f.originalname,
          i,
          chunks[i],
          JSON.stringify(vectors[i])
        );
      }
        // Obsidian-совместимость: теги из frontmatter и [[wiki-ссылки]].
        indexFrontmatterTags(documentId, content, ext);
        indexWikiLinks(documentId, content);
      totalSaved += chunks.length;
      results.push({ ...base, ok: true, saved: chunks.length });
    }

    const okFiles = results.filter((r) => r.ok).length;

    // Ни один файл не удалось обработать — отдаём первую ошибку, чтобы пользователь понял причину
    if (okFiles === 0) {
      const firstErr = results.find((r) => !r.ok);
      return res.status(400).json({
        error: (firstErr && firstErr.error) || 'Файл пустой, нечего индексировать'
      });
    }

    return res.status(200).json({ message: 'OK', saved: totalSaved, files: okFiles, results });
  } catch (err) {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      console.error('Upload limit error:', err.message);
      return res.status(413).json({ error: 'Файл превышает лимит 5MB' });
    }
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_COUNT') {
      console.error('Upload count error:', err.message);
      return res.status(413).json({ error: `Слишком много файлов (максимум ${MAX_FILES})` });
    }
    console.error('Upload error:', err);
    return res.status(500).json({ error: friendlyError(err, 'Ошибка при индексации файла') });
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

    // 1. Пустая база (нет ни одного чанка)
    const totalRow = db.prepare('SELECT COUNT(*) AS n FROM chunks').get();
    if (!Number(totalRow.n)) {
      return res.json({ answer: 'Нет загруженных данных', sources: [] });
    }

    // 2. Достаём чанки из SQLite через JOIN документов (векторы хранятся как
    //    TEXT-JSON → парсим позже). Если указан проект — фильтруем на уровне SQL.
    let rows;
    if (project) {
      rows = db
        .prepare(
          `SELECT c.id, c.project, c.fileName, c.chunkText, c.vector
           FROM chunks c
           JOIN documents d ON d.id = c.document_id
           WHERE d.project = ?`
        )
        .all(project);
    } else {
      rows = db
        .prepare(
          `SELECT c.id, c.project, c.fileName, c.chunkText, c.vector
           FROM chunks c
           JOIN documents d ON d.id = c.document_id`
        )
        .all();
    }
    if (rows.length === 0) {
      return res.json({ answer: 'Не нашел информации в этом проекте', sources: [] });
    }

    // 3. Эмбеддинг вопроса
    const [qVector] = await embedTexts([q]);

    // 4. Косинусное сходство + топ-3 с порогом > 0.5 (по каждому чанку)
    const scored = rows
      .map((r) => {
        const vector = r.vector ? JSON.parse(r.vector) : null;
        return { ...r, vector, score: cosineSimilarity(qVector, vector) };
      })
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

    const userPrompt = `КОНТЕКСТ (извлечён из загруженных файлов):\n${context}\n\n---\n\nВопрос пользователя: ${q}\n\nДай ответ строго на основе КОНТЕКСТА выше. Ничего не выдумывай.`;

    const answer = await generateAnswer(SYSTEM_PROMPT, userPrompt);
    const sources = top.map((c) => ({ fileName: c.fileName, chunkText: c.chunkText }));

    return res.json({ answer, sources });
  } catch (err) {
    console.error('Query error:', err);
    return res.status(500).json({ error: friendlyError(err, 'Ошибка при обработке запроса') });
  }
});

/* ------------------------------------------------------------------ *
 *  Хелперы для AI-функций (теги, связи, диаграммы)
 * ------------------------------------------------------------------ */

function parseTags(text) {
  return (text || '')
    .split(',')
    .map((t) => t.trim().replace(/^#+/, ''))
    .filter((t) => t.length > 0 && t.length <= 40)
    .slice(0, 5);
}

function fallbackTags(text) {
  const words = String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 5 && w.length <= 25);
  const stop = new Set(['который', 'которая', 'которое', 'которые', 'чтобы', 'также', 'если', 'этот', 'это', 'того', 'что', 'для', 'при']);
  const count = {};
  for (const w of words) {
    if (stop.has(w)) continue;
    count[w] = (count[w] || 0) + 1;
  }
  return Object.entries(count)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);
}

function fallbackMermaid(title) {
  const id = (String(title || 'document')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '') || 'document');
  return 'flowchart LR\n  A[' + id + ']';
}

/* ------------------------------------------------------------------ *
 *  POST /api/suggest-links — предлагает похожие документы (связи).
 *  Вычисляет косинусное сходство между doc_vector документов.
 * ------------------------------------------------------------------ */
app.post('/api/suggest-links', async (req, res) => {
  try {
    const { docId } = req.body || {};
    if (!docId) return res.status(400).json({ error: 'Не указан docId' });

    const source = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(docId));
    if (!source) return res.status(404).json({ error: 'Документ не найден' });

    const srcVector = source.doc_vector ? JSON.parse(source.doc_vector) : null;
    if (!srcVector || srcVector.length === 0) {
      return res.json({ suggestions: [], message: 'У документа нет вектора для сравнения' });
    }

    // Уже подтверждённые связи этого документа (чтобы не предлагать повторно)
    const linked = db
      .prepare(
        'SELECT target_id FROM document_relations WHERE source_id = ? UNION SELECT source_id FROM document_relations WHERE target_id = ?'
      )
      .all(Number(docId), Number(docId))
      .map((r) => Number(r.target_id || r.source_id));

    const rows = db.prepare('SELECT id, fileName, project, doc_vector FROM documents').all();
    const suggestions = [];
    for (const row of rows) {
      const id = Number(row.id);
      if (id === Number(docId)) continue;
      if (linked.includes(id)) continue;
      const v = row.doc_vector ? JSON.parse(row.doc_vector) : null;
      const score = cosineSimilarity(srcVector, v);
      if (score <= 0) continue;
      suggestions.push({
        docId: String(id),
        fileName: row.fileName,
        project: row.project,
        similarity: Math.round(score * 10000) / 100
      });
    }

    suggestions.sort((a, b) => b.similarity - a.similarity);
    return res.json({ suggestions: suggestions.slice(0, 5) });
  } catch (err) {
    console.error('Suggest-links error:', err);
    return res.status(500).json({ error: friendlyError(err, 'Ошибка при поиске связей') });
  }
});

/* ------------------------------------------------------------------ *
 *  POST /api/apply-link — сохраняет подтверждённую связь в document_relations.
 * ------------------------------------------------------------------ */
app.post('/api/apply-link', async (req, res) => {
  try {
    const { docId, targetId, similarity } = req.body || {};
    const sourceId = Number(docId);
    const target = Number(targetId);
    if (!sourceId || !target) {
      return res.status(400).json({ error: 'Не указаны docId и targetId' });
    }
    if (sourceId === target) {
      return res.status(400).json({ error: 'Нельзя связать документ с самим собой' });
    }

    const exists = db
      .prepare('SELECT id FROM document_relations WHERE source_id = ? AND target_id = ?')
      .get(sourceId, target);
    if (exists) {
      return res.json({ ok: true, alreadyExists: true });
    }

    db.prepare(
      `INSERT INTO document_relations (source_id, target_id, similarity, type, createdAt)
       VALUES (?, ?, ?, 'ai', ?)`
    ).run(sourceId, target, Number(similarity) || 0, new Date().toISOString());

    return res.json({ ok: true, alreadyExists: false });
  } catch (err) {
    console.error('Apply-link error:', err);
    return res.status(500).json({ error: friendlyError(err, 'Ошибка при сохранении связи') });
  }
});

/* ------------------------------------------------------------------ *
 *  POST /api/suggest-tags — генерирует теги через GPT по первым 3 чанкам.
 *  Сохраняет теги в tags + связывает через doc_tags (существующие переиспользует).
 * ------------------------------------------------------------------ */
app.post('/api/suggest-tags', async (req, res) => {
  try {
    const { docId } = req.body || {};
    if (!docId) return res.status(400).json({ error: 'Не указан docId' });

    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(docId));
    if (!doc) return res.status(404).json({ error: 'Документ не найден' });

    // Первые 3 чанка документа
    const chunks = db
      .prepare('SELECT chunkText FROM chunks WHERE document_id = ? ORDER BY chunk_index LIMIT 3')
      .all(Number(docId));
    const text = chunks.map((c) => c.chunkText).join('\n').slice(0, 4000);

    let tags = [];
    try {
      const userPrompt =
        'Сгенерируй 3-5 ключевых тегов (слова или короткие фразы) для следующего текста. ' +
        'Верни только теги через запятую, без номеров, кавычек и пояснений.\n\nТекст:\n' + text;
      const answer = await generateAnswer(SYSTEM_PROMPT, userPrompt);
      tags = parseTags(answer);
    } catch (err) {
      console.error('Suggest-tags (GPT) fallback:', err.message);
      tags = fallbackTags(text);
    }
    if (tags.length === 0) tags = fallbackTags(text);

    // Сохранение: тег → tags (UNIQUE), связь → doc_tags
    const insertTag = db.prepare(
      'INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING'
    );
    const insertRel = db.prepare(
      'INSERT OR IGNORE INTO doc_tags (doc_id, tag_id) VALUES (?, ?)'
    );
    const saved = [];
    for (const rawTag of tags) {
      const name = rawTag.toLowerCase();
      insertTag.run(name);
      const row = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
      if (row) {
        insertRel.run(Number(docId), Number(row.id));
        saved.push(name);
      }
    }

    return res.json({ tags: saved, filtered: Boolean(saved.length < tags.length) });
  } catch (err) {
    console.error('Suggest-tags error:', err);
    return res.status(500).json({ error: friendlyError(err, 'Ошибка при генерации тегов') });
  }
});

/* ------------------------------------------------------------------ *
 *  POST /api/generate-diagram — генерирует Mermaid-код через GPT.
 *  Принимает docId ИЛИ текст описания.
 * ------------------------------------------------------------------ */
app.post('/api/generate-diagram', async (req, res) => {
  try {
    const { docId, description } = req.body || {};

    let text = (description || '').toString().trim();
    if (!text && docId) {
      const chunks = db
        .prepare('SELECT chunkText FROM chunks WHERE document_id = ? ORDER BY chunk_index LIMIT 5')
        .all(Number(docId));
      text = chunks.map((c) => c.chunkText).join('\n').slice(0, 4000);
    }

    if (!text) return res.status(400).json({ error: 'Укажите docId или description' });

    try {
      const userPrompt =
        'Ты — архитектор. По описанию ниже создай код диаграммы в формате Mermaid ' +
        '(например, flowchart или classDiagram). Верни только код Mermaid без пояснений и без markdown-обёртки.\n\n' +
        'Описание:\n' + text;
      const answer = await generateAnswer(SYSTEM_PROMPT, userPrompt);

      let mermaid = (answer || '').trim();
      mermaid = mermaid.replace(/^```(mermaid)?\s*/i, '').replace(/```$/, '').trim();

      if (!/^(flowchart|graph|classDiagram|sequenceDiagram|stateDiagram|erDiagram|gantt)/.test(mermaid)) {
        throw new Error('Ответ модели не похож на Mermaid-код');
      }

      return res.json({ mermaid });
    } catch (err) {
      console.error('Generate-diagram (GPT) fallback:', err.message);
      return res.status(200).json({
        mermaid: fallbackMermaid(docId ? `doc_${docId}` : ''),
        fallback: true
      });
    }
  } catch (err) {
    console.error('Generate-diagram error:', err);
    return res.status(500).json({ error: friendlyError(err, 'Ошибка при генерации диаграммы') });
  }
});

// Список уникальных проектов (из таблицы документов)
app.get('/api/projects', async (req, res) => {
  try {
    const rows = db
      .prepare('SELECT DISTINCT project FROM documents ORDER BY project')
      .all();
    return res.json({ projects: rows.map((r) => r.project) });
  } catch (err) {
    console.error('Projects error:', err);
    return res.status(500).json({ error: 'Ошибка при получении проектов' });
  }
});

// Список загруженных документов для UI (docId = documents.id).
// Дополнительно отдаём path (абсолютный путь из локального сканирования) и
// расширение — они нужны для построения дерева папок на главной странице.
app.get('/api/docs', async (req, res) => {
  try {
    const rows = db
      .prepare('SELECT id, fileName, project, ext, path FROM documents ORDER BY id')
      .all();
    const documents = rows.map((r) => ({
      docId: String(r.id),
      fileName: r.fileName,
      project: r.project,
      ext: r.ext || '',
      path: r.path || ''
    }));
    return res.json({ documents });
  } catch (err) {
    console.error('Docs error:', err);
    return res.status(500).json({ error: 'Ошибка при получении списка документов' });
  }
});

// Текущая рабочая папка (workspacePath из таблицы settings). Нужна на странице
// настроек, чтобы показать пользователю уже выбранный путь.
app.get('/api/workspace', async (req, res) => {
  try {
    return res.json({ folderPath: getSetting('workspacePath') || '' });
  } catch (err) {
    console.error('Workspace error:', err);
    return res.status(500).json({ error: 'Ошибка при получении рабочей папки' });
  }
});

// Список подтверждённых связей (document_relations) с именами файлов.
// Используется фронтендом для визуализации графа зависимостей.
app.get('/api/links', async (req, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT dr.id, dr.source_id, dr.target_id, dr.similarity, dr.type,
                sd.fileName AS sourceName, td.fileName AS targetName
         FROM document_relations dr
         JOIN documents sd ON sd.id = dr.source_id
         JOIN documents td ON td.id = dr.target_id
         ORDER BY dr.id`
      )
      .all();
    const links = rows.map((r) => ({
      id: String(r.id),
      sourceId: String(r.source_id),
      targetId: String(r.target_id),
      sourceName: r.sourceName,
      targetName: r.targetName,
      similarity: Number(r.similarity) || 0,
      type: r.type || 'ai'
    }));
    return res.json({ links });
  } catch (err) {
    console.error('Links error:', err);
    return res.status(500).json({ error: 'Ошибка при получении связей' });
  }
});

/* ------------------------------------------------------------------ *
 *  Экспорт AI-связей и тегов обратно в исходный файл.
 *  Может "подменять" файл на диске после связывания и навешивания тегов.
 *  - .md  → теги пишутся в YAML Frontmatter (tags:), связи — комментарием.
 *  - прочие текстовые файлы (.txt/.js/.py/.json) — теги и связи
 *    дописываются комментарием-блоком.
 *  Работает только для файлов из локального сканирования (есть path).
 * ------------------------------------------------------------------ */

// Список сохранённых тегов документа (из tags + doc_tags).
function getDocTags(docId) {
  const rows = db
    .prepare(
      `SELECT t.name FROM tags t
       JOIN doc_tags dt ON dt.tag_id = t.id
       WHERE dt.doc_id = ? ORDER BY t.name`
    )
    .all(docId);
  return rows.map((r) => r.name);
}

// Превращает подтверждённую AI-связь в Obsidian-комментарий.
function aiLinkComment(r) {
  const targetName = path.basename(r.targetName).replace(/\.[^.]+$/, '');
  const sim = Number(r.similarity) || 0;
  const pct = sim <= 1 ? Math.round(sim * 100) : Math.round(sim);
  return `AI Suggested: связан с [[${targetName}]] (${pct}%)`;
}

// Подтверждённые AI-связи, где документ — источник.
function getAiOutgoingLinks(docId) {
  return db
    .prepare(
      `SELECT dr.target_id, dr.similarity, d.fileName AS targetName
       FROM document_relations dr
       JOIN documents d ON d.id = dr.target_id
       WHERE dr.source_id = ? AND dr.type = 'ai'`
    )
    .all(docId);
}

// Обновляет блок `tags:` в YAML Frontmatter (или создаёт его, если нет).
function setFrontmatterTags(content, tags) {
  const clean = [
    ...new Set(tags.map((t) => String(t).trim().replace(/^#/, '').toLowerCase()).filter(Boolean))
  ];
  if (!clean.length) return content;
  const tagBlock = `tags:\n${clean.map((t) => `  - ${t}`).join('\n')}`;

  const fmRe = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const m = fmRe.exec(content);
  if (!m) return `---\n${tagBlock}\n---\n` + content;

  const lines = m[1].split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^tags\s*:/.test(line)) {
      // пропускаем блок, где теги заданы построчно ("  - ...")
      i++;
      while (i < lines.length && /^\s+/m.test(lines[i])) i++;
      i--;
      continue;
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  const newFm = [...out, tagBlock].join('\n');
  return content.replace(m[0], `---\n${newFm}\n---\n`);
}

// Префикс строк-комментариев для не-Markdown-форматов.
function lineCommentPrefix(ext) {
  if (ext === '.py') return '#';
  if (ext === '.js' || ext === '.json') return '//';
  return '';
}

// Экспорт одного документа: подмена/дописывание тегов и связей в файл на диске.
function exportDocumentToFile(docId, includeTags = true) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
  if (!doc) return { ok: false, status: 404, error: 'Документ не найден' };
  if (!doc.path) {
    return { ok: false, status: 400, error: 'Файл не из локального сканирования — экспорт невозможен' };
  }
  const ext = (doc.ext || path.extname(doc.fileName)).toLowerCase();
  if (!SUPPORTED_EXT.has(ext)) {
    return { ok: false, status: 400, error: 'Экспорт доступен только для текстовых файлов' };
  }
  if (!fs.existsSync(doc.path)) {
    return { ok: false, status: 400, error: `Файл не найден на диске: ${doc.path}` };
  }

  let content = fs.readFileSync(doc.path, 'utf8');
  const linkLines = getAiOutgoingLinks(docId).map(aiLinkComment);
  const tags = includeTags ? getDocTags(docId) : [];

  // --- Теги ---
  let tagsAdded = 0;
  const existingTagSet = new Set(parseFrontmatter(content).tags.map((t) => t.toLowerCase()));
  const tagsToAdd = tags.filter((t) => !existingTagSet.has(t.toLowerCase()));
  if (ext === '.md' && tagsToAdd.length) {
    content = setFrontmatterTags(content, tags);
    tagsAdded = tagsToAdd.length;
  }

  // --- AI-связи ---
  const newLinks = linkLines.filter((l) => !content.includes(l));
  let linkAdded = 0;
  if (ext === '.md') {
    if (newLinks.length) {
      content = content.trimEnd() + '\n\nAI Suggested links\n' + newLinks.join('\n') + '\n';
      linkAdded = newLinks.length;
    }
  } else {
    // Не-MD: дописываем комментарием строки тегов и связей.
    const prefix = lineCommentPrefix(ext);
    const rows = [];
    tags.forEach((t) => rows.push(`${prefix ? prefix + ' ' : ''}AI Tag: ${t}`));
    linkLines.forEach((l) => rows.push(prefix ? `${prefix} ${l}` : l));
    const newRows = rows.filter((r) => !content.includes(r));
    if (newRows.length) {
      content = content.trimEnd() + '\n\n' + newRows.join('\n') + '\n';
      linkAdded = linkLines.filter((l) => {
        const withPrefix = prefix ? `${prefix} ${l}` : l;
        return newRows.includes(withPrefix);
      }).length;
      tagsAdded = tags.filter((t) =>
        newRows.includes(prefix ? `${prefix} AI Tag: ${t}` : `AI Tag: ${t}`)
      ).length;
    }
  }

  fs.writeFileSync(doc.path, content, 'utf8');
  return {
    ok: true,
    links: linkLines,
    tags,
    added: linkAdded,
    already: linkLines.length - linkAdded,
    linkAdded,
    tagsAdded
  };
}

// Экспорт связей и тегов: для одного docId или для всех локальных файлов сразу.
app.post('/api/export-links', async (req, res) => {
  try {
    const { docId, includeTags = true } = req.body || {};

    if (docId) {
      const result = exportDocumentToFile(Number(docId), includeTags !== false);
      if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
      return res.json(result);
    }

    const docs = db
      .prepare("SELECT id FROM documents WHERE path != '' ORDER BY id")
      .all();
    const results = [];
    let addedTotal = 0;
    let tagsAddedTotal = 0;
    let done = 0;
    for (const d of docs) {
      const r = exportDocumentToFile(Number(d.id), includeTags !== false);
      if (r.ok) {
        done++;
        addedTotal += r.linkAdded || 0;
        tagsAddedTotal += r.tagsAdded || 0;
      }
      results.push(r);
    }
    return res.json({ ok: true, done, added: addedTotal, tagsAdded: tagsAddedTotal, results });
  } catch (err) {
    console.error('Export-links error:', err);
    return res.status(500).json({ error: friendlyError(err, 'Ошибка при экспорте связей') });
  }
});

// Просмотр содержимого документа: читает файл с диска (локальное сканирование)
// или восстанавливает текст из чанков (ручная загрузка).
app.get('/api/file/content', async (req, res) => {
  try {
    const docId = Number(req.query.docId);
    if (!docId) return res.status(400).json({ error: 'Не указан docId' });

    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
    if (!doc) return res.status(404).json({ error: 'Документ не найден' });

    const hasPath = doc.path && fs.existsSync(doc.path);
    const source = hasPath ? 'disk' : 'chunks';
    let content = '';
    if (hasPath) {
      content = fs.readFileSync(doc.path, 'utf8');
    } else {
      const rows = db
        .prepare('SELECT chunkText FROM chunks WHERE document_id = ? ORDER BY chunk_index')
        .all(docId);
      content = rows.map((r) => r.chunkText).join('\n');
    }
    if (!content.trim()) {
      return res.status(404).json({ error: 'Контент файла недоступен' });
    }

    return res.json({
      fileName: doc.fileName,
      ext: doc.ext || path.extname(doc.fileName).toLowerCase(),
      source,
      size: content.length,
      content
    });
  } catch (err) {
    console.error('File content error:', err);
    return res.status(500).json({ error: friendlyError(err, 'Ошибка при чтении файла') });
  }
});

// Очистка всей базы данных (SQLite). Полезно для тестирования.
app.delete('/api/clear', async (req, res) => {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM chunks').get();
    const cleared = Number(row.n);
    clearAllFromDb();
    return res.json({ ok: true, cleared });
  } catch (err) {
    console.error('Clear error:', err);
    return res.status(500).json({ error: 'Ошибка при очистке базы данных' });
  }
});

// Статистика: количество сохранённых чанков, файлов и список уникальных проектов.
app.get('/api/stats', async (req, res) => {
  try {
    const chunkCount = Number(db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n);
    const fileCount = Number(db.prepare('SELECT COUNT(*) AS n FROM documents').get().n);
    const projects = db
      .prepare('SELECT DISTINCT project FROM documents ORDER BY project')
      .all()
      .map((r) => r.project);
    return res.json({ chunkCount, fileCount, projects });
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ error: 'Ошибка при получении статистики' });
  }
});

// Текущая конфигурация LLM.
// apiKey НЕ возвращается открыто — только маска вида "sk-…abcD".
app.get('/api/config', async (req, res) => {
  try {
    const cfg = getLLMConfig();
    const maskedApiKey = cfg.apiKey
      ? `${cfg.apiKey.slice(0, 3)}…${cfg.apiKey.slice(-4)}`
      : '';
    return res.json({
      config: {
        provider: cfg.provider,
        baseURL: cfg.baseURL,
        chatModel: cfg.chatModel,
        embeddingModel: cfg.embeddingModel,
        yandexEmbeddingModel: cfg.yandexEmbeddingModel,
        yandexFolderId: cfg.yandexFolderId,
        hasApiKey: Boolean(cfg.apiKey),
        maskedApiKey
      }
    });
  } catch (err) {
    console.error('Get config error:', err);
    return res.status(500).json({ error: 'Ошибка при получении конфигурации' });
  }
});

// Сохранение конфигурации LLM (в памяти).
// Поле apiKey в запросе НЕОБЯЗАТЕЛЬНО: если не передано или пустое,
// существующий ключ (из .env/памяти) сохраняется.
app.post('/api/config', async (req, res) => {
  try {
    const { provider, baseURL, apiKey, chatModel, embeddingModel, yandexEmbeddingModel, yandexFolderId } =
      req.body || {};

    // Провайдер можно менять; при переключении на yandex подставляем его базовый URL,
    // если пользователь не задал свой.
    if (typeof provider === 'string' && (provider === 'openai' || provider === 'yandex')) {
      const changingProvider = provider !== llmConfig.provider;
      llmConfig.provider = provider;
      if (changingProvider) {
        llmConfig.baseURL =
          provider === 'yandex' ? YANDEX_BASE : 'https://api.openai.com/v1';
      }
    }

    if (typeof baseURL === 'string' && baseURL.trim()) llmConfig.baseURL = baseURL.trim();

    if (typeof apiKey === 'string' && apiKey.trim() && apiKey !== '••••••••') {
      llmConfig.apiKey = apiKey.trim();
    }

    if (typeof chatModel === 'string' && chatModel.trim()) llmConfig.chatModel = chatModel.trim();

    if (typeof embeddingModel === 'string' && embeddingModel.trim()) {
      llmConfig.embeddingModel = embeddingModel.trim();
    }

    if (typeof yandexEmbeddingModel === 'string' && yandexEmbeddingModel.trim()) {

      llmConfig.yandexEmbeddingModel = yandexEmbeddingModel.trim();
    }

    if (typeof yandexFolderId === 'string' && yandexFolderId.trim()) {
      llmConfig.yandexFolderId = yandexFolderId.trim();
    }

    resetClient(); // пересоздаём клиент под новую конфигурацию
    return res.json({ ok: true, saved: true });
  } catch (err) {
    console.error('Save config error:', err);
    return res.status(500).json({ error: 'Ошибка при сохранении конфигурации' });
  }
});

// Подсказки по доступным моделям для UI
app.get('/api/models', async (req, res) => {
  try {
    return res.json({
      chatModels: KNOWN_CHAT_MODELS,
      embeddingModels: KNOWN_EMBEDDING_MODELS,
      yandexChatModels: YANDEX_CHAT_MODELS,
      yandexEmbeddingModels: YANDEX_EMBEDDING_MODELS
    });
  } catch (err) {
    console.error('Models error:', err);
    return res.status(500).json({ error: 'Ошибка при получении списка моделей' });
  }
});

const PORT = process.env.PORT || 3000;

// Старт сервера: сначала открываем SQLite и выполняем миграцию таблиц,
// затем начинаем слушать порт.
async function startServer() {
  openDatabase(); // миграция таблиц выполняется внутри
  // Чистим дубли «Локальная папка» и переносим её документы в проект-папку.
  cleanupLocalFolderDuplicates();
  // Если папка уже была сохранена ранее — сразу начинаем следить за её изменениями.
  const savedWorkspace = getSetting('workspacePath');
  if (savedWorkspace) {
    startWatcher(savedWorkspace);
  }
  app.listen(PORT, () => {
    console.log(`Knowledge Weaver backend listening on http://localhost:${PORT}`);
    console.log(`[db] База данных: ${DB_PATH}`);
  });
}

startServer().catch((err) => {
  console.error('Ошибка при старте сервера:', err);
  process.exit(1);
});