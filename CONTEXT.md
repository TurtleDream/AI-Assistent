# CONTEXT.md — Быстрый контекст проекта (Knowledge Weaver)

> Цель файла: мгновенно восстановить структуру, архитектуру и направленность,
> не перечитывая весь код. Это «шпаргалка» для разработки и поддержки.

---

## 1. Что за проект

**Knowledge Weaver** — MVP (v0.1) RAG-ассистент для работы с заметками и кодом.
- Пользователь грузит файлы (.txt, .md, .js, .py, .json) в «проекты» ИЛИ сканирует локальную папку (файлы индексируются в проект «Локальная папка»).
- Бэкенд нарезает на чанки → эмбеддинги → векторный поиск по косинусному сходству → ответ LLM с источниками.
- AI-функции: предложение **связей** между документами и сохранение их истории, GPT-генерация **тегов** (persist в `tags`/`doc_tags`), генерация **Mermaid-диаграмм**.
- **Obsidian-совместимость:** парсинг YAML Frontmatter (теги `tags`/`aliases` из `.md`), внутренние `[[wiki-ссылки]]` → связи типа `wiki_link` (сила 1.0), авто-переиндексация при изменении файлов (chokidar) и экспорт AI-связей обратно в `.md` (`<!-- AI Suggested: связан с [[File2]] (85%) -->`).
- **Этап 4 — нативный плагин Obsidian (`obsidian-plugin/`):** тот же функционал внутри Obsidian без бэкенда — RAG-чат по Vault с кликабельными источниками, «Find connections», «Suggest tags» (вставка в frontmatter), «Generate diagram from selection» (Mermaid). Индекс хранится в `saveData()` плагина (JSON), эмбеддинги — OpenAI-совместимый fetch (без SDK), чанкинг и косинусное сходство перенесены из бэкенда без изменений.
- Ключевая фича: деление по **проектам**, фильтр в UI + **работа с локальной файловой системой** (вместо ручного аплоада файлов).

## 2. Стек (строго соблюдать)

