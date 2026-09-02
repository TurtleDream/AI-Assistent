import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export interface Source {
  fileName: string;
  chunkText: string;
}

export interface QueryResponse {
  answer: string;
  sources: Source[];
}

export interface ProjectsResponse {
  projects: string[];
}

export interface UploadResponse {
  message: string;
  saved: number;
  /** Количество успешно обработанных файлов. */
  files?: number;
  /** Результат по каждому файлу (при частичном успехе/ошибках). */
  results?: Array<{ fileName: string; ok: boolean; saved?: number; error?: string }>;
}

export type LLMProvider = 'openai' | 'yandex';

export interface LLMConfig {
  provider: LLMProvider;
  baseURL: string;
  chatModel: string;
  embeddingModel: string;
  yandexFolderId: string;
  hasApiKey: boolean;
  maskedApiKey: string;
}

export interface ConfigResponse {
  config: LLMConfig;
}

export interface SaveConfigPayload {
  provider?: LLMProvider;
  baseURL?: string;
  apiKey?: string;
  chatModel?: string;
  embeddingModel?: string;
  yandexFolderId?: string;
}

export interface ModelsResponse {
  chatModels: string[];
  embeddingModels: string[];
  yandexChatModels: string[];
  yandexEmbeddingModels: string[];
}

// --- Интеллектуальные связи между файлами ---
export interface DocumentInfo {
  docId: string;
  fileName: string;
  project: string;
  /** Расширение файла (.md, .js и т.д.). */
  ext?: string;
  /** Абсолютный путь (для файлов из локального сканирования; у ручной загрузки пусто). */
  path?: string;
}

export interface DocumentsResponse {
  documents: DocumentInfo[];
}

export interface Suggestion {
  docId: string;
  fileName: string;
  project?: string;
  similarity: number;
}

export interface DocSuggestions {
  docId: string;
  fileName: string;
  suggested: Suggestion[];
}

export interface SuggestResponse {
  docId?: string;
  suggestions?: Suggestion[];
  all?: DocSuggestions[];
}

export interface ApplyLinkResponse {
  ok: boolean;
  alreadyExists?: boolean;
}

// --- Теги ---
export interface TagsResponse {
  tags: string[];
  filtered?: boolean;
}

// --- Диаграммы (Mermaid) ---
export interface DiagramResponse {
  mermaid: string;
  fallback?: boolean;
}

// --- Граф связей ---
export interface LinkInfo {
  id: string;
  sourceId: string;
  targetId: string;
  sourceName: string;
  targetName: string;
  similarity: number;
}

export interface LinksResponse {
  links: LinkInfo[];
}

// --- Очистка индекса ---
export interface ClearResponse {
  ok: boolean;
  cleared: number;
}

// --- Рабочая папка ---
export interface WorkspaceResponse {
  folderPath: string;
}

// --- Работа с локальной файловой системой ---
export interface SetWorkspaceResponse {
  ok: boolean;
  folderPath: string;
}

export interface ScanError {
  file: string;
  error: string;
}

export interface ScanResult {
  totalScanned: number;
  newIndexed: number;
  errors: ScanError[];
}

export interface ScanProgress {
  running: boolean;
  total: number;
  processed: number;
  newIndexed: number;
  errors: ScanError[];
  current: string;
  percent: number;
}

@Injectable({ providedIn: 'root' })
export class KnowledgeService {
  private http = inject(HttpClient);
  private baseUrl = 'http://localhost:3000/api';

  /** Загрузка одного или нескольких файлов в проект (multipart/form-data). */
  uploadFile(files: File[], project: string): Observable<UploadResponse> {
    const formData = new FormData();
    files.forEach((f) => formData.append('file', f, f.name));
    formData.append('project', project || 'Без проекта');
    return this.http.post<UploadResponse>(`${this.baseUrl}/upload`, formData);
  }

  /** Вопрос к базе знаний. project === null → поиск по всем проектам. */
  askQuestion(question: string, project: string | null): Observable<QueryResponse> {
    return this.http.post<QueryResponse>(`${this.baseUrl}/query`, { question, project });
  }

  /** Получение списка уникальных проектов. */
  getProjects(): Observable<ProjectsResponse> {
    return this.http.get<ProjectsResponse>(`${this.baseUrl}/projects`);
  }

  /** Текущая конфигурация LLM (ключ возвращается замаскированным). */
  getConfig(): Observable<ConfigResponse> {
    return this.http.get<ConfigResponse>(`${this.baseUrl}/config`);
  }

  /** Сохранение конфигурации LLM. */
  saveConfig(payload: SaveConfigPayload): Observable<{ ok: boolean; saved: boolean }> {
    return this.http.post<{ ok: boolean; saved: boolean }>(`${this.baseUrl}/config`, payload);
  }

  /** Получение списков известных моделей для подсказок. */
  getModels(): Observable<ModelsResponse> {
    return this.http.get<ModelsResponse>(`${this.baseUrl}/models`);
  }

  /** Получение списка загруженных документов (файлов) — для UI. */
  getDocuments(): Observable<DocumentsResponse> {
    return this.http.get<DocumentsResponse>(`${this.baseUrl}/docs`);
  }

  /** Семантические связи для конкретного файла (docId). */
  getSuggestions(docId: string): Observable<SuggestResponse> {
    return this.http.post<SuggestResponse>(`${this.baseUrl}/suggest-links`, { docId });
  }

  /** Сохранение папки для локального сканирования файловой системы. */
  setWorkspace(folderPath: string): Observable<SetWorkspaceResponse> {
    return this.http.post<SetWorkspaceResponse>(`${this.baseUrl}/set-workspace`, { folderPath });
  }

  /** Рекурсивное сканирование рабочей папки и индексация новых файлов. */
  scanWorkspace(): Observable<ScanResult> {
    return this.http.get<ScanResult>(`${this.baseUrl}/scan`);
  }

  /** Текущий прогресс фонового сканирования. */
  getScanProgress(): Observable<ScanProgress> {
    return this.http.get<ScanProgress>(`${this.baseUrl}/scan/progress`);
  }

  /** Текущая рабочая папка (для страницы настроек). */
  getWorkspace(): Observable<WorkspaceResponse> {
    return this.http.get<WorkspaceResponse>(`${this.baseUrl}/workspace`);
  }

  /** Применение (подтверждение) связи между документами. */
  applyLink(docId: string, targetId: string, similarity = 0): Observable<ApplyLinkResponse> {
    return this.http.post<ApplyLinkResponse>(`${this.baseUrl}/apply-link`, {
      docId,
      targetId,
      similarity
    });
  }

  /** Генерация и сохранение тегов для документа (GPT). */
  getTags(docId: string): Observable<TagsResponse> {
    return this.http.post<TagsResponse>(`${this.baseUrl}/suggest-tags`, { docId });
  }

  /** Генерация Mermaid-диаграммы по документу (или описанию). */
  generateDiagram(docId: string, description?: string): Observable<DiagramResponse> {
    return this.http.post<DiagramResponse>(`${this.baseUrl}/generate-diagram`, {
      docId,
      description
    });
  }

  /** Получение всех подтверждённых связей — для графа зависимостей. */
  getLinks(): Observable<LinksResponse> {
    return this.http.get<LinksResponse>(`${this.baseUrl}/links`);
  }

  /** Полная очистка индекса БД. */
  clearIndex(): Observable<ClearResponse> {
    return this.http.delete<ClearResponse>(`${this.baseUrl}/clear`);
  }
}