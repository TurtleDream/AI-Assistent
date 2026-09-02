# CONTEXT.md — Быстрый контекст проекта (Knowledge Weaver)

> Цель файла: мгновенно восстановить структуру, архитектуру и направленность,
> не перечитывая весь код. Это «шпаргалка» для разработки и поддержки.

---

## 1. Что за проект

**Knowledge Weaver** — MVP (v0.1) RAG-ассистент для работы с заметками и кодом.
- Пользователь грузит файлы (.txt, .md, .js, .py, .json) в «проекты» ИЛИ сканирует локальную папку (файлы индексируются в проект «Локальная папка»).
- Бэкенд нарезает на чанки → эмбеддинги → векторный поиск по косинусному сходству → ответ LLM с источниками.
- Ключевая фича: деление по **проектам**, фильтр в UI + **работа с локальной файловой системой** (вместо ручного аплоада файлов).

## 2. Стек (строго соблюдать)

- **Backend:** Node ≥ 20, Express, Multer (in-memory), OpenAI SDK (`openai` npm), CORS, dotenv. ESM (`"type": "module"`).
- **Frontend:** Angular 17, **standalone-компоненты**, `inject()` вместо конструктора, `HttpClient`, RxJS (`BehaviorSubject`, `takeUntil`, `finalize`). Сторонних CSS-фреймворков нет — базовый CSS.
- **Хранение векторов:** встроенный **SQLite** (`node:sqlite`, Node.js 22.5+; в 22.x нужен флаг `--experimental-sqlite`). Таблицы `documents` и `chunks`, файл `./db/knowledge.sqlite`. Вектор чанка и `doc_vector` — TEXT (JSON-строка). Косинусное сходство — самописная чистая функция.
- **Модели:** `text-embedding-3-small` (эмбеддинги), `gpt-4o-mini` (ответы) — для OpenAI. YandexGPT — отдельный адаптер.
- **Системный промпт** жёстко зашит в сервере (копия содержимого `agent.md`), запрет галлюцинаций + источники.

## 3. Структура файлов

```
├─ agent.md        — системный промпт AI-ассистента (зашит в server.js как SYSTEM_PROMPT)
├─ Skills.md       — инструкции и стек для агента
├─ DevNotes.md     — заметки по разработке (MVP, боли, планы)
├─ AgentHistory.md — исторический отчёт по реализованному (частично устарел, w1251)
├─ CONTEXT.md      — этот файл
├─ backend/
│  ├─ server.js        ← ВСЯ логика бэкенда (единый файл)
│  ├─ package.json     (type: module)
│  ├─ .env / .env.example
│  ├─ db/              ← SQLite: knowledge.sqlite (создаётся автоматически при старте)
├─ frontend/
│  ├─ angular.json     (browser-target и serve; buildTarget в options!)
│  ├─ tsconfig.json / tsconfig.app.json
│  ├─ package.json     (Angular 17)
│  └─ src/
│     ├─ index.html, main.ts, styles.css
│     ├─ app/
│        ├─ app.config.ts            (provideHttpClient)
│        ├─ app.component.ts/html/css (весь UI в одном standalone-компоненте)
│        ├─ knowledge.service.ts     (все API-методы + интерфейсы)
```

## 4. Бэкенд — `backend/server.js`

### Хранилище записей (SQLite via `node:sqlite`)
- **SQLite** (встроенный `DatabaseSync`, Node.js 22.5+): открывается при старте сервера в `./db/knowledge.sqlite` (в 22.x требуется флаг `--experimental-sqlite`; с v23.4+ — без флага). Импорт: `import { DatabaseSync } from 'node:sqlite'`.
- **Таблица `documents`**: `id INTEGER PK AUTOINCREMENT`, `project`, `fileName`, `ext`, `fileSize`, `chunkCount`, `doc_vector TEXT` (усреднённый вектор документа, JSON-строка), `createdAt`.
- **Таблица `chunks`**: `id TEXT PK`, `document_id INTEGER → documents(id) ON DELETE CASCADE`, `project`, `fileName`, `chunk_index`, `chunkText`, `vector TEXT` (JSON-строка вектора чанка). Индексы по `project` (обе таблицы) и `document_id`.
- `openDatabase()` — открывает БД и выполняет миграцию `CREATE TABLE IF NOT EXISTS` при старте.
- Поиск/фильтр по проекту идут **SQL-запросами** (`SELECT ... FROM chunks WHERE project = ?`); векторы десериализуются через `JSON.parse`, сходство — `cosineSimilarity()`.
- `llmConfig` + дефолты из env: `{ provider, baseURL, apiKey, chatModel, embeddingModel, yandexFolderId }`.
  - Провайдер: `'openai' | 'yandex'`.
  - OpenAI-дефолты: baseURL `https://api.openai.com/v1`, chat `gpt-4o-mini`, emb `text-embedding-3-small`.
  - Yandex-дефолты: chat `yandexgpt-lite`, emb `text-search-doc`.