- **Backend:** Node ≥ 20, Express, Multer (in-memory), OpenAI SDK (`openai` npm), CORS, dotenv, **chokidar** (авто-переиндексация файлов). ESM (`"type": "module"`).
- **Frontend:** Angular 17, **standalone-компоненты**, `inject()` вместо конструктора, `HttpClient`, RxJS (`BehaviorSubject`, `takeUntil`, `finalize`). Сторонних CSS-фреймворков нет — базовый CSS.
- **Хранение векторов:** встроенный **SQLite** (`node:sqlite`, Node.js 22.5+; в 22.x нужен флаг `--experimental-sqlite`). Таблицы `documents` и `chunks`, файл `./db/knowledge.sqlite`. Вектор чанка и `doc_vector` — TEXT (JSON-строка). Косинусное сходство — самописная чистая функция.
- **Модели:** для OpenAI — `text-embedding-3-small` (эмбеддинги), `gpt-4o-mini` (ответы). Для Yandex — **своя** embedding-модель `yandexEmbeddingModel` (`text-search-doc` по умолчанию, `YANDEX_EMBEDDING_MODEL` в `.env`; НЕ OpenAI text-embedding-*!) и chat `yandexgpt-lite`. YandexGPT — отдельный адаптер.
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
│        ├─ app.component.ts/html/css (основной UI: навигация по вкладкам, все экраны)
│        ├─ folder-tree.component.ts  (рекурсивное Obsidian-подобное дерево папок)
│        ├─ knowledge.service.ts     (все API-методы + интерфейсы)
├─ obsidian-plugin/ — нативный плагин Obsidian (Этап 4, TypeScript + esbuild)
│  ├─ manifest.json     (id: knowledge-weaver-ai, isDesktopOnly: true)
│  ├─ esbuild.config.mjs, tsconfig.json, package.json (build → main.js)
│  ├─ styles.css, versions.json, README.md
│  └─ src/
│     ├─ main.ts              ← KnowledgeWeaverPlugin: команды, ribbon, контекстное меню, reindexVault()
│     ├─ settings.ts          ← KnowledgeWeaverSettings + PluginSettingTab (ключ, baseUrl, модели, расширения, topK, порог)
│     ├─ indexer.ts           ← VaultIndexer (скан Vault, инкремент по mtime), searchChunks()
│     ├─ llm.ts               ← fetch-клиент embeddings/chat/completions (OpenAI-совместимый), ragAnswer(), extractJson()
│     ├─ types.ts             ← PluginIndex {version, embeddingModel, files, chunks}, IndexChunk
│     ├─ utils.ts             ← чанкинг (500 симв./20 строк), cosineSimilarity, чистка frontmatter/wiki-ссылок
│     ├─ chat-modal.ts        ← RAG-чат Modal с кликабельными источниками
│     ├─ connections-modal.ts ← «Find connections» для активного файла
│     └─ ai-features.ts       ← TagsModal (frontmatter) + generateDiagramFromSelection (Mermaid)
```

## 4. Бэкенд — `backend/server.js`

### Хранилище записей (SQLite via `node:sqlite`)
- **SQLite** (встроенный `DatabaseSync`, Node.js 22.5+): открывается при старте сервера в `./db/knowledge.sqlite` (в 22.x требуется флаг `--experimental-sqlite`; с v23.4+ — без флага). Импорт: `import { DatabaseSync } from 'node:sqlite'`.
- **Таблица `documents`**: `id INTEGER PK AUTOINCREMENT`, `project`, `fileName`, `ext`, `fileSize`, `chunkCount`, `doc_vector TEXT` (усреднённый вектор документа, JSON-строка), `createdAt`, `path` (для локального сканирования; у ручной загрузки — пусто).
- **Таблица `chunks`**: `id TEXT PK`, `document_id INTEGER → documents(id) ON DELETE CASCADE`, `project`, `fileName`, `chunk_index`, `chunkText`, `vector TEXT` (JSON-строка вектора чанка). Индексы по `project` (обе таблицы) и `document_id`.
- **Таблица `tags`**: `id INTEGER PK AUTOINCREMENT`, `name TEXT UNIQUE` (теги, переиспользуются между документами).
- **Таблица `doc_tags`**: связь многие-ко-многим `(doc_id, tag_id)` PK из двух id.
- **Таблица `document_relations`**: история связей `{ id, source_id, target_id, similarity REAL, type TEXT ('ai'|'wiki_link'), createdAt }` (чтобы не предлагать связи повторно и отличать AI-связи от Obsidian-ссылок).
- `openDatabase()` — открывает БД и выполняет миграцию `CREATE TABLE IF NOT EXISTS` при старте.
- Поиск/фильтр по проекту — **SQL-запросами через JOIN**: `SELECT ... FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.project = ?`; векторы десериализуются через `JSON.parse`, сходство — `cosineSimilarity()`.
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
- `parseTags(text)` — парсит ответ GPT (через запятую → массив, без `#`, ≤ 5 шт).
- `fallbackTags(text)` — fallback-теги частотным анализом слов (без стоп-слов), если GPT недоступен/пуст.
- `fallbackMermaid(title)` — fallback `flowchart LR` для диаграммы, если GPT недоступен.
- `openDatabase()` — открывает SQLite и мигрирует схему; `clearAllFromDb()` — `DELETE` из `doc_tags`, `document_relations`, `tags`, `chunks`, `documents` (не только чанки!). Используется в `DELETE /api/clear`.
- **Obsidian-парсинг:** `parseFrontmatter(content)` — YAML-фазу (теги/алиасы, inline `[a,b]` и list `- a`); `parseWikiLinks(content)` — регэксп `\[\[(.*?)\]\]` (учитывает `|текст` и `#якорь`, дедуп).
- **Obsidian-индексация:** `indexFrontmatterTags(docId, content, ext)` — теги из frontmatter → `tags`/`doc_tags` (только `.md`); `indexWikiLinks(docId, content)` — `[[...]]` → `document_relations` (`type='wiki_link'`, similarity 1.0), цель по имени файла без расширения; `rebuildWikiLinks()` — пересборка wiki-связей по всем локальным `.md` после скана (идемпотентно, без API).
- **Авто-переиндексация (chokidar):** `startWatcher(folder)` / `stopWatcher()`, `reindexFile(path)` (удаляет старое состояние и индексирует заново), `removeDocumentByPath(path)` (удаление doc: связи+теги+чанки), `scheduleReindex()` / `scheduleDelete()` — дебаунс 600мс; игнор `node_modules`/`.git`; watcher стартует в `set-workspace` и при старте сервера, если папка сохранена.
- **Экспорт связей:** `exportLinksForDocument(docId)` — вставляет в конец `.md` комментарии `<!-- AI Suggested: связан с [[Имя]] (NN%) -->`, только `type='ai'`, только для файлов с `path`, идемпотентно (поиск уже существующих строк).
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
| POST | `/api/suggest-links` | `{ docId }` | `{ suggestions: [{ docId, fileName, project, similarity(%) }] }` — топ-5 похожих по `doc_vector` |
| POST | `/api/apply-link` | `{ docId, targetId, similarity? }` | `{ ok, alreadyExists }` — сохраняет связь в `document_relations` |
| POST | `/api/suggest-tags` | `{ docId }` | `{ tags: string[], filtered }` — GPT-теги по первым 3 чанкам, сохранены в `tags`+`doc_tags` |
| POST | `/api/generate-diagram` | `{ docId? , description? }` | `{ mermaid, fallback? }` — Mermaid-код от GPT |
| GET | `/api/projects` | — | `{ projects: string[] }` |
| GET | `/api/docs` | — | `{ documents: [{ docId, fileName, project, ext, path }] }` — для таблицы документов и дерева папок |
| GET | `/api/links` | — | `{ links: [{ id, sourceId, targetId, sourceName, targetName, similarity, type }] }` — связи (для графа); `type`: `'ai'` (подтверждённые) или `'wiki_link'` |
| POST | `/api/set-workspace` | `{ folderPath }` | `{ ok, folderPath }` — сохраняет рабочую папку в таблице `settings` **и запускает chokidar-watcher** |
| GET | `/api/workspace` | — | `{ folderPath }` — текущая рабочая папка (для настроек) |
| GET | `/api/scan` | — | `{ totalScanned, newIndexed, errors }` — фоновое сканирование рабочей папки; в конце пересобирает wiki-связи (`rebuildWikiLinks`) |
| GET | `/api/scan/progress` | — | `{ running, total, processed, newIndexed, errors, current, percent }` — прогресс сканирования |
| POST | `/api/export-links` | `{ docId? }` | `{ ok, added, already, done?, results?, links? }` — вставляет в конец локальных `.md` комментарии `<!-- AI Suggested: связан с [[File2]] (NN%) -->`; без `docId` — для всех локальных `.md` |
| DELETE | `/api/clear` | — | `{ ok, cleared }` — очищает всю БД (SQLite; полезно для тестирования) |
| GET | `/api/stats` | — | `{ chunkCount, fileCount, projects }` |
| GET | `/api/config` | — | `{ config: { provider, baseURL, chatModel, embeddingModel, yandexFolderId, hasApiKey, maskedApiKey } }` |
| POST | `/api/config` | `{ provider?, baseURL?, apiKey?, chatModel?, embeddingModel?, yandexFolderId? }` | `{ ok, saved }` |
| GET | `/api/models` | — | `{ chatModels, embeddingModels, yandexChatModels, yandexEmbeddingModels }` |

