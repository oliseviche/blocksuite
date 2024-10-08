import type { BlockModel } from '@blocksuite/store';

import { throttle } from '@blocksuite/global/utils';

import type { BaseSelection, TextSelection } from '../selection/index.js';
import type { BlockComponent } from '../view/element/block-component.js';
import type { RangeManager } from './range-manager.js';

import { blockComponentSymbol } from '../view/element/consts.js';
import { BLOCK_ID_ATTR } from '../view/index.js';
import { RANGE_SYNC_EXCLUDE_ATTR } from './consts.js';

/**
 * Two-way binding between native range and text selection
 */
export class RangeBinding {
  private _compositionStartCallback:
    | ((event: CompositionEvent) => Promise<void>)
    | null = null;

  private _computePath = (modelId: string) => {
    const block = this.host.std.doc.getBlock(modelId)?.model;
    if (!block) return [];

    const path: string[] = [];
    let parent: BlockModel | null = block;
    while (parent) {
      path.unshift(parent.id);
      parent = this.host.doc.getParent(parent);
    }

    return path;
  };

  private _onBeforeInput = (event: InputEvent) => {
    const selection = this.selectionManager.find('text');
    if (!selection) return;

    if (event.isComposing) return;

    const { from, to } = selection;
    if (!to || from.blockId === to.blockId) return;

    const range = this.rangeManager?.value;
    if (!range) return;

    const blocks = this.rangeManager.getSelectedBlockComponentsByRange(range, {
      mode: 'flat',
    });

    const start = blocks.at(0);
    const end = blocks.at(-1);
    if (!start || !end) return;

    const startText = start.model.text;
    const endText = end.model.text;
    if (!startText || !endText) return;

    event.preventDefault();

    this.host.doc.transact(() => {
      startText.delete(from.index, from.length);
      startText.insert(event.data ?? '', from.index);
      endText.delete(0, to.length);
      startText.join(endText);

      blocks
        .slice(1)
        // delete from lowest to highest
        .reverse()
        .forEach(block => {
          const parent = this.host.doc.getParent(block.model);
          if (!parent) return;
          this.host.doc.deleteBlock(block.model, {
            bringChildrenTo: parent,
          });
        });
    });

    const newSelection = this.selectionManager.create('text', {
      from: {
        blockId: from.blockId,
        index: from.index + (event.data?.length ?? 0),
        length: 0,
      },
      to: null,
    });
    this.selectionManager.setGroup('note', [newSelection]);
  };

  private _onCompositionEnd = (event: CompositionEvent) => {
    if (this._compositionStartCallback) {
      event.preventDefault();
      this._compositionStartCallback(event).catch(console.error);
      this._compositionStartCallback = null;
    }
  };

  private _onCompositionStart = () => {
    const selection = this.selectionManager.find('text');
    if (!selection) return;

    const { from, to } = selection;
    if (!to) return;

    this.isComposing = true;

    const range = this.rangeManager?.value;
    if (!range) return;

    const blocks = this.rangeManager.getSelectedBlockComponentsByRange(range, {
      mode: 'flat',
    });
    const highestBlocks = this.rangeManager.getSelectedBlockComponentsByRange(
      range,
      {
        mode: 'highest',
        match: block => block.model.role === 'content',
      }
    );

    const start = blocks.at(0);
    const end = blocks.at(-1);
    if (!start || !end) return;

    const startText = start.model.text;
    const endText = end.model.text;
    if (!startText || !endText) return;

    this._compositionStartCallback = async event => {
      this.isComposing = false;

      const parents: BlockComponent[] = [];
      for (const highestBlock of highestBlocks) {
        const parentModel = this.host.doc.getParent(highestBlock.blockId);
        if (!parentModel) continue;
        const parent = this.host.view.getBlock(parentModel.id);
        if (!this._isBlockComponent(parent) || parents.includes(parent))
          continue;

        // Restore the DOM structure damaged by the composition
        parent.dirty = true;
        await parent.updateComplete;
        await parent.updateComplete;
        parents.push(parent);
      }

      this.host.doc.transact(() => {
        endText.delete(0, to.length);
        startText.join(endText);

        blocks
          .slice(1)
          // delete from lowest to highest
          .reverse()
          .forEach(block => {
            const parent = this.host.doc.getParent(block.model);
            if (!parent) return;
            this.host.doc.deleteBlock(block.model, {
              bringChildrenTo: parent,
            });
          });
      });

      await this.host.updateComplete;

      const selection = this.selectionManager.create('text', {
        from: {
          blockId: from.blockId,
          index: from.index + (event.data?.length ?? 0),
          length: 0,
        },
        to: null,
      });
      this.host.selection.setGroup('note', [selection]);
      this.rangeManager?.syncTextSelectionToRange(selection);
    };
  };

