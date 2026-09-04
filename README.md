# Knowledge Weaver

**Knowledge Weaver** — MVP (v0.1) RAG-ассистента для работы с заметками и кодом. Пользователь загружает файлы (`.txt`, `.md`, `.js`, `.py`, `.json`) в «проекты» либо сканирует локальную папку; бэкенд нарезает документы на чанки, считает эмбеддинги, выполняет векторный поиск по косинусному сходству и формирует ответ LLM с указанием источников.

## Возможности

- 📂 **Загрузка файлов и сканирование локальных папок** — индексация в проекты, авто-переиндексация изменённых файлов (chokidar).
- 🔍 **RAG-поиск** — чанкинг → эмбеддинги (`text-embedding-3-small` / Yandex `text-search-doc`) → косинусный поиск → ответ LLM с цитатами-источниками.
- 🔗 **AI-связи** — предложение связей между документами с историей; экспорт связей обратно в `.md` (комментарии `<!-- AI Suggested: ... -->`).
- 🏷️ **AI-теги** — генерация тегов через GPT с сохранением в БД (`tags` / `doc_tags`).
- 📊 **Mermaid-диаграммы** — генерация схем по содержимому заметок, экспорт `.mmd` / mermaid.live.
- 🕸️ **Граф связей** — force-граф на canvas с легендой (AI-связь / Obsidian `[[wiki-ссылка]]`).
- 📝 **Obsidian-совместимость** — парсинг YAML Frontmatter (теги, aliases), внутренних `[[wiki-ссылок]]`, Obsidian-подобное дерево папок.

## Стек

| Слой | Технологии |
|---|---|
| Backend | Node.js ≥ 22.5, Express, Multer, OpenAI SDK, CORS, dotenv, chokidar, fast-glob (ESM) |
| Frontend | Angular 17 (standalone-компоненты, `inject()`, `HttpClient`, RxJS) |
| Хранилище | Встроенный SQLite (`node:sqlite`, `DatabaseSync`), файл `backend/db/knowledge.sqlite` |
| LLM | OpenAI (`gpt-4o-mini`) или YandexGPT (`yandexgpt-lite`) — переключается в UI/`.env` |

## Структура проекта

```
├─ agent.md           — системный промпт AI-ассистента (зашит в server.js)
├─ CONTEXT.md         — быстрая шпаргалка по архитектуре проекта
├─ backend/
│  ├─ server.js       — вся логика бэкенда (единый файл)
│  ├─ package.json    (type: module, Node ≥ 22.5)
│  ├─ .env.example
│  └─ db/             — SQLite-база (создаётся автоматически при старте)
└─ frontend/
   ├─ package.json    (Angular 17)
   └─ src/
      ├─ app/
      │  ├─ app.component.*     — основной UI (вкладки: Главная, Документы, Граф, Настройки)
      │  ├─ folder-tree.component.ts — рекурсивное дерево папок
      │  └─ knowledge.service.ts     — все API-методы + интерфейсы
      └─ main.ts, index.html, styles.css
```

## Запуск

Требуется **Node.js ≥ 22.5** (для `node:sqlite`; на Node 22.x дополнительно нужен флаг `--experimental-sqlite`, с 23.4+ — без флага).

### Backend

```bash
cd backend
npm install
cp .env.example .env   # при необходимости заполните ключи
npm start              # порт 3000
```

Проверка синтаксиса: `node --check backend/server.js`.

### Frontend

```bash
cd frontend
npm install
npm start              # ng serve, порт 4200, обращается к бэку на :3000
```

Сборка: `npm run build` (ng build). После сборки откройте `http://localhost:4200`.

### Настройка LLM

Ключ API можно задать в `backend/.env` **или** прямо в интерфейсе (вкладка «Настройки»): провайдер (OpenAI / Yandex), Base URL, API-ключ, Folder ID (для Yandex), chat- и embedding-модели.

Переменные `.env` (см. `backend/.env.example`):

- `OPENAI_API_KEY` — ключ OpenAI или Yandex Cloud;
- `LLM_PROVIDER` — `openai` (в т.ч. OpenAI-совместимые: Groq, OpenRouter, DeepSeek) или `yandex`;
- `OPENAI_BASE_URL` — Base URL для OpenAI-совместимых API;
- `OPENAI_CHAT_MODEL` / `OPENAI_EMBEDDING_MODEL` — модели (по умолчанию `gpt-4o-mini` и `text-embedding-3-small`; для Yandex — `yandexgpt-lite` и `text-search-doc`);
- `YANDEX_FOLDER_ID`, `YANDEX_EMBEDDING_MODEL` — параметры Yandex Cloud;
- `PORT` — порт бэкенда (по умолчанию 3000).

## Архитектура (кратко)

1. Файлы загружаются (Multer, in-memory) или сканируются с диска (fast-glob + chokidar для слежения).
2. Текст нарезается на чанки, для каждого считается эмбеддинг; чанки и векторы (JSON-строки) хранятся в SQLite (`documents`, `chunks`).
3. На вопрос пользователя выполняется косинусный поиск по чанкам, лучшие фрагменты передаются в LLM вместе с системным промптом (запрет галлюцинаций + обязательные источники).
4. Дополнительно: связи документов (`document_relations`, включая `type` для Obsidian `wiki_link`), теги, Mermaid-схемы, экспорт связей в `.md`.

## Известные особенности

- **YandexGPT**: `modelUri` обязан содержать `/latest` (иначе 404 `model_not_found`); для Yandex используется отдельная embedding-модель `text-search-doc` — если оставить OpenAI-модель, API вернёт `400 unknown model`; возможна гео-блокировка (403) со стороны провайдера.
- **Конфигурация LLM хранится в памяти** и сбрасывается при рестарте бэкенда; записи (чанки) персистентны в SQLite.
- API-ключ не отдаётся в открытом виде через конфиг — только маскированный.
- Экспорт связей в Obsidian работает только для `.md`-файлов из локального сканирования; повторный экспорт идемпотентен.
- Авто-переиндексация изменённых файлов требует действующего API-ключа (вызов эмбеддингов).