### Логика `/api/query`
1. Пустая база → `{ answer: "Нет загруженных данных" }`.
2. Чанки через `JOIN documents d ON d.id = c.document_id`, фильтр по `d.project` (если указан); нет чанков → «Не нашел информации в этом проекте».
3. Эмбеддинг вопроса.
4. Сортировка по сходству, топ-3 c порогом `> 0.5`; ниже порога → без вызова GPT.
5. Иначе собрать контекст → `generateAnswer(SYSTEM_PROMPT, userPrompt)` → `{ answer, sources }`.

### AI-функции (связи, теги, диаграммы)
- **`/api/suggest-links`** — `doc_vector` документа vs остальных; `cosineSimilarity`; исключает уже сохранённые в `document_relations` и сам документ; топ-5 с `similarity` в % (округл. до 2 знаков). Нет вектора → `{ suggestions: [], message }`.
- **`/api/apply-link`** — вставка в `document_relations` с `type='ai'`; защита от дублей (`alreadyExists`) и самосвязи.
- **`/api/suggest-tags`** — строки первых 3 чанков → GPT «Верни только теги через запятую» → `parseTags`; сохранение: `INSERT ... ON CONFLICT(name) DO NOTHING` (переиспользование) + `doc_tags`. GPT-ошибка/пусто → `fallbackTags`.
- **`/api/generate-diagram`** — по `docId` (первые 5 чанков) или `description` → GPT «Верни только Mermaid» → чистит ```mermaid```-обёртку и валидирует префикс; ошибка → `fallbackMermaid` с `fallback: true`.