  private _onNativeSelectionChanged = async () => {
    if (this.isComposing) return;

    await this.host.updateComplete;

    const selection = document.getSelection();
    if (!selection) {
      this.selectionManager.clear(['text']);
      return;
    }
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    if (!range) {
      this._prevTextSelection = null;
      this.selectionManager.clear(['text']);
      return;
    }

    if (!this.host.contains(range.commonAncestorContainer)) {
      return;
    }

    // range is in a non-editable element
    // ex. placeholder
    const isRangeOutNotEditable =
      range.startContainer instanceof HTMLElement &&
      range.startContainer.contentEditable === 'false' &&
      range.endContainer instanceof HTMLElement &&
      range.endContainer.contentEditable === 'false';
    if (isRangeOutNotEditable) {
      this._prevTextSelection = null;
      this.selectionManager.clear(['text']);

      // force clear native selection to break inline editor input
      selection.removeRange(range);
      return;
    }

    const el =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if (!el) return;
    const block = el.closest<BlockComponent>(`[${BLOCK_ID_ATTR}]`);
    if (block?.getAttribute(RANGE_SYNC_EXCLUDE_ATTR) === 'true') return;

    const inlineEditor = this.rangeManager?.getClosestInlineEditor(
      range.commonAncestorContainer
    );
    if (inlineEditor?.isComposing) return;

    const isRangeReversed =
      !!selection.anchorNode &&
      !!selection.focusNode &&
      (selection.anchorNode === selection.focusNode
        ? selection.anchorOffset > selection.focusOffset
        : selection.anchorNode.compareDocumentPosition(selection.focusNode) ===
          Node.DOCUMENT_POSITION_PRECEDING);
    const textSelection = this.rangeManager?.rangeToTextSelection(
      range,
      isRangeReversed
    );
    if (!textSelection) {
      this._prevTextSelection = null;
      this.selectionManager.clear(['text']);
      return;
    }

    const model = this.host.doc.getBlockById(textSelection.blockId);
    // If the model is not found, the selection maybe in another editor
    if (!model) return;

    this._prevTextSelection = {
      selection: textSelection,
      path: this._computePath(model.id),
    };
    this.rangeManager?.syncRangeToTextSelection(range, isRangeReversed);
  };

  private _onStdSelectionChanged = (selections: BaseSelection[]) => {
    const text =
      selections.find((selection): selection is TextSelection =>
        selection.is('text')
      ) ?? null;

    if (text === this._prevTextSelection) {
      return;
    }
    // wait for lit updated
    this.host.updateComplete
      .then(() => {
        const id = text?.blockId;
        const path = id && this._computePath(id);

        if (this.host.event.active) {
          const eq =
            text && this._prevTextSelection && path
              ? text.equals(this._prevTextSelection.selection) &&
                path.join('') === this._prevTextSelection.path.join('')
              : false;

          if (eq) return;
        }

        this._prevTextSelection =
          text && path
            ? {
                selection: text,
                path,
              }
            : null;
        if (text) {
          this.rangeManager?.syncTextSelectionToRange(text);
        } else {
          this.rangeManager?.clear();
        }
      })
      .catch(console.error);
  };

  private _prevTextSelection: {
    selection: TextSelection;
    path: string[];
  } | null = null;

  isComposing = false;

  get host() {
    return this.manager.std.host;
  }

  get rangeManager() {
    return this.host.range;
  }

  get selectionManager() {
    return this.host.selection;
  }

  constructor(public manager: RangeManager) {
    this.host.disposables.add(
      this.selectionManager.slots.changed.on(this._onStdSelectionChanged)
    );

    this.host.disposables.addFromEvent(
      document,
      'selectionchange',
      throttle(() => {
        this._onNativeSelectionChanged().catch(console.error);
      }, 10)
    );

    this.host.disposables.add(
      this.host.event.add('beforeInput', ctx => {
        const event = ctx.get('defaultState').event as InputEvent;
        this._onBeforeInput(event);
      })
    );

    this.host.disposables.add(
      this.host.event.add('compositionStart', this._onCompositionStart)
    );
    this.host.disposables.add(
      this.host.event.add('compositionEnd', ctx => {
        const event = ctx.get('defaultState').event as CompositionEvent;
        this._onCompositionEnd(event);
      })
    );
  }

  private _isBlockComponent(el: Element | null): el is BlockComponent {
    return Boolean(el && blockComponentSymbol in el);
  }
}
