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
}