### Обработка ошибок
- Все роуты `async/await` в `try/catch`, логируют в консоль.
- 400 неверный/пустой файл или неверный вопрос; 413 лимит 5MB на файл или > 10 файлов; 500 прочее.
- Мульти-загрузка: если часть файлов невалидна(расширение/пуст), остальные всё равно индексируются; при 100% провале отдаётся первая ошибка с 400. В ответ успех: `{ message, saved, files, results }`.
- Дубликаты при загрузке: если файл с тем же `fileName` И `project` уже есть в `globalKnowledge` — повторная индексация **пропускается** (`{ skipped: true, saved: 0 }`), чтобы не тратить токены. Логика выбора описана в коде(сейчас «skip», легко переключить на «overwrite»).
- Yandex-ошибки парсятся (`yandexHttpError`) и отдаются через `friendlyError` (регион 403, ключ 401, модель 404, лимит 429).

## 5. Фронтенд — `frontend/src/app`

### `knowledge.service.ts`
- `baseUrl = 'http://localhost:3000/api'`.
- Методы: `uploadFile(files: File[], project)` (мульти-загрузка: форма с полем `file[]`), `askQuestion(question, project)`, `getProjects()`, `getConfig()`, `saveConfig(payload)`, `getModels()`, `getDocuments()`, `getSuggestions(docId)`, `applyLink(docId, targetId, similarity)`, `getTags(docId)`, `generateDiagram(docId, description?)`, `getLinks()`, `getWorkspace()`, `setWorkspace(folderPath)`, `scanWorkspace()`, `getScanProgress()`, `exportLinks(docId?)`, `clearIndex()`.
- Экспорт интерфейсов: `Source`, `QueryResponse`, `ProjectsResponse`, `UploadResponse`, `LLMProvider ('openai'|'yandex')`, `LLMConfig`, `ConfigResponse`, `SaveConfigPayload`, `ModelsResponse`, `DocumentInfo` (+ `ext`/`path`), `DocumentsResponse`, `Suggestion`, `SuggestResponse`, `ApplyLinkResponse`, `TagsResponse`, `DiagramResponse`, `LinkInfo` (+ `type?`)/`LinksResponse`, `ExportLinkResult`/`ExportResponse`, `ClearResponse`, `WorkspaceResponse`, `SetWorkspaceResponse`, `ScanResult`, `ScanProgress`, `ScanError`.

