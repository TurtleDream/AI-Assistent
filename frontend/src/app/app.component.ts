import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { BehaviorSubject, Subject, interval } from 'rxjs';
import { takeUntil, finalize } from 'rxjs/operators';
import { FolderTreeComponent, FolderNode } from './folder-tree.component';
import {
  KnowledgeService,
  Source,
  LLMConfig,
  LLMProvider,
  SaveConfigPayload,
  DocumentInfo,
  Suggestion,
  ScanProgress,
  ScanError,
  LinkInfo
} from './knowledge.service';

/** Узел графа зависимостей (внутренняя структура для canvas-симуляции). */
interface GraphNode {
  id: string;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, FolderTreeComponent],
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

  // --- Навигация по вкладкам ---
  activeView: 'home' | 'docs' | 'graph' | 'settings' = 'home';

  // --- Теги ---
  activeTagsDoc: DocumentInfo | null = null;
  taggingDocId: string | null = null;
  tagsError = '';
  /** Предложенные/сохранённые теги по каждому docId. */
  tagsByDoc: { [docId: string]: string[] | undefined } = {};

  // --- Диаграммы (Mermaid) ---
  diagramDoc: DocumentInfo | null = null;
  isDiagramLoading = false;
  diagramError = '';
  mermaid: string | null = null;
  isMermaidFallback = false;

  // --- Граф связей ---
  graphLinks: LinkInfo[] = [];
  isGraphLoading = false;
  graphMessage = '';

  // --- Дерево папок (Obsidian-подобное) ---
  folderTree: FolderNode[] = [];

  // --- Очистка индекса ---
  isClearing = false;
  clearMessage = '';

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
    this.loadWorkspace();
    this.loadConfirmedLinks();
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
          this.buildFolderTree();
        },
        error: (err) => {
          console.error('Get documents error', err);
          this.documents = [];
          this.folderTree = [];
        }
      });
  }

  loadWorkspace(): void {
    this.knowledge
      .getWorkspace()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          if (res && res.folderPath) this.workspacePath = res.folderPath;
        },
        error: (err) => {
          console.error('Get workspace error', err);
        }
      });
  }

  /**
   * Строит Obsidian-подобное дерево папок из документов, у которых есть
   * абсолютный путь (пришли из локального сканирования). Файлы без пути
   * (ручная загрузка) попадают в корень «Загруженные файлы».
   */
  buildFolderTree(): void {
    const tree: FolderNode[] = [];
    const dirs = new Map<string, FolderNode>();
    const makeDir = (pathParts: string[]): FolderNode => {
      const full = pathParts.join('/');
      if (dirs.has(full)) return dirs.get(full)!;
      const node: FolderNode = {
        name: pathParts[pathParts.length - 1] || full,
        type: 'folder',
        path: full,
        expanded: true,
        children: []
      };
      dirs.set(full, node);
      return node;
    };

    const pathDocs = this.documents.filter((d) => d.path && d.path.trim());
    const looseDocs = this.documents.filter((d) => !d.path || !d.path.trim());

    for (const doc of pathDocs) {
      const parts = doc.path!.split('/').filter(Boolean);
      const fileName = parts.pop() || doc.fileName;
      let parent: FolderNode | null = null;
      for (let i = 0; i < parts.length; i++) {
        const node = makeDir(parts.slice(0, i + 1));
        if (parent) {
          if (!parent.children!.some((c) => c.path === node.path)) {
            parent.children!.push(node);
          }
        } else if (!tree.some((t) => t.path === node.path)) {
          tree.push(node);
        }
        parent = node;
      }
      // Сама папка-отображатель: добавляем файл.
      const parentDir =
        parent ||
        makeDir([doc.project || 'Локальная папка']);
      if (!parent && !tree.some((t) => t.path === parentDir.path)) {
        tree.push(parentDir);
      }
      if (!parentDir.children!.some((c) => c.docId === doc.docId)) {
        parentDir.children!.push({
          name: fileName,
          type: 'file',
          docId: doc.docId,
          path: doc.path
        });
      }
    }

    // Документы, загруженные вручную (без пути).
    if (looseDocs.length) {
      const root: FolderNode = {
        name: '⬆ Загруженные файлы',
        type: 'folder',
        expanded: true,
        children: looseDocs.map((d) => ({
          name: d.fileName,
          type: 'file',
          docId: d.docId
        }))
      };
      tree.push(root);
    }

    this.folderTree = tree;
  }

  toggleFolder(node?: FolderNode): void {
    if (node && node.type === 'folder') node.expanded = !node.expanded;
  }

  /** При клике на файл дерева открываем модал связей для него. */
  openTreeFile(node: FolderNode): void {
    if (node.type !== 'file' || !node.docId) return;
    const doc = this.documents.find((d) => d.docId === node.docId);
    if (doc) this.findLinks(doc);
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

  /**
   * Подтверждает (или локально отменяет) связь. При установке реально
   * сохраняет её на бэкенде (POST /api/apply-link), чтобы она попала в граф.
   */
  toggleLink(targetDocId: string, suggestedDocId: string, similarity = 0): void {
    const key = `${targetDocId}::${suggestedDocId}`;
    if (this.linkedPairs.has(key)) {
      this.linkedPairs.delete(key);
      return;
    }
    this.knowledge
      .applyLink(targetDocId, suggestedDocId, similarity)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.linkedPairs.add(key);
          this.linksError = '';
        },
        error: (err) => {
          this.linksError = err.error?.error || 'Ошибка при сохранении связи';
          console.error('Apply-link error', err);
        }
      });
  }

  /** Подтягивает подтверждённые связи с бэкенда (для графа и галочек). */
  loadConfirmedLinks(): void {
    this.knowledge
      .getLinks()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.graphLinks = res.links || [];
          this.linkedPairs.clear();
          (res.links || []).forEach((l) => {
            this.linkedPairs.add(`${l.sourceId}::${l.targetId}`);
          });
        },
        error: (err) => {
          console.error('Get links error', err);
          this.graphLinks = [];
        }
      });
  }

  // ============================ Навигация по вкладкам ============================

  switchView(view: 'home' | 'docs' | 'graph' | 'settings'): void {
    this.activeView = view;
    if (view === 'docs') {
      this.loadDocuments();
      this.loadConfirmedLinks();
    } else if (view === 'graph') {
      this.loadGraph();
    } else if (view === 'settings') {
      this.loadWorkspace();
    }
  }

  // ============================ Теги ============================

  get activeTags(): string[] | undefined {
    return this.activeTagsDoc
      ? this.tagsByDoc[this.activeTagsDoc.docId]
      : undefined;
  }

  get isTagging(): boolean {
    return !!(
      this.activeTagsDoc && this.taggingDocId === this.activeTagsDoc.docId
    );
  }

  openTags(doc: DocumentInfo): void {
    this.activeTagsDoc = doc;
    this.tagsError = '';
    this.tagsByDoc[doc.docId] = undefined;
    this.taggingDocId = doc.docId;

    this.knowledge
      .getTags(doc.docId)
      .pipe(
        takeUntil(this.destroy$),
        finalize(() => {
          this.taggingDocId = null;
        })
      )
      .subscribe({
        next: (res) => {
          this.tagsByDoc[doc.docId] = res.tags || [];
        },
        error: (err) => {
          this.tagsByDoc[doc.docId] = [];
          this.tagsError = err.error?.error || 'Ошибка при генерации тегов';
          console.error('Suggest-tags error', err);
        }
      });
  }

  closeTags(): void {
    this.activeTagsDoc = null;
    this.tagsError = '';
  }

  // ============================ Диаграммы (Mermaid) ============================

  generateDiagramFor(doc: DocumentInfo): void {
    this.diagramDoc = doc;
    this.diagramError = '';
    this.mermaid = null;
    this.isMermaidFallback = false;
    this.isDiagramLoading = true;

    this.knowledge
      .generateDiagram(doc.docId)
      .pipe(
        takeUntil(this.destroy$),
        finalize(() => {
          this.isDiagramLoading = false;
        })
      )
      .subscribe({
        next: (res) => {
          this.mermaid = res.mermaid || '';
          this.isMermaidFallback = !!res.fallback;
        },
        error: (err) => {
          this.diagramError =
            err.error?.error || 'Ошибка при генерации диаграммы';
          console.error('Generate-diagram error', err);
        }
      });
  }

  closeDiagram(): void {
    this.diagramDoc = null;
    this.mermaid = null;
    this.diagramError = '';
  }

  /** Открывает Mermaid-код в отдельном окне. */
  openDiagramInWindow(): void {
    if (!this.mermaid) return;
    const blob = new Blob([this.mermaid], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /** Сохраняет Mermaid-код в файл .mmd. */
  downloadMermaid(): void {
    if (!this.mermaid) return;
    const blob = new Blob([this.mermaid], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.diagramDoc?.fileName || 'diagram'}.mmd`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
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

  // ============================ Граф связей ============================

  loadGraph(): void {
    this.isGraphLoading = true;
    this.graphMessage = '';
    this.knowledge
      .getLinks()
      .pipe(
        takeUntil(this.destroy$),
        finalize(() => {
          this.isGraphLoading = false;
        })
      )
      .subscribe({
        next: (res) => {
          this.graphLinks = res.links || [];
          if (!this.graphLinks.length) {
            this.graphMessage =
              'Пока нет подтверждённых связей. Перейдите в «Документы» и подтвердите связи через кнопку «Связать».';
          } else {
            // Откладываем отрисовку до появления canvas в DOM.
            setTimeout(() => this.drawGraph(), 50);
          }
        },
        error: (err) => {
          this.graphMessage =
            err.error?.error || 'Не удалось загрузить граф связей';
          console.error('Get links error', err);
        }
      });
  }

  /** Самописная force-симуляция на canvas (без сторонних библиотек). */
  private drawGraph(): void {
    const canvas = document.getElementById('graph-canvas') as HTMLCanvasElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const byId = new Map<string, DocumentInfo>();
    this.documents.forEach((d) => byId.set(d.docId, d));
    const nodeIds: string[] = [];
    const edges: Array<{ a: string; b: string }> = [];
    this.graphLinks.forEach((l) => {
      if (!nodeIds.includes(l.sourceId)) nodeIds.push(l.sourceId);
      if (!nodeIds.includes(l.targetId)) nodeIds.push(l.targetId);
      edges.push({ a: l.sourceId, b: l.targetId });
    });

    const nodes: GraphNode[] = nodeIds.map((id, i) => {
      const angle = (i / Math.max(1, nodeIds.length)) * Math.PI * 2;
      const radius = Math.min(W, H) * 0.3;
      return {
        id,
        label: byId.get(id)?.fileName || id,
        x: W / 2 + Math.cos(angle) * radius,
        y: H / 2 + Math.sin(angle) * radius,
        vx: 0,
        vy: 0
      };
    });

    // Несколько итераций простой force-симуляции (отталкивание + пружины рёбер).
    for (let i = 0; i < 300; i++) {
      for (let a = 0; a < nodes.length; a++) {
        for (let b = a + 1; b < nodes.length; b++) {
          const A = nodes[a];
          const B = nodes[b];
          let dx = A.x - B.x;
          let dy = A.y - B.y;
          const dist = Math.max(Math.hypot(dx, dy) || 1, 1);
          const force = 4000 / (dist * dist);
          dx /= dist;
          dy /= dist;
          A.vx += dx * force;
          A.vy += dy * force;
          B.vx -= dx * force;
          B.vy -= dy * force;
        }
      }
      edges.forEach((e) => {
        const A = nodes.find((n) => n.id === e.a);
        const B = nodes.find((n) => n.id === e.b);
        if (!A || !B) return;
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const dist = Math.max(Math.hypot(dx, dy) || 1, 1);
        const target = 140;
        const force = (dist - target) * 0.05;
        A.vx += (dx / dist) * force;
        A.vy += (dy / dist) * force;
        B.vx -= (dx / dist) * force;
        B.vy -= (dy / dist) * force;
      });
      nodes.forEach((n) => {
        n.vx *= 0.85;
        n.vy *= 0.85;
        n.x += n.vx;
        n.y += n.vy;
        n.x = Math.max(40, Math.min(W - 40, n.x));
        n.y = Math.max(40, Math.min(H - 40, n.y));
      });
    }

    ctx.clearRect(0, 0, W, H);
    // Рёбра
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.5;
    edges.forEach((e) => {
      const A = nodes.find((n) => n.id === e.a);
      const B = nodes.find((n) => n.id === e.b);
      if (!A || !B) return;
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.lineTo(B.x, B.y);
      ctx.stroke();
    });
    // Узлы + подписи
    nodes.forEach((n) => {
      ctx.beginPath();
      ctx.arc(n.x, n.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#3b82f6';
      ctx.fill();
      ctx.fillStyle = '#1f2937';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(n.label, n.x + 14, n.y + 4);
    });

    if (!this.graphNodeClickBound) {
      this.graphNodeClickBound = true;
      canvas.addEventListener('click', (ev) => {
        const rect = canvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        const hit = nodes.find((n) => Math.hypot(mx - n.x, my - n.y) <= 12);
        if (hit) {
          const doc = this.documents.find((d) => d.docId === hit.id);
          if (doc) this.findLinks(doc);
        }
      });
    }
  }

  private graphNodeClickBound = false;

  // ============================ Настройки: папка и очистка ============================

  /** Сохраняет папку как рабочую (без запуска полного сканирования). */
  saveWorkspacePath(): void {
    const p = this.workspacePath.trim();
    if (!p) {
      this.clearMessage = 'Укажите путь к папке';
      return;
    }
    this.isClearing = true;
    this.clearMessage = '';
    this.knowledge
      .setWorkspace(p)
      .pipe(
        takeUntil(this.destroy$),
        finalize(() => {
          this.isClearing = false;
        })
      )
      .subscribe({
        next: (res) => {
          this.clearMessage = `Папка установлена: ${res.folderPath}`;
          this.buildFolderTree();
        },
        error: (err) => {
          this.clearMessage = err.error?.error || 'Не удалось установить папку';
          console.error('Set workspace error', err);
        }
      });
  }

  confirmClear(): void {
    const ok = window.confirm(
      'Удалить БД полностью? Все документы, чанки, теги и связи будут потеряны.'
    );
    if (!ok) return;
    this.isClearing = true;
    this.clearMessage = '';
    this.knowledge
      .clearIndex()
      .pipe(
        takeUntil(this.destroy$),
        finalize(() => {
          this.isClearing = false;
        })
      )
      .subscribe({
        next: (res) => {
          this.clearMessage = `Индекс очищен (удалено чанков: ${res.cleared}).`;
          this.documents = [];
          this.folderTree = [];
          this.linkedPairs.clear();
          this.graphLinks = [];
          this.projects = [];
        },
        error: (err) => {
          this.clearMessage = err.error?.error || 'Ошибка при очистке индекса';
          console.error('Clear index error', err);
        }
      });
  }

  /** Кодирует Mermaid-код для вставки в URL mermaid.live (base64). */
  encodeMermaid(code: string): string {
    return btoa(unescape(encodeURIComponent(code)));
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}