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