### `app.component.ts`
- Standalone, `inject()`. Геттеры: `isLoading`, `isYandex`, `activeChatModels`, `activeEmbeddingModels`, `activeLinksSuggestions`, `activeLinksLoading`, `activeTags`, `isTagging`.
- **Навигация по вкладкам:** `activeView: 'home' | 'docs' | 'graph' | 'settings'`; `switchView()` — переключает экран и подгружает нужные данные.
- **Сканирование папки:** `workspacePath`, `isScanning`, `scanProgress`, `scanMessage`, `scanErrors`; `startScan()` + поллинг `getScanProgress()` (≈500 мс, останавливается через `scanPollStop$`).
- **Дерево папок:** `folderTree: FolderNode[]`, `buildFolderTree()` (строит из `documents[].path`, файлы без пути — в корень «Загруженные файлы»), `toggleFolder()`, `openTreeFile()` (клик по файлу → модал связей).
- **Проекты:** `projects[]`, `selectedProject` (`''` = «Все» → `project: null`), `loadProjects()`.
- **LLM-конфиг:** `showSettings`, `configLoaded`, `llmConfig`, списки моделей, `cfgProvider/baseURL/apiKey/chatModel/embeddingModel/yandexEmbeddingModel/yandexFolderId`, `isSavingConfig`, `configMessage`; `loadConfig()`, `toggleSettings()`, `saveConfig()` (ключ отправляется только при новом вводе, `••••••••` игнор).
- **Связи:** `documents`, `suggestionsByDoc`, `activeLinksDoc`, `isSuggestingDoc`, `linksError`, `linkedPairs`; `findLinks()`, `closeLinks()`, `toggleLink()` (вызывает `applyLink` на бэке), `loadConfirmedLinks()`.
- **Теги:** `activeTagsDoc`, `taggingDocId`, `tagsError`, `tagsByDoc`; `openTags()`, `closeTags()`.
- **Диаграммы:** `diagramDoc`, `isDiagramLoading`, `diagramError`, `mermaid`, `isMermaidFallback`; `generateDiagramFor()`, `closeDiagram()`, `openDiagramInWindow()`, `downloadMermaid()`, `encodeMermaid()` (base64 для mermaid.live).
- **Граф:** `graphLinks`, `isGraphLoading`, `graphMessage`; `loadGraph()`, `drawGraph()` — самописная force-симуляция на `<canvas>` (без сторонних библиотек), клик по узлу → `findLinks`. Рёбра: AI-связи — серые, `wiki_link` — зелёные пунктирные (+ легенда).
- **Экспорт связей в Obsidian:** `exportMessage`; `exportDoc(doc)` (для одного `.md`) и `exportAllLinks()` (для всех локальных `.md`) через `knowledge.exportLinks(docId?)`; после экспорта обновляются связи.
- **Настройки приложения:** `isClearing`, `clearMessage`; `saveWorkspacePath()`, `confirmClear()` (через `DELETE /api/clear`).
- **Вопрос/ответ:** `question`, `isAsking`, `answer$` (BehaviorSubject<SafeHtml>), `sources$`; `ask()`.
- `formatAnswer()` — markdown-lite: экранирует HTML → ```code``` → `<pre class="code-block">`, остальные переносы → `<br>`, затем `bypassSecurityTrustHtml`.

