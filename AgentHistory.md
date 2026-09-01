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
