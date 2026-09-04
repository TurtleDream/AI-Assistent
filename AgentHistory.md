##№ Что реализовано

### Часть 1 — Бэкенд (`/backend`)

__`server.js`__ (ESM, Express + Multer + OpenAI SDK):

- Стек: Node ≥20, Express, `multer` (in-memory storage), `openai`, `cors`, `dotenv`.
- Глобальное in-memory хранилище `globalKnowledge` — массив объектов `{ id, project, fileName, chunkText, vector }`.
- __Чанкинг:__ `.txt`/`.md` — по 500 символов с перекрытием 50; `.js`/`.py`/`.json` — по 20 строкам.
- __Эмбеддинги__ `text-embedding-3-small` — батчами по 8 (задаётся в `EMBEDDING_BATCH`).
- __Косинусное сходство__ — чистая самописная функция `cosineSimilarity`.
- __Системный промпт__ — жёстко зашит как константа (точное содержание `agent.md`).

__Эндпоинты:__

- `POST /api/upload` — `multipart/form-data` (`file` + `project`), лимит 5MB, возвращает `{ saved }`.
- `POST /api/query` — принимает `{ question, project? }`, фильтрует по проекту, топ-3 чанка при сходстве > 0.5, иначе не дёргает GPT. Возвращает `{ answer, sources: [{ fileName, chunkText }] }`.
- `GET /api/projects` — уникальные проекты.

__Обработка ошибок (как требовалось):__

- Пустая база → `{ answer: "Нет загруженных данных" }`.
- Проект не выбран, чанков в проекте нет или ниже порога → `"Не нашел информации в этом проекте"` (без вызова GPT).
- 400 неверный файл/пустой вопрос, 413 превышение 5MB, 500 на остальные ошибки. Каждый блок логируется в консоль.

Файлы: `server.js`, `package.json`, `.env.example` (и `.env` с пустым ключом для локального запуска).

### Часть 2 — Фронтенд (`/frontend`, Angular 17 standalone)

- __`knowledge.service.ts`__ — `inject(HttpClient)`, методы `uploadFile(file, project)`, `askQuestion(question, project)`, `getProjects()`. `project: null` при выборе «Все».