### `app.component.html` — структура UI
- Шапка: бренд + вкладки «🏠 Главная / 📚 Документы / 🕸️ Граф / ⚙️ Настройки» + селект проекта + кнопка «⚙️ Настройки AI».
- Панель настроек AI (`*ngIf="showSettings"`): провайдер (select), Base URL, API-ключ (password), Folder ID (только для yandex), Chat-модель + Embedding-модель (input + `datalist`), Сохранить/Закрыть, предупреждения.
- **Главная** (`*ngIf="activeView === 'home'"`): сайдбар с полем пути + «📁 Отсканировать папку» (спиннер + прогресс-бар) и рекурсивным `<app-folder-tree>` (Obsidian-стиль); основная область — textarea вопроса + «Спросить», блок «Ответ» (markdown), блок «Источники», пустое состояние.
- **Документы** (`*ngIf="activeView === 'docs'"`): таблица `documents` (файл + ext, проект, действия) с кнопками «🔗 Связать» / «🏷️ Теги» / «📊 Схема» у каждого файла + «⬇️ Экспорт» у `.md`; вверху кнопка «⬇️ Экспортировать все связи в Obsidian» и сообщение `exportMessage`.
- **Граф** (`*ngIf="activeView === 'graph'"`): `<canvas id="graph-canvas">` с force-графом связей + кнопка «Обновить» + легенда (AI-связь / Obsidian [[ссылка]]).
- **Настройки** (`*ngIf="activeView === 'settings'"`): «Рабочая папка» (смена `workspacePath` + «Сохранить папку») и «Индекс БД» (кнопка «🗑️ Очистить индекс» с `confirm`).
- Модалы: связи (спиннер, список `suggestions` с % схожести и кнопкой «Связать»/«✓ Связано»), теги (чипы `#tag`), диаграмма (код Mermaid + ссылка mermaid.live + открыть в окне + скачать `.mmd`).

### `folder-tree.component.ts`
- Standalone, рекурсивный. `@Input() nodes: FolderNode[]`, `@Output() nodeClick` (клик по файлу) и `toggle` (свернуть/развернуть папку). Экспортирует интерфейс `FolderNode { name, type: 'folder'|'file', path?, docId?, children?, expanded? }`.

## 6. Запуск / команды
- Backend: `cd backend && npm install && npm start` (порт 3000). Ключ в `.env` или через UI.
- Frontend: `cd frontend && npm install && npm start` (ng serve, порт 4200, CORS к 3000).
- Сборка фронта: `npm run build` (ng build).
- Проверка синтаксиса бэка: `node --check backend/server.js`.
- **Плагин Obsidian:** `cd obsidian-plugin && npm install && npm run build` (tsc + esbuild → `main.js`); `npm run dev` — watch. Установка: скопировать `main.js`, `manifest.json`, `styles.css` в `<Vault>/.obsidian/plugins/knowledge-weaver-ai/`, включить в настройках Obsidian, задать API-ключ, выполнить команду «Reindex vault».

## 7. Плагин Obsidian — детали
- **Команды:** `Open Knowledge Weaver` (палитра + ribbon ✨), `Reindex vault`, `Find connections for this note` (палитра, открывает модал со вставкой ссылок), `Suggest tags for this note` (ручной выбор), `Auto-tag this note` (авто-добавление тегов; палитра + контекстное меню «авто-теги»), `Generate diagram from selection` (нужно выделение).
- **Хранение:** `saveData({ index, settings })` — единый JSON: `index = { version: 1, embeddingModel, files: { path → {mtime, chunks} }, chunks: [{path, idx, text, vector}] }`. Смена embedding-модели сбрасывает индекс (векторы разных моделей несравнимы).
- **Индексация:** инкрементальная по `stat.mtime`; удалённые файлы выбрасываются; автосохранение каждые 25 файлов; батчи эмбеддингов по 8; прогресс в `Notice`.
- **RAG:** вопрос → эмбеддинг → top-K чанков по косинусному сходству (dot, эмбеддинги нормализованы) → `ragAnswer` с системным промптом против галлюцинаций → ответ + кликабельные чипсы источников (открывают файл через `workspace.getLeaf("tab").openFile`).
- **Теги:** `note-edits.ts` — `addTagsToFrontmatter()` идемпотентно создаёт/расширяет поле `tags` (создание frontmatter, перезапись `tags: [...]`, вставка при отсутствии). Ручной режим — `TagsModal` (чипы с выбором); авто-режим — `autoTagNote()` (LLM → JSON-массив → сразу в frontmatter, объединение с существующими).
- **AI-ссылки:** в модале «Find connections» у каждой связи кнопка 🔗 и кнопка «Вставить все ссылки»; в конец заметки добавляется `<!-- AI Suggested: связан с [[Заметка]] (85%) -->` (формат как у экспорта в бэкенде), повторная вставка не дублируется (`addAiLink`/`addAiLinks`).
- **Настройки:** провайдер (`openai` / `yandex`, при смене подставляются base URL и модели по умолчанию), apiKey (password), baseUrl, chatModel (`gpt-4o-mini` / `yandexgpt-lite`), embeddingModel (`text-embedding-3-small` / `text-search-doc`), yandexFolderId (виден только для Yandex, обязателен), extensions (`md, txt, js, py`), topK (1–15), minSimilarity (0–1), maxTags (1–10).
- **YandexGPT:** отдельный адаптер в `llm.ts` (как в бэкенде) — `POST /foundationModels/v1/textEmbedding|completion`, авторизация `Authorization: Api-Key <ключ>` + заголовок `x-folder-id`, `modelUri: emb://|g://<folder>/<model>/latest`. Эмбеддинги — по одному тексту (батчей нет),/latest добавляется автоматически.

