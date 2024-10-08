import { css, html } from 'lit';

import { BaseCellRenderer } from '../../core/column/index.js';
import { createFromBaseCellRenderer } from '../../core/column/renderer.js';
import { createIcon } from '../../core/utils/uni-icon.js';
import { imageColumnModelConfig } from './define.js';

export class TextCell extends BaseCellRenderer<string> {
  static override styles = css`
    affine-database-image-cell {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
    }
    affine-database-image-cell img {
      width: 20px;
      height: 20px;
    }
  `;

  override render() {
    return html`<img src=${this.value ?? ''}></img>`;
  }
}

export const imageColumnConfig = imageColumnModelConfig.createColumnMeta({
  icon: createIcon('ImageIcon'),
  cellRenderer: {
    view: createFromBaseCellRenderer(TextCell),
  },
});
