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
 *  Глобальное in-memory хранилище векторов.
 *  Каждый объект: { id, project, fileName, chunkText, vector }
 *  ВАЖНО: при перезапуске сервера данные сбрасываются (для MVP OK).
 * ------------------------------------------------------------------ */
const globalKnowledge = [];

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
  return `emb://${llmConfig.yandexFolderId || '${folder}'}/${llmConfig.embeddingModel}/latest`;
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
 *  Роуты
 * ------------------------------------------------------------------ */

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

      const vectors = await embedTexts(chunks);

      const baseId = `${f.originalname}-${Date.now()}-${idx}`;
      chunks.forEach((chunk, i) => {
        globalKnowledge.push({
          id: `${baseId}-${i}`,
          project,
          fileName: f.originalname,
          chunkText: chunk,
          vector: vectors[i]
        });
      });
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

    const userPrompt = `КОНТЕКСТ (извлечён из загруженных файлов):\n${context}\n\n---\n\nВопрос пользователя: ${q}\n\nДай ответ строго на основе КОНТЕКСТА выше. Ничего не выдумывай.`;

    const answer = await generateAnswer(SYSTEM_PROMPT, userPrompt);
    const sources = top.map((c) => ({ fileName: c.fileName, chunkText: c.chunkText }));

    return res.json({ answer, sources });
  } catch (err) {
    console.error('Query error:', err);
    return res.status(500).json({ error: friendlyError(err, 'Ошибка при обработке запроса') });
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
    const { provider, baseURL, apiKey, chatModel, embeddingModel, yandexFolderId } =
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
app.listen(PORT, () => {
  console.log(`Knowledge Weaver backend listening on http://localhost:${PORT}`);
});