## 8. Известные тонкости / грабли
- **Yandex modelUri ОБЯЗАТЕЛЬНО с `/latest`** — иначе 404 `model_not_found`.
- **Yandex baseURL** нельзя брать из OpenAI-формата; `yandexBase()` нормализует и обычно просто возвращает `https://llm.api.cloud.yandex.net`.
- **Yandex гео-блокировка** (403 `unsupported_country_region_territory`) — со стороны провайдера, нужен VPN/поддерживаемый регион.
- После правки конфигурации LLM на бэке вызывается `resetClient()` (пересоздание OpenAI-клиента).
- API-ключ в GET config не отдаётся открыто — только `hasApiKey` + `maskedApiKey`.
- `angular.json`: у serve-таргета `buildTarget` обязан быть в `options` (иначе ошибка валидации схемы).
- **`document_relations.type`** — колонка добавляется миграцией при старте (`PRAGMA table_info` + `ALTER TABLE ... ADD COLUMN`) для старых БД; новые создаются сразу с ней.
- **Watcher (chokidar):** запускается по `set-workspace` и при старте сервера (если папка сохранена). Переиндексация одного файла = удаление старого (чанки+теги+связи) → новая индексация; это требует вызова API эмбеддингов, поэтому без ключа в `.env` новые/изменённые файлы не индексируются (fallback-ошибка в лог).
- **Экспорт** работает только для `.md`-файлов из локального сканирования (есть `path`) и только для AI-связей; повторный экспорт идемпотентен (уже вставленные комментарии не дублируются).
- **Yandex-эмбеддинги требуют свою модель:** если провайдер `yandex`, а embedding-модель осталась OpenAI (`text-embedding-3-small`) — Yandex возвращает `400 unknown model` → ошибки при индексации/скане. Используется отдельная `yandexEmbeddingModel` (`text-search-doc` по умолчанию; `YANDEX_EMBEDDING_MODEL` в `.env`); в UI поле embedding-модели автоматически маппится по провайдеру。
- **LLM-конфиг хранится в памяти** — сбрасывается при рестарте бэкенда（для v0.1 допустимо**. **Записи（чанки）персистентны** — хранятся в SQLite `./db/knowledge.sqlite` и переживают рестарт; файл автогенерируется при старте.
- **Плагин:** Web Workers для эмбеддингов не внедрены (fetch-вызовы асинхронны, UI почти не блокирует); если при 1000+ файлах индексация начнёт подтормаживать — вынести эмбеддинги в Worker. Эмбеддинги OpenAI нормализованы, поэтому в `searchChunks` используется dot-произведение (= косинус); для ненормализованных провайдеров заменить на `cosineSimilarity` из `utils.ts`.