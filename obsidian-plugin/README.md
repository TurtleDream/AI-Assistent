# Knowledge Weaver AI (плагин для Obsidian)

AI-ассистент внутри Obsidian: RAG-чат по вашему Vault, поиск связей между заметками, генерация тегов и Mermaid-схем. Перенос функционала веб-приложения AI-Assistent (Angular + Express) в нативный плагин.

## Возможности

- **RAG-чат** (`Open Knowledge Weaver`): вопрос → векторный поиск по чанкам всех заметок Vault → ответ LLM с кликабельными источниками (открывают файл).
- **Find connections for this note**: находит похожие заметки по косинусному сходству с настраиваемым порогом; найденные связи можно вставить в заметку по одной (🔗) или все сразу — в формате `<!-- AI Suggested: связан с [[Заметка]] (85%) -->` без дублей.
- **Suggest tags for this note**: LLM предлагает теги, выбранные добавляются в YAML frontmatter.
- **Auto-tag this note**: предлагает теги и сразу сам добавляет их в frontmatter (объединяя с существующими).
- **Generate diagram from selection**: выделенный текст → Mermaid-код, вставляется в заметку.
- **Индексация Vault**: `.md`/`.txt` — чанки по 500 символов (перекрытие 50), код — по 20 строк; расширения настраиваются. Инкрементальная переиндексация по mtime, автосохранение прогресса.
- **Настройки**: провайдер (OpenAI-совместимый / YandexGPT), API-ключ, Base URL, chat- и embedding-модель, **Folder ID для Yandex Cloud** (виден при выборе YandexGPT), расширения, top-K, порог сходства, кнопки «Переиндексировать всё» и «Очистить индекс».

## Установка (разработка)

1. Соберите плагин: `npm install && npm run build` в этой папке.
2. Скопируйте в Vault файлы `main.js`, `manifest.json`, `styles.css`:
   `<Vault>/.obsidian/plugins/knowledge-weaver-ai/`
3. Перезапустите Obsidian → Настройки → Сторонние плагины → включите **Knowledge Weaver AI**.
4. В настройках плагина укажите API-ключ (и Base URL, если используете не OpenAI).
5. Выполните команду **Knowledge Weaver: Reindex vault** (Ctrl/Cmd+P).

Для разработки: `npm run dev` — watch-режим; папку можно подключить в Vault симлинком:
`mklink /D "<Vault>\.obsidian\plugins\knowledge-weaver-ai" "<путь>\obsidian-plugin"`

## Команды

| Команда | Где доступна |
|---|---|
| Open Knowledge Weaver | Палитра, лента (✨ иконка) |
| Reindex vault | Палитра, настройки |
| Find connections for this note | Палитра (модал: открыть / вставить ссылки) |
| Suggest tags for this note | Палитра (ручной выбор тегов) |
| Auto-tag this note | Палитра, контекстное меню редактора (теги сразу в заметку) |
| Generate diagram from selection | Палитра, контекстное меню редактора |

## Сборка и релиз

- `npm run build` → `main.js` (esbuild, минификация).
- Публикация в сообществе Obsidian: обновить `version` в `manifest.json` и `package.json`, добавить запись в `versions.json`, создать GitHub Release с файлами `manifest.json`, `main.js`, `styles.css`.
