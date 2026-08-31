import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { BehaviorSubject, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import {
  KnowledgeService,
  Source,
  LLMConfig,
  LLMProvider,
  SaveConfigPayload
} from './knowledge.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit, OnDestroy {
  private knowledge = inject(KnowledgeService);
  private sanitizer = inject(DomSanitizer);
  private destroy$ = new Subject<void>();

  // --- Загрузка файла ---
  selectedFile: File | null = null;
  uploadProject = '';
  isUploading = false;
  uploadMessage = '';

  // --- Проекты / фильтр ---
  projects: string[] = [];
  selectedProject = ''; // '' => «Все»

  // --- Конфигурация LLM ---
  showSettings = false;
  configLoaded = false;
  llmConfig: LLMConfig | null = null;
  chatModels: string[] = [];
  embeddingModels: string[] = [];
  yandexChatModels: string[] = [];
  yandexEmbeddingModels: string[] = [];
  cfgProvider: LLMProvider = 'openai';
  cfgBaseURL = '';
  cfgApiKey = '';
  cfgChatModel = '';
  cfgEmbeddingModel = '';
  cfgYandexFolderId = '';
  isSavingConfig = false;
  configMessage = '';

  get isYandex(): boolean {
    return this.cfgProvider === 'yandex';
  }

  // Список для подсказок в зависимости от провайдера
  get activeChatModels(): string[] {
    return this.isYandex ? this.yandexChatModels : this.chatModels;
  }
  get activeEmbeddingModels(): string[] {
    return this.isYandex ? this.yandexEmbeddingModels : this.embeddingModels;
  }

  // --- Вопрос / ответ ---
  question = '';
  isAsking = false;
  answer$ = new BehaviorSubject<SafeHtml | null>(null);
  sources$ = new BehaviorSubject<Source[]>([]);

  get isLoading(): boolean {
    return this.isUploading || this.isAsking;
  }

  ngOnInit(): void {
    this.loadProjects();
    this.loadConfig();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadProjects(): void {
    this.knowledge
      .getProjects()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.projects = res.projects || [];
        },
        error: (err) => {
          console.error('Get projects error', err);
          this.projects = [];
        }
      });
  }

  // ============================ Настройки LLM ============================

  loadConfig(): void {
    this.knowledge
      .getConfig()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.llmConfig = res.config;
          this.cfgProvider = res.config.provider || 'openai';
          this.cfgBaseURL = res.config.baseURL;
          this.cfgChatModel = res.config.chatModel;
          this.cfgEmbeddingModel = res.config.embeddingModel;
          this.cfgYandexFolderId = res.config.yandexFolderId || '';
          this.configLoaded = true;
        },
        error: (err) => {
          console.error('Get config error', err);
          this.configLoaded = true;
        }
      });

    this.knowledge
      .getModels()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.chatModels = res.chatModels || [];
          this.embeddingModels = res.embeddingModels || [];
          this.yandexChatModels = res.yandexChatModels || [];
          this.yandexEmbeddingModels = res.yandexEmbeddingModels || [];
        },
        error: (err) => {
          console.error('Get models error', err);
        }
      });
  }

  toggleSettings(): void {
    this.showSettings = !this.showSettings;
    if (this.showSettings) {
      this.configMessage = '';
    }
  }

  saveConfig(): void {
    this.isSavingConfig = true;
    this.configMessage = '';
    const payload: SaveConfigPayload = {};

    payload.provider = this.cfgProvider;
    if (this.cfgBaseURL.trim()) payload.baseURL = this.cfgBaseURL.trim();
    if (this.cfgChatModel.trim()) payload.chatModel = this.cfgChatModel.trim();
    if (this.cfgEmbeddingModel.trim()) payload.embeddingModel = this.cfgEmbeddingModel.trim();
    if (this.cfgYandexFolderId.trim()) payload.yandexFolderId = this.cfgYandexFolderId.trim();
    // Ключ отправляем только если пользователь реально ввёл новый
    if (this.cfgApiKey.trim() && this.cfgApiKey.trim() !== '••••••••') {
      payload.apiKey = this.cfgApiKey.trim();
    }

    this.knowledge
      .saveConfig(payload)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.configMessage = 'Настройки сохранены ✅';
          this.cfgApiKey = '';
          this.loadConfig();
        },
        error: (err) => {
          this.configMessage = err.error?.error || 'Ошибка сохранения настроек';
          console.error('Save config error', err);
        },
        complete: () => {
          this.isSavingConfig = false;
        }
      });
  }

  // ============================ Загрузка ============================

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.selectedFile = input.files[0];
    }
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.selectedFile = files[0];
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  upload(): void {
    if (!this.selectedFile) {
      this.uploadMessage = 'Выберите файл для загрузки';
      return;
    }
    this.isUploading = true;
    this.uploadMessage = '';

    this.knowledge
      .uploadFile(this.selectedFile, this.uploadProject)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.uploadMessage = `Загружено чанков: ${res.saved}`;
          this.selectedFile = null;
          this.uploadProject = '';
          if (res.saved > 0) {
            this.loadProjects();
          }
        },
        error: (err) => {
          this.uploadMessage = err.error?.error || 'Ошибка загрузки файла';
          console.error('Upload error', err);
        },
        complete: () => {
          this.isUploading = false;
        }
      });
  }

  // ============================ Вопрос ============================

  ask(): void {
    const q = this.question.trim();
    if (!q) {
      return;
    }
    this.isAsking = true;
    this.answer$.next(null);
    this.sources$.next([]);

    const project = this.selectedProject ? this.selectedProject : null;

    this.knowledge
      .askQuestion(q, project)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.answer$.next(this.formatAnswer(res.answer));
          this.sources$.next(res.sources || []);
        },
        error: (err) => {
          this.answer$.next(this.formatAnswer(err.error?.error || 'Ошибка запроса'));
          this.sources$.next([]);
          console.error('Query error', err);
        },
        complete: () => {
          this.isAsking = false;
        }
      });
  }

  /**
   * «Markdown-lite» для вывода: экранируем HTML, превращаем ```code```
   * в <pre><code>, остальные переносы строк — в <br>.
   * Сначала экранируем, потом обходим защиту Angular — XSS безопасно.
   */
  formatAnswer(raw: string): SafeHtml {
    const escaped = this.escapeHtml(raw ?? '');
    const parts = escaped.split('```');
    let html = '';
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        html += `<pre class="code-block">${part.trim()}</pre>`;
      } else {
        html += part.replace(/\n/g, '<br>');
      }
    });
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}