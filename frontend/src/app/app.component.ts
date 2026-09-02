import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { BehaviorSubject, Subject, interval } from 'rxjs';
import { takeUntil, finalize } from 'rxjs/operators';
import {
  KnowledgeService,
  Source,
  LLMConfig,
  LLMProvider,
  SaveConfigPayload,
  DocumentInfo,
  Suggestion,
  ScanProgress,
  ScanError
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

  // --- Сканирование локальной папки ---
  workspacePath = '';
  isScanning = false;
  scanProgress: ScanProgress | null = null;
  scanMessage = '';
  scanErrors: ScanError[] = [];
  /** Управление завершением поллинга прогресса (пересоздаётся на каждый скан). */
  private scanPollStop$ = new Subject<void>();

  // --- Интеллектуальные связи между файлами ---
  documents: DocumentInfo[] = [];
  /** Текущие рекомендации по каждому docId: undefined = ещё не считались. */
  suggestionsByDoc: { [docId: string]: Suggestion[] | undefined } = {};
  /** Документ, для которого открыт модал со связями. */
  activeLinksDoc: DocumentInfo | null = null;
  /** docId файла, для которого идёт расчёт связей (спиннер). */
  isSuggestingDoc: string | null = null;
  linksError = '';
  /** Визуальные установленные связи: ключ `${docId}::${suggestedDocId}`. */
  linkedPairs = new Set<string>();

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
    return this.isScanning || this.isAsking;
  }

  /** Текущие предложенные связи для открытого модала (undefined = расчёт не завершён). */
  get activeLinksSuggestions(): Suggestion[] | undefined {
    return this.activeLinksDoc
      ? this.suggestionsByDoc[this.activeLinksDoc.docId]
      : undefined;
  }

  /** Идёт ли расчёт связей для открытого модала (спиннер). */
  get activeLinksLoading(): boolean {
    return !!(this.activeLinksDoc && this.isSuggestingDoc === this.activeLinksDoc.docId);
  }

  ngOnInit(): void {
    this.loadProjects();
    this.loadConfig();
    this.loadDocuments();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.scanPollStop$.next();
    this.scanPollStop$.complete();
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

  loadDocuments(): void {
    this.knowledge
      .getDocuments()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.documents = res.documents || [];
        },
        error: (err) => {
          console.error('Get documents error', err);
          this.documents = [];
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

  // ============================ Сканирование папки ============================

  startScan(): void {
    const p = this.workspacePath.trim();
    if (!p) {
      this.scanMessage = 'Укажите путь к папке';
      return;
    }
    if (this.isScanning) return;

    this.isScanning = true;
    this.scanMessage = '';
    this.scanErrors = [];
    this.scanProgress = {
      running: true,
      total: 0,
      processed: 0,
      newIndexed: 0,
      errors: [],
      current: '',
      percent: 0
    };

    // Новый «маркер остановки» поллинга (предыдущий был завершён).
    this.scanPollStop$ = new Subject<void>();
    this.startProgressPolling();

    // 1) Сохраняем папку в настройках бэкенда.
    this.knowledge
      .setWorkspace(p)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => this.runScan(),
        error: (err) => {
          this.stopScanPolling();
          this.scanMessage = err.error?.error || 'Не удалось установить папку';
          console.error('Set workspace error', err);
        }
      });
  }

  private runScan(): void {
    // 2) Запускаем само сканирование (долгий HTTP-запрос; прогресс тянем поллингом).
    this.knowledge
      .scanWorkspace()
      .pipe(
        takeUntil(this.destroy$),
        finalize(() => this.stopScanPolling(true))
      )
      .subscribe({
        next: (res) => {
          this.scanMessage = `Просканировано: ${res.totalScanned}, новых: ${res.newIndexed}`;
          if (res.errors.length) this.scanMessage += `, ошибок: ${res.errors.length}`;
          this.scanErrors = res.errors || [];
          this.loadProjects();
          this.loadDocuments();
        },
        error: (err) => {
          this.scanMessage = err.error?.error || 'Ошибка сканирования';
          console.error('Scan error', err);
        }
      });
  }

  private startProgressPolling(): void {
    interval(600)
      .pipe(takeUntil(this.destroy$), takeUntil(this.scanPollStop$))
      .subscribe({
        next: () => this.fetchProgress()
      });
  }

  private fetchProgress(): void {
    this.knowledge
      .getScanProgress()
      .pipe(takeUntil(this.destroy$), takeUntil(this.scanPollStop$))
      .subscribe({
        next: (pr) => {
          this.scanProgress = pr;
        },
        error: () => {}
      });
  }

  /** Останавливает поллинг и (опционально) тянет финальный прогресс (100%). */
  private stopScanPolling(fetchFinal = false): void {
    this.isScanning = false;
    if (fetchFinal) {
      // Отдельный запрос вне маркера остановки, чтобы показать завершённое состояние.
      this.knowledge
        .getScanProgress()
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: (pr) => {
            this.scanProgress = pr;
          },
          error: () => {}
        });
    }
    this.scanPollStop$.next();
    this.scanPollStop$.complete();
  }

  // ============================ Связи между файлами ============================

  findLinks(doc: DocumentInfo): void {
    this.activeLinksDoc = doc;
    this.linksError = '';
    // Сбрасываем прежний результат, чтобы сразу показать спиннер.
    this.suggestionsByDoc[doc.docId] = undefined;
    this.isSuggestingDoc = doc.docId;

    this.knowledge
      .getSuggestions(doc.docId)
      .pipe(
        takeUntil(this.destroy$),
        finalize(() => {
          this.isSuggestingDoc = null;
        })
      )
      .subscribe({
        next: (res) => {
          this.suggestionsByDoc[doc.docId] = res.suggestions || [];
        },
        error: (err) => {
          this.suggestionsByDoc[doc.docId] = [];
          this.linksError = err.error?.error || 'Ошибка при поиске связей';
          console.error('Suggest-links error', err);
        }
      });
  }

  closeLinks(): void {
    this.activeLinksDoc = null;
    this.linksError = '';
  }

  isLinked(targetDocId: string, suggestedDocId: string): boolean {
    return this.linkedPairs.has(`${targetDocId}::${suggestedDocId}`);
  }

  toggleLink(targetDocId: string, suggestedDocId: string): void {
    const key = `${targetDocId}::${suggestedDocId}`;
    if (this.linkedPairs.has(key)) {
      this.linkedPairs.delete(key);
    } else {
      this.linkedPairs.add(key);
    }
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