- Известные модели (подсказки UI): `KNOWN_CHAT_MODELS`, `KNOWN_EMBEDDING_MODELS`, `YANDEX_CHAT_MODELS`, `YANDEX_EMBEDDING_MODELS`.
- **Мульти-загрузка:** лимит — `MAX_FILE_SIZE` (5MB на файл) и `MAX_FILES` (10 на запрос); multer через `upload.array('file')`.

### Ключевые функции
- `chunkText(text)` — по 500 символов, overlap 50.
- `chunkCode(text)` — по 20 строк (для .js/.py/.json).
- `chunkByFilename(name, text)` — выбор по расширению.
- `cosineSimilarity(a, b)` — чистая функция.
- `embedTexts(texts)` — батчи по `EMBEDDING_BATCH` (8); для yandex — по одному (`yandexEmbedOne`).
- `generateAnswer(system, user)` — выбирает `yandexChat()` или `openaiChat()` по провайдеру.
- `averageVectors(vectors)` — усреднённый вектор для `documents.doc_vector`.
- `openDatabase()` — открывает SQLite и мигрирует схему; `clearAllFromDb()` — `DELETE` из таблиц (каскадно вместе с чанками). Используется в `DELETE /api/clear`.
- Yandex-адаптер: `yandexHeaders()`, `yandexBase()`, `yandexEmbedUrl()`, `yandexChatUrl()`, `yandexChatUri()`, `yandexEmbedUri()`, `yandexHttpError(res, modelUri)`, `friendlyError(err, fallback)`.
- Endpoint: `https://llm.api.cloud.yandex.net/foundationModels/v1/{textEmbedding|completion}`.
  - modelUri формат (обязательно `/latest`!): `emb://<folder_id>/<модель>/latest`, `gpt://<folder_id>/<модель>/latest`.
  - Авторизация: header `Authorization: Api-Key <ключ>` + `x-folder-id: <folder_id>`.
  - `yandexBase()` НЕ берёт baseURL в формате OpenAI — нормализует и использует только yandex-хосты.

### Эндпоинты API
| Метод | Путь | Тело / параметры | Ответ |
|---|---|---|---|
| POST | `/api/upload` | multipart `file[]` (несколько) + field `project` (мульти-загрузка, до 10 файлов) | `{ message, saved, files, results: [{ fileName, ok, saved?, error? }] }` |
| POST | `/api/query` | `{ question, project? }` | `{ answer, sources: [{ fileName, chunkText }] }` |
| GET | `/api/projects` | — | `{ projects: string[] }` |
| DELETE | `/api/clear` | — | `{ ok, cleared }` — очищает всю БД (LevelDB + in-memory; полезно для тестирования) |
| GET | `/api/stats` | — | `{ chunkCount, fileCount, projects }` |
| GET | `/api/config` | — | `{ config: { provider, baseURL, chatModel, embeddingModel, yandexFolderId, hasApiKey, maskedApiKey } }` |
| POST | `/api/config` | `{ provider?, baseURL?, apiKey?, chatModel?, embeddingModel?, yandexFolderId? }` | `{ ok, saved }` |
| GET | `/api/models` | — | `{ chatModels, embeddingModels, yandexChatModels, yandexEmbeddingModels }` |

### Логика `/api/query`
1. Пустая база → `{ answer: "Нет загруженных данных" }`.
2. Фильтр по `project` (если указан); нет чанков → «Не нашел информации в этом проекте».
3. Эмбеддинг вопроса.
4. Сортировка по сходству, топ-3 c порогом `> 0.5`; ниже порога → без вызова GPT.
5. Иначе собрать контекст → `generateAnswer(SYSTEM_PROMPT, userPrompt)` → `{ answer, sources }`.

### Обработка ошибок
- Все роуты `async/await` в `try/catch`, логируют в консоль.
- 400 неверный/пустой файл или неверный вопрос; 413 лимит 5MB на файл или > 10 файлов; 500 прочее.
- Мульти-загрузка: если часть файлов невалидна(расширение/пуст), остальные всё равно индексируются; при 100% провале отдаётся первая ошибка с 400. В ответ успех: `{ message, saved, files, results }`.
- Дубликаты при загрузке: если файл с тем же `fileName` И `project` уже есть в `globalKnowledge` — повторная индексация **пропускается** (`{ skipped: true, saved: 0 }`), чтобы не тратить токены. Логика выбора описана в коде(сейчас «skip», легко переключить на «overwrite»).
- Yandex-ошибки парсятся (`yandexHttpError`) и отдаются через `friendlyError` (регион 403, ключ 401, модель 404, лимит 429).

