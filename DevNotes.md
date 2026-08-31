# DEV_NOTES.md — AI-ассистент для заметок

## Контекст проекта
- **Проблема:** Мои заметки (текст, код, .md) разбросаны по проектам. Я трачу время на поиск связей между ними и не могу быстро получить ответ на вопросы, заметки теряются, не появляются все связи.
- **Решение:** Веб-приложение (в перспективе — расширение для VSCode/Obsidian), которое индексирует мои файлы, ищет смысловые связи через RAG и отвечает на вопросы, показывая источники.
- **Ключевая фича:** Деление по **проектам** и возможность задавать вопросы в разрезе конкретного проекта.

---

## v0.1 (MVP) — «Просто работает»
**Цель:** Заставить поток данных пройти от загрузки файла до ответа AI. Минимальный интерфейс.

## Что реализовано

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
