import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

/** Узел файлового дерева на главной странице. */
export interface FolderNode {
  name: string;
  type: 'folder' | 'file';
  path?: string;
  docId?: string;
  children?: FolderNode[];
  expanded?: boolean;
}

/**
 * Рекурсивное Obsidian-подобное дерево папок.
 * Клик по папке сворачивает/разворачивает её, клик по файлу — эмитит событие.
 */
@Component({
  selector: 'app-folder-tree',
  standalone: true,
  imports: [CommonModule],
  template: `
    <ng-container *ngFor="let node of nodes">
      <div class="tree-row" [class.tree-folder]="node.type === 'folder'" [class.tree-file]="node.type === 'file'">
        <span class="tree-arrow" *ngIf="node.type === 'folder'" (click)="onFolderClick(node)">
          {{ node.expanded ? '▾' : '▸' }}
        </span>
        <span class="tree-arrow tree-arrow-empty" *ngIf="node.type === 'file'"></span>
        <span class="tree-icon">{{ node.type === 'folder' ? '📁' : '📄' }}</span>
        <span class="tree-name" (click)="onNodeClick(node)">{{ node.name }}</span>
      </div>
      <div class="tree-children" *ngIf="node.type === 'folder' && node.expanded">
        <app-folder-tree
          [nodes]="node.children || []"
          (nodeClick)="forward($event)"
          (toggle)="forwardToggle($event)"
        ></app-folder-tree>
      </div>
    </ng-container>
  `
})
export class FolderTreeComponent {
  @Input() nodes: FolderNode[] = [];
  @Output() nodeClick = new EventEmitter<FolderNode>();
  @Output() toggle = new EventEmitter<FolderNode>();

  onFolderClick(node: FolderNode): void {
    node.expanded = !node.expanded;
    this.toggle.emit(node);
  }

  onNodeClick(node: FolderNode): void {
    if (node.type === 'file') {
      this.nodeClick.emit(node);
    } else {
      this.onFolderClick(node);
    }
  }

  forward(node: FolderNode): void {
    this.nodeClick.emit(node);
  }

  forwardToggle(node: FolderNode): void {
    this.toggle.emit(node);
  }
}