## 5. Фронтенд — `frontend/src/app`

### `knowledge.service.ts`
- `baseUrl = 'http://localhost:3000/api'`.
- Методы: `uploadFile(files: File[], project)` (мульти-загрузка: форма с полем `file[]`), `askQuestion(question, project)`, `getProjects()`, `getConfig()`, `saveConfig(payload)`, `getModels()`.
- Экспорт интерфейсов: `Source`, `QueryResponse`, `ProjectsResponse`, `UploadResponse`, `LLMProvider ('openai'|'yandex')`, `LLMConfig`, `ConfigResponse`, `SaveConfigPayload`, `ModelsResponse`.

### `app.component.ts`
- Standalone, `inject()`. Геттеры: `isLoading`, `isYandex`, `activeChatModels`, `activeEmbeddingModels`.
- **Загрузка (мульти):** `selectedFiles: File[]`, `uploadProject`, `isUploading`, `uploadMessage`; `onFileSelected` (сброс `value` для повторного выбора тех же файлов), `onDrop` (мульти-drag-and-drop), `onDragOver`, `upload()`. **Важно:** флаг `isUploading` сбрасывается через `finalize()` — и на успехе, и на ошибке, иначе спиннер крутится бесконечно.
- **Проекты:** `projects[]`, `selectedProject` (`''` = «Все» → `project: null`), `loadProjects()`.
- **LLM-конфиг:** `showSettings`, `configLoaded`, `llmConfig`, списки моделей, `cfgProvider/baseURL/apiKey/chatModel/embeddingModel/yandexFolderId`, `isSavingConfig`, `configMessage`; `loadConfig()`, `toggleSettings()`, `saveConfig()` (ключ отправляется только при новом вводе, `••••••••` игнор).
- **Вопрос/ответ:** `question`, `isAsking`, `answer$` (BehaviorSubject<SafeHtml>), `sources$`; `ask()`.
- `formatAnswer()` — markdown-lite: экранирует HTML → ```code``` → `<pre class="code-block">`, остальные переносы → `<br>`, затем `bypassSecurityTrustHtml`.

### `app.component.html` — структура UI
- Шапка: лого + селект проекта («Все» + список) + кнопка «⚙️ Настройки AI».
- Панель настроек (`*ngIf="showSettings"`): провайдер (select), Base URL, API-ключ (password), Folder ID (только для yandex), Chat-модель + Embedding-модель (input + `datalist`), Сохранить/Закрыть, предупреждения.
- Сайдбар: drag-and-drop зона (мульти-файлы, список выбранных + счётчик, `multiple` на input) + кнопка выбора файлов + инпут проекта + кнопка «Загрузить» (спиннер при загрузке; `[disabled]="isUploading || !selectedFiles.length"`).
- Основная область: textarea вопроса + «Спросить» (спиннер), блок «Ответ» (markdown), блок «Источники» (файл + цитата), пустое состояние.

## 6. Запуск / команды
- Backend: `cd backend && npm install && npm start` (порт 3000). Ключ в `.env` или через UI.
- Frontend: `cd frontend && npm install && npm start` (ng serve, порт 4200, CORS к 3000).
- Сборка фронта: `npm run build` (ng build).
- Проверка синтаксиса бэка: `node --check backend/server.js`.

## 7. Известные тонкости / грабли
- **Yandex modelUri ОБЯЗАТЕЛЬНО с `/latest`** — иначе 404 `model_not_found`.
- **Yandex baseURL** нельзя брать из OpenAI-формата; `yandexBase()` нормализует и обычно просто возвращает `https://llm.api.cloud.yandex.net`.
- **Yandex гео-блокировка** (403 `unsupported_country_region_territory`) — со стороны провайдера, нужен VPN/поддерживаемый регион.
- После правки конфигурации LLM на бэке вызывается `resetClient()` (пересоздание OpenAI-клиента).
- API-ключ в GET config не отдаётся открыто — только `hasApiKey` + `maskedApiKey`.
- `angular.json`: у serve-таргета `buildTarget` обязан быть в `options` (иначе ошибка валидации схемы).
- **LLM-конфиг хранится в памяти** — сбрасывается при рестарте бэкенда（для v0.1 допустимо**. **Записи（чанки）персистентны** — хранятся в SQLite `./db/knowledge.sqlite` и переживают рестарт; файл автогенерируется при старте.