import { requestUrl } from "obsidian";
import { AIResponse } from "./types";

/**
 * Клиент LLM-провайдеров через Obsidian requestUrl (обходит CORS, в отличие от fetch).
 *  - OpenAI-совместимые: OpenAI, DeepSeek, OpenRouter, Groq и т.д.
 *  - YandexGPT: собственный формат foundationModels/v1 (как Яндекс-адаптер в бэкенде).
 */

export interface LLMConfig {
  provider: "openai" | "yandex";
  apiKey: string;
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  /** Folder ID Yandex Cloud — обязателен для YandexGPT (входит в modelUri). */
  yandexFolderId: string;
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

/** Единая обёртка над requestUrl. Бросает понятную ошибку с HTTP-статусом и телом. */
async function apiRequest(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  what: string
): Promise<unknown> {
  let res;
  try {
    res = await requestUrl({
      url,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e) {
    // Сетевой уровень: DNS, прокси, обрыв соединения.
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Сетевая ошибка при обращении к ${what}: ${msg}`);
  }
  if (res.status >= 400) {
    const text = res.text.slice(0, 300);
    throw new Error(`${what}: HTTP ${res.status} ${text}`);
  }
  return res.json;
}

/* ------------------------------ YandexGPT адаптер ------------------------------ */

function yandexHeaders(cfg: LLMConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Api-Key ${cfg.apiKey}`,
    // Дублируем folder в заголовке, как в бэкенд-адаптере.
    "x-folder-id": cfg.yandexFolderId,
  };
}

/** Yandex-эмбеддинг ОДНОГО текста: POST …/foundationModels/v1/textEmbedding. */
async function yandexEmbedOne(cfg: LLMConfig, text: string): Promise<number[]> {
  const modelUri = `emb://${cfg.yandexFolderId}/${cfg.embeddingModel}/latest`;
  const json = (await apiRequest(
    joinUrl(cfg.baseUrl, "/foundationModels/v1/textEmbedding"),
    yandexHeaders(cfg),
    { modelUri, text },
    "Yandex эмбеддинги"
  )) as { embedding: number[] };
  return json.embedding;
}

/** Yandex chat completion: POST …/foundationModels/v1/completion. */
async function yandexChat(
  cfg: LLMConfig,
  systemPrompt: string,
  userMessage: string,
  temperature: number
): Promise<string> {
  const modelUri = `gpt://${cfg.yandexFolderId}/${cfg.chatModel}/latest`;
  const json = (await apiRequest(
    joinUrl(cfg.baseUrl, "/foundationModels/v1/completion"),
    yandexHeaders(cfg),
    {
      modelUri,
      completionOptions: { temperature, maxTokens: 2000 },
      messages: [
        { role: "system", text: systemPrompt },
        { role: "user", text: userMessage },
      ],
    },
    "YandexGPT"
  )) as { result: { alternatives: { message: { text: string } }[] } };
  return json.result?.alternatives?.[0]?.message?.text?.trim() ?? "";
}

/* ------------------------------ Единый интерфейс ------------------------------ */

/** Один batch эмбеддингов. Возвращает массив векторов в порядке input. */
export async function embedBatch(cfg: LLMConfig, texts: string[]): Promise<number[][]> {
  if (cfg.provider === "yandex") {
    // Yandex не поддерживает батч — отправляем последовательно.
    const out: number[][] = [];
    for (const t of texts) out.push(await yandexEmbedOne(cfg, t));
    return out;
  }
  const json = (await apiRequest(
    joinUrl(cfg.baseUrl, "/embeddings"),
    {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    { model: cfg.embeddingModel, input: texts },
    "Эмбеддинги"
  )) as { data: { embedding: number[]; index: number }[] };
  // сортируем по index на случай, если сервер вернул в другом порядке
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/** Chat completion с системным промптом и пользовательским сообщением. */
export async function chatCompletion(
  cfg: LLMConfig,
  systemPrompt: string,
  userMessage: string,
  temperature = 0.3
): Promise<string> {
  if (cfg.provider === "yandex") {
    return yandexChat(cfg, systemPrompt, userMessage, temperature);
  }
  const json = (await apiRequest(
    joinUrl(cfg.baseUrl, "/chat/completions"),
    {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    {
      model: cfg.chatModel,
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    },
    "LLM"
  )) as { choices: { message: { content: string } }[] };
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

/** Ответ на вопрос по контексту чанков (RAG). */
export async function ragAnswer(
  cfg: LLMConfig,
  question: string,
  contextChunks: string[],
  sources: string[]
): Promise<AIResponse> {
  const system = [
    "Ты — ассистент Knowledge Weaver внутри Obsidian. Отвечай ТОЛЬКО на основе предоставленного контекста из заметок пользователя.",
    "Если ответа нет в контексте — скажи: «В ваших заметках нет информации по этому вопросу». Никогда не выдумывай факты.",
    "Отвечай кратко и по существу, уместно используй Markdown.",
    "В конце, если использовал контекст, добавь раздел «Источники:» со списком путей.",
  ].join(" ");

  const context = contextChunks
    .map((c, i) => `[Чанк ${i + 1} | источник: ${sources[i]}]\n${c}`)
    .join("\n\n---\n\n");

  const answer = await chatCompletion(cfg, system, `Контекст:\n${context}\n\nВопрос: ${question}`);
  return { answer };
}

/** JSON-ответ от LLM (снимает markdown-обёртки ```json ... ```). */
export function extractJson(raw: string): unknown {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  if (start > 0) s = s.slice(start);
  const end = Math.max(s.lastIndexOf("]"), s.lastIndexOf("}"));
  if (end !== -1) s = s.slice(0, end + 1);
  return JSON.parse(s);
}