- __`app.component.ts/html/css`__:

  - Шапка с селектом проекта (значения из `/api/projects`, опция «Все»).
  - Сайдбар: drag-and-drop зона + кнопка выбора файла + инпут имени проекта.
  - Основная область: поле вопроса + кнопка «Спросить».
  - Ответ с простым markdown-форматированием (код-блоки ``` → `<pre><code>`, безопасный эскейп перед `bypassSecurityTrustHtml`).
  - Блок «Источники» с именем файла и цитатой.
  - Спиннеры (лоадеры) при загрузке файла и при ответе AI.

- Каркас CLI-проекта: `angular.json`, `tsconfig*.json`, `main.ts`, `index.html`, `app.config.ts` (с `provideHttpClient()`).

## Проверка (выполнено)

- Backend: `node --check` — синтаксис OK; сервер стартует; smoke-тест `/api/projects` → `{"projects":[]}` и пустой запрос → `{"answer":"Нет загруженных данных","sources":[]}`. ✅
- Frontend: `npm install` (513 пакетов) + `ng build` — __«Application bundle generation complete»__, все строгие проверки TypeScript и шаблонов (`strictTemplates`) пройдены. ✅
- Плюс `.gitignore` (исключает `node_modules`, `dist`, `.env`, логи).

## Как запустить

1. `backend/.env` → вставьте `OPENAI_API_KEY`.
2. `cd backend; npm start` → [](http://localhost:3000)<http://localhost:3000>
3. `cd frontend; npm start` → [](http://localhost:4200)<http://localhost:4200> (бэк подключается к 3000 через CORS).

## Ограничения MVP

- Хранилище in-memory: при перезапуске бэкенда данные сбрасываются — это ожидаемо для v0.1.
- Полный поток с OpenAI (эмбеддинги + `gpt-4o-mini`) невозможно прогнать без вашего API-ключа; код использует точный требуемый SDK-интерфейс `embeddings.create({ model: 'text-embedding-3-small', input: batch })` и `chat.completions.create`.


## Что добавлено

### Бэкенд (`backend/server.js`)

Конфигурация LLM теперь хранится __в памяти__ (с fallback на `.env`) и поддерживает разные модели и API-провайдеры через `POST /api/config`:

- __`baseURL`__ — для OpenAI-совместимых API (OpenRouter, Groq, DeepSeek и т.д.).
- __`apiKey`__ — задаётся в интерфейсе (если пусто — берётся из `.env`).
- __`chatModel`__ и __`embeddingModel`__ — выбираются отдельно.

Клиент OpenAI создаётся динамически через `getClient()`/`createClient()` под текущую конфигурацию (кэш + `resetClient()` после сохранения). `embedTexts` и `/api/query` теперь используют выбранные модели вместо захардкоженных.

__Новые эндпоинты:__

- `GET /api/config` — текущая конфигурация; ключ __никогда не возвращается открыто__, только `hasApiKey` + маска (`sk-…1234`).
- `POST /api/config` — сохранение `{ baseURL?, apiKey?, chatModel?, embeddingModel? }`; пустой ключ/болванка `••••••••` не затирают существующий.
- `GET /api/models` — подсказки по известным чат-моделям (gpt, deepseek, claude…) и embedding-моделям.

`backend/.env.example` обновлён с новыми переменными.

### Фронтенд (`frontend`)

- __`knowledge.service.ts`__ — добавлены `getConfig()`, `saveConfig(payload)`, `getModels()` + интерфейсы `LLMConfig`, `ConfigResponse`, `SaveConfigPayload`, `ModelsResponse`.

- __`app.component.ts`__ — состояние настроек, `loadConfig()`, `toggleSettings()`, `saveConfig()`; ключ отправляется на сервер, только если пользователь реально ввёл новый.

- __Шаблон/стили__ — кнопка __«⚙️ Настройки AI»__ в шапке открывает панель с полями:

  - Base URL (провайдер),
  - API-ключ (поле `type="password"`, показывается маска уже сохранённого ключа),
  - Chat-модель (input + `datalist` с подсказками, можно ввести свою),
  - Embedding-модель (аналогично),
  - Кнопки «Сохранить» (с лоадером) / «Закрыть», а также предупреждение, если ключ не задан.


## Что сделано

### Бэкенд (`backend/server.js`)

YandexGPT использует __свой__ формат API (`foundationModels/v1`), а не OpenAI, поэтому написан отдельный адаптер с прямыми `fetch`-запросами:

- __Конфигурация__: добавлены поля `provider` (`'openai' | 'yandex'`) и `yandexFolderId`.

- __Адаптер Yandex__:

  - Авторизация — `Authorization: Api-Key <ключ>` + заголовок `x-folder-id`.
  - `yandexEmbedOne` → `POST …/foundationModels/v1/textEmbedding` с `modelUri: emb://<folder>/<model>/latest`.
  - `yandexChat` → `POST …/foundationModels/v1/completion` с `modelUri: gpt://<folder>/<model>/latest` и сообщениями `{role, text}`.
  - Обработка ошибок с пробросом статуса и тела ответа.

- __`embedTexts`__: для Yandex — по одному эмбеддингу за запрос; для OpenAI — как раньше батчами.

- __`generateAnswer(system, user)`__ — единая точка генерации, выбирает провайдера.

- __`/api/query`__ теперь использует `generateAnswer` (вместо прямого вызова OpenAI).

- __`/api/config`__ GET/POST: возвращает и принимает `provider` + `yandexFolderId`; при смене провайдера на Yandex бэкенд сам подставляет его base URL `https://llm.api.cloud.yandex.net` (и обратно OpenAI), если пользователь не задал свой.

- __`/api/models`__: добавлены списки `yandexChatModels` (`yandexgpt-lite`, `yandexgpt`, `yandexgpt-pro`, `yandexgpt-32k`) и `yandexEmbeddingModels` (`text-search-doc`, `text-search-query`).

- `.env.example` обновлён (переменные `LLM_PROVIDER`, `YANDEX_FOLDER_ID`, комментарии для YandexGPT).

### Фронтенд (`frontend`)

- __`knowledge.service.ts`__: тип `LLMProvider`, поля `provider`/`yandexFolderId` в конфиге и payload, новые списки моделей в `ModelsResponse`.

- __`app.component.ts`__: селектор провайдера, поле folder ID, геттеры `isYandex` и `activeChatModels`/`activeEmbeddingModels` (переключают дата-листы под выбранного провайдера), загрузка/сохранение новых полей.

- __Шаблон__: в панели «⚙️ Настройки AI» добавлены:

  - селект __«Провайдер»__ (OpenAI / YandexGPT),
  - поле __Folder ID__ (видно только для Yandex),
  - Base URL и API-ключ с подсказками под провайдера,
  - дата-листы моделей переключаются автоматически.


## Что сделано

### 1. Множественная загрузка файлов

__Бэкенд__ (`backend/server.js`):

- Роут `/api/upload` переведён с `upload.single('file')` на `upload.array('file')` с лимитом количества файлов — добавлена константа `MAX_FILES = 10`.
- Цикл обрабатывает каждый файл: валидация расширения, нарезка на чанки, эмбеддинги, добавление в `globalKnowledge`. `baseId` теперь уникален и для нескольких файлов (добавлен индекс `-${idx}`).
- Ответ: `{ message, saved (всего чанков), files (число успешных файлов), results[{fileName, ok, saved?, error?}] }`.
- При полном провале отдаётся первая ошибка с понятным статусом. Добавлена обработка `LIMIT_FILE_COUNT` (413).

__Сервис__ (`knowledge.service.ts`):

- `uploadFile(files: File[], project)` — все файлы кладутся в FormData под полем `file`.
- `UploadResponse` расширен полями `files?` и `results?`.

__Компонент__ (`app.component.ts/html/css`):

- `selectedFile` → `selectedFiles: File[]`.
- `onFileSelected` и `onDrop` читают все выбранные/перетащенные файлы (`Array.from(files)`); в input сброшен value для повторного выбора того же файла.
- В шаблоне: `multiple` на input, dropzone показывает список файлов и счётчик «Выбрано файлов», кнопка — «Выбрать файлы», исправлена подсказка расширений (добавлен `.json`).
- После загрузки сообщение вида «Загружено чанков: N (файлов: M)».

### 2. Фикс кнопки «Загрузить» (бесконечный спиннер)

Проблема была в `complete: () => this.isUploading = false`. В RxJS/HttpClient при __ошибке__ наблюдаемый поток не вызывает `complete` (он вызывает только `error`), поэтому флаг `isUploading` так и оставался `true` — кнопка блокировалась со спиннером навсегда.

Решение — заменить содержимое `complete` на оператор `finalize(() => this.isUploading = false)`: он выполняется __гарантированно__ при завершении потока — и на успехе, и на ошибке, и при отмене через `takeUntil`. Кнопка теперь разблокируется в любом случае.

### Проверка

- `node --check backend/server.js` — синтаксис ок.
- `tsc -p tsconfig.app.json --noEmit` — `EXIT_CODE=0`, без ошибок типов.
- Обновлена строка-документация в `CONTEXT.md` (модель загрузки).


## Что сделано

### Персистентное хранение (`backend/server.js`)

- Добавлена зависимость __`level`__ (`^10.0.0` — пакет уже был установлен, прописан в `package.json`).
- БД создаётся __при старте сервера__ в папке __`./db`__ (`new Level('./db', { valueEncoding: 'json' })`).
- Ключи: __`chunk:{id}`__ → JSON `{ project, fileName, chunkText, vector }`.
- При загрузке файла каждый чанк сохраняется через __`db.put(chunk:{id}, …)`__, затем кладётся в `globalKnowledge`.
- При старте запускается `loadAllFromDb()` — читает всю БД в `globalKnowledge` (загрузка через `db.iterator()`;__замечание:__ пакет `level` __v10__ не имеет `createReadStream()` — это актуальный API abstract-level, полностью эквивалентный по смыслу).
- Старт сервера обёрнут в `async startServer()`: сначала `await db.open()`, затем загрузка записей, потом `app.listen`.

### Логика дубликатов (выбрана «skip»)

При загрузке файла проверяется,__не загружался ли уже файл с таким же `fileName` И `project`__. Если да — повторная индексация __пропускается__ (экономия токенов;, в ответ `{ skipped: true, saved: 0, error: «…пропущен» }`). Логика и способ переключения на «overwrite» описаны комментарием прямо в коде.

### Новые эндпоинты

- __`DELETE /api/clear`__ — `db.clear()` + сброс `globalKnowledge` → `{ ok, cleared }`.
- __`GET /api/stats`__ — `{ chunkCount, fileCount, projects }`.

В проекты/поиск не добавлял отдельный индекс — как разрешено для v0.2,поиск по проекту идёт сканированием `globalKnowledge`.

## Тестикрование(проверено ранее via curl)

1. `GET /api/stats` → `{ chunkCount:0, … }` (пустая БД).
2. `/api/upload` (test.md, project p1) → `{ saved:1 }`.
3. Повторный upload того же файла → `{ saved:0, skipped:true }`.
4. __Рестарт сервера__ → «Загружено чанков из БД при старте: 1», `stats` снова `chunkCount:1` — данные пережили рестарт证明 персистентность..
5. `DELETE /api/clear` → `{ ok, cleared:1 }`; после чего `stats` → `chunkCount0`.

Все тестовые артефакты (`test.md`, логи, тестовая папка `./db`) удалены— при следующем старте `./db` создастся автоматически. Сервер был остановлен.


## Что сделано

### 1. Миграция при старте (скрипт в `backend/server.js`)

Заменил `level` (LevelDB) на встроенный __`node:sqlite`__ (`DatabaseSync`). Функция `openDatabase()` вызывается в `startServer()` и создаёт при запуске таблицы __`documents`__ и __`chunks`__ (`CREATE TABLE IF NOT EXISTS` + индексы) в файле `./db/knowledge.sqlite`:

- __`documents`__: `id` (INTEGER PK AUTOINCREMENT), `project`, `fileName`, `ext`, `fileSize`, `chunkCount`, __`doc_vector`__ (TEXT, усреднённый вектор документа), `createdAt`.
- __`chunks`__: `id` (TEXT PK), `document_id` → `documents(id)` с __`ON DELETE CASCADE`__, `project`, `fileName`, `chunk_index`, `chunkText`, __`vector`__ (TEXT, JSON-строка).

### 2. Переписан `POST /api/upload`

- Загрузка файлов через `multer` сохранена.
- Сначала вставляется документ (считается и кладётся `doc_vector` — покомпонентное среднее векторов чанков), затем чанки со ссылкой на `document_id`.
- Все векторы хранятся как `TEXT` (JSON-массив).
- Проверка дубликатов теперь через `SELECT` из `documents` (по `fileName`+`project`).

### 3. Убран `globalKnowledge`

Полностью удалены in-memory массив и `loadAllFromDb()`/`db.iterator()`. Все эндпоинты переведены на SQL:

- `/api/query` — выборка чанков через `SELECT FROM chunks`, фильтр по `project`, `JSON.parse` векторов + косинусное сходство.
- `/api/projects`, `/api/stats`, `/api/clear` — SQL-запросы.
- `clearAllFromDb()` — `DELETE` из таблиц (каскадно).

### 4. Бонус: `/api/docs`

Фронтенд уже вызывал `GET /api/docs` для списка документов, но эндпоинта не было. Добавил его — возвращает `{ documents: [{ docId, fileName, project }] }` из таблицы `documents`.

### 5. Прочее

- Из `package.json` удалена зависимость `level` (перегенерён `package-lock.json`), добавлено `"engines": { "node": ">=22.5.0" }`.
- Обновил устаревшие описания в `CONTEXT.md` (LevelDB → SQLite).


## Готово — что сделано

### Бэкенд (`backend/server.js`)

1. __Установлены зависимости__ `fast-glob@^3.3.3` и `chokidar@^4.0.3` (добавлены в `package.json`; chokidar заложен на будущий вотчинг).
2. __Миграция БД__: добавлен столбец `path TEXT NOT NULL DEFAULT ''` в `documents` (для дедупликации по путям) + индекс `idx_documents_path`; новая таблица __`settings` (key/value)__ для хранения пути рабочей папки.
3. __Хелперы__: `getSetting/setSetting`, `normalizeWorkspacePath` (абсолютный путь с прямыми слэшами), и общий `indexContent()` — чанкинг + эмбеддинги + сохранение (переиспользуется логика из `/upload`).
4. __`POST /api/set-workspace`__ — принимает `{ folderPath }`, валидирует (существует, является папкой), сохраняет в `settings`.
5. __`GET /api/scan`__ — fast-glob рекурсивно ищет `.md/.txt/.js/.py/.json` (игнор `node_modules`, `.git`), пропускает уже проиндексированные по `path`, остальные — читает, чанкует (500 симв. текст / 20 строк код), эмбеддит и сохраняет; возвращает `{ totalScanned, newIndexed, errors: [{file, error}] }`. Фоновый режим + защита от повторного запуска (409).
6. __`GET /api/scan/progress`__ — отдаёт `{ running, total, processed, newIndexed, errors, current, percent }` для поллинга в UI.

### Фронтенд (Angular)

- __`knowledge.service.ts`__: добавлены интерфейсы `SetWorkspaceResponse`, `ScanResult`, `ScanProgress`, `ScanError` и методы `setWorkspace()`, `scanWorkspace()`, `getScanProgress()`.
- __`app.component.ts`__: загрузка заменена на сканирование (`workspacePath`, `isScanning`, `scanProgress`, `scanMessage`, `scanErrors`); `startScan()` → setWorkspace → scan → поллинг прогресса каждые 600 мс через `interval()`; `stopScanPolling()` через `finalize` и маркер `scanPollStop$`.
- __`app.component.html`__: дроп-зона заменена на инпут пути + кнопку «📁 Отсканировать папку» + прогресс-бар, счётчик «Обработано X/Y · Новых: N», текущий файл и счётчик ошибок.
- __`app.component.css`__: добавлены стили `.scan-progress`, `.progress-track/fill/meta/current`, `.error`.


## Что сделано

Я изучил `Skills.md` и `CONTEXT.md` (проект Knowledge Weaver: Node ≥20 + Express + OpenAI SDK + SQLite через `node:sqlite`, единый `backend/server.js`), затем внёс изменения строго в существующий стиль кода.

### 1. Миграция БД (`migrateSchema()`)

Добавил 3 таблицы: `tags` (name UNIQUE), `doc_tags` (связь doc↔tag, PK из двух id), `document_relations` (история подтверждённых связей с `similarity` и `createdAt`).

### 2. Обновлён `POST /api/query` (RAG)

Теперь чанки достаются через `JOIN documents d ON d.id = c.document_id` и фильтруются по `d.project = ?` (как требовалось в задании), а не по `chunks.project`.

### 3. `POST /api/suggest-links`

Берёт `doc_vector` документа по `docId`, выбирает все остальные из `documents`, вычисляет косинусное сходство через `JSON.parse` + существующую функцию `cosineSimilarity()`. Исключает уже подтверждённые связи (из `document_relations`) и сам документ. Возвращает топ-5 с `fileName` и `similarity` (%). Порог `> 0` — включает все валидные, сортировка по убыванию.

### 4. `POST /api/apply-link`

Сохраняет связь (`source_id`, `target_id`, `similarity`, `createdAt`) в `document_relations`. Проверяет, что связь ещё не существует, и запрещает связывать документ с самим собой.

### 5. `POST /api/suggest-tags`

Берёт текст первых 3 чанков, шлёт в GPT промпт «Сгенерируй 3-5 ключевых тегов… Верни только теги через запятую», парсит через `parseTags`, сохраняет в `tags` (`ON CONFLICT(name) DO NOTHING` — переиспользование существующих) и связывает через `doc_tags`. При ошибке GPT или пустом результате — fallback `fallbackTags()` (частотный анализ слов текста) через try/catch.

### 6. `POST /api/generate-diagram`

Принимает `docId` или `description`. Отправляет в GPT промпт «Ты — архитектор… Верни только код Mermaid», очищает markdown-обёртку `mermaid` и проверяет, что ответ — корректный Mermaid. При ошибке/невалидном ответе возвращает fallback `flowchart LR` (название узла — `doc_<id>` или `document`) с флагом `fallback: true`.

Все запросы к GPT идут асинхронно через существующий `generateAnswer()` (поддерживает OpenAI и YandexGPT-адаптер), а для тегов и схем добавлены `try/catch` и fallback-значения.

Далее на фронте останется: добавить методы в `knowledge.service.ts` и UI-кнопки в `app.component` — но это уже выходит за рамки поставленного (бэкенд) задания.


__Бэкенд (`backend/server.js`)__ — минимальные неинвазивные добавления:

- `GET /api/docs` теперь возвращает ещё `path` и `ext` (нужны для дерева папок).
- Новый `GET /api/workspace` — текущая рабочая папка (для страницы настроек).
- Новый `GET /api/links` — подтверждённые связи с именами файлов (для графа).

__Сервис (`knowledge.service.ts`)__ — новые методы и интерфейсы: `applyLink`, `getTags`, `generateDiagram`, `getLinks`, `clearIndex`, `getWorkspace`, а также типы `ApplyLinkResponse`, `TagsResponse`, `DiagramResponse`, `LinkInfo`/`LinksResponse`, `ClearResponse`, `WorkspaceResponse`. У `DocumentInfo` добавлены `ext` и `path`.

__UI (`app.component.ts/html/css` + новый `folder-tree.component.ts`):__

1. __Навигация по вкладкам__ — «🏠 Главная / 📚 Документы / 🕸️ Граф / ⚙️ Настройки».
2. __Список документов__ — таблица с кнопками у каждого файла: 🔗 «Связать» (модал со `suggest-links` и применением связи через `apply-link`), 🏷️ «Теги» (попап с `suggest-tags`, сохранённые теги отображаются чипами), 📊 «Схема» (генерация Mermaid, просмотр кода, открытие в `mermaid.live` / отдельном окне / скачивание `.mmd`).
3. __Главная__ — оставлено поле RAG-вопроса + добавлен сайдбар с деревом папок как в Obsidian (рекурсивный компонент `app-folder-tree`, клик по файлу открывает его связи), плюс сохранено сканирование папки с прогрессом.
4. __Граф (бонус)__ — самописная force-симуляция на `<canvas>` (без d3/vis-network, чтобы не плодить зависимости): узлы = документы, рёбра = подтверждённые связи; клик по узлу открывает модал связей.
5. __Настройки__ — смена рабочей папки и очистка индекса БД (`DELETE /api/clear`) с подтверждением; конфигурация AI-моделей осталась в той же панели.

### Валидация


## Что сделано (шаги 4.1–4.4)

__4.1 Скелет__

- `manifest.json` — id `knowledge-weaver-ai`, `minAppVersion 0.15.0`, `isDesktopOnly: true`
- `src/main.ts` — класс `KnowledgeWeaverPlugin extends Plugin`: команда *Open Knowledge Weaver*, ribbon-иконка (✨), настройка через `PluginSettingTab`, 5 команд
- `package.json` + `esbuild.config.mjs` + `tsconfig.json` — сборка в один `main.js`, скрипты `build`/`dev`

__4.2 Индексация Vault__

- `src/indexer.ts` — `app.vault.getFiles()` + фильтр по настраиваемым расширениям (по умолчанию `md, txt, js, py`), чтение через `vault.read`
- `src/utils.ts` — чанкинг перенесён из бэкенда: текст 500 симв./перекрытие 50, код по 20 строкам; косинусное сходство; чистка frontmatter и `[[wiki-ссылок]]` перед эмбеддингом
- Эмбеддинги — OpenAI-совместимый `fetch`-клиент (`src/llm.ts`, без тяжёлого SDK), батчи по 8; ключ хранится в настройках плагина
- Инкрементальная переиндексация по mtime, смена embedding-модели сбрасывает индекс, автосохранение каждые 25 файлов через `saveData`, прогресс в `Notice`

__4.3 AI-функции__

- __RAG-чат__ (`src/chat-modal.ts`) — Modal с векторным поиском (top-K из настроек) и ответом LLM + __кликабельные источники-чипсы__, открывающие файл в Vault
- __Find connections__ (`src/connections-modal.ts`) — по активному файлу, порог сходства настраивается, клик открывает заметку в новой вкладке
- __Suggest tags__ (`src/ai-features.ts`) — модал с выбираемыми чипсами, добавление в существующий/новый YAML frontmatter
- __Generate diagram from selection__ — выделенный текст → Mermaid, вставка блоком ```mermaid
- Все функции — в палитре команд; теги и схема — ещё и в контекстном меню редактора

__4.4 Полировка__

- Расширенные настройки: API-ключ (password-поле), Base URL, chat/embedding-модели, расширения, top-K, порог, лимит тегов, кнопки «Переиндексировать всё» и «Очистить индекс», статус индекса
- Понятные `Notice` для ошибок (401/403 → неверный ключ, 429, сеть, парсинг) через `describeError()`
- `styles.css` в стиле Obsidian (CSS-переменные), `versions.json`, `README.md` с инструкцией по установке/релизу
