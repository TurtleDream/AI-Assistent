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
}

@Injectable({ providedIn: 'root' })
export class KnowledgeService {
  private http = inject(HttpClient);
  private baseUrl = 'http://localhost:3000/api';

  /** Загрузка файла в проект (multipart/form-data). */
  uploadFile(file: File, project: string): Observable<UploadResponse> {
    const formData = new FormData();
    formData.append('file', file, file.name);
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
}