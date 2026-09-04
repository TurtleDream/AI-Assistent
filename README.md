# Knowledge Weaver

AI-ассистент (RAG) для работы с заметками и кодом — в виде веб-приложения и как нативный плагин для Obsidian.

## Как это работает

1. Файлы (`.md`, `.txt`, `.js`, `.py`, `.json`) загружаются вручную, сканируются с диска (веб-версия) или берутся прямо из Vault (плагин).
2. Текст нарезается на чанки: текстовые файлы — по 500 символов с перекрытием 50, код — по 20 строк.
3. Чанки превращаются в эмбеддинги (`text-embedding-3-small` или совместимая модель).
4. По вопросу считается косинусное сходство, топ-чанки отправляются в LLM (`gpt-4o-mini`, DeepSeek, YandexGPT и др.) вместе с вопросом.
5. Ответ возвращается со ссылками на источники. Запрет галлюцинаций зашит в системный промпт (`agent.md`).

## Функции

- **RAG-чат** — вопросы по своей базе знаний с указанием источников.
- **Поиск связей** — AI предлагает похожие документы; связи сохраняются и экспортируются в Obsidian (`<!-- AI Suggested: связан с [[File2]] (85%) -->`).
- **Генерация тегов** — предложения добавляются в `tags` frontmatter.
- **Mermaid-диаграммы** — из текста заметки.
- **Obsidian-совместимость** — YAML frontmatter, `[[wiki-ссылки]]`, force-граф связей.

## Состав репозитория

| Папка | Что это |
|---|---|
| `backend/` | Node.js + Express + SQLite (`node:sqlite`), вся логика в `server.js` |
| `frontend/` | Angular 17 (standalone), UI: чат, документы, граф, настройки |
| `obsidian-plugin/` | Нативный плагин Obsidian (TypeScript + esbuild) — весь функционал внутри Vault без бэкенда |

## Запуск

### Веб-версия
```bash
cd backend && npm install && npm start     # порт 3000, ключ API в .env или через UI
cd frontend && npm install && npm start    # порт 4200
```

### Плагин Obsidian
```bash
cd obsidian-plugin && npm install && npm run build
```
Скопируйте `main.js`, `manifest.json`, `styles.css` в `<Vault>/.obsidian/plugins/knowledge-weaver-ai/`, включите плагин в настройках Obsidian, укажите API-ключ и выполните команду **Knowledge Weaver: Reindex vault**.

Подробнее — [obsidian-plugin/README.md](obsidian-plugin/README.md) и [CONTEXT.md](CONTEXT.md) (полная техническая шпаргалка по архитектуре).
