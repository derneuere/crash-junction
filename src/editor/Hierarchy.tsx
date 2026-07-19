// Left pane — the workspace tree: level root, player, mode, then one group
// per placeable category with counts, an ADD button, and item rows labeled
// by the schema's itemLabel. Selection is the shared NodePath.

import { useState } from 'react';
import { CATEGORIES } from './defaults';
import { LEVEL_SCHEMA } from './schema/levelSchema';
import type { NodePath } from './schema/types';
import { useEditor } from './state';

const samePath = (a: NodePath | null, b: NodePath) =>
  !!a && a.length === b.length && a.every((seg, i) => seg === b[i]);

export function Hierarchy() {
  const { level, selection, select, addListItem } = useEditor();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const levelFields = LEVEL_SCHEMA.registry.level.fields;

  return (
    <div className="edPaneScroll edTree">
      <button
        className={`edTreeRow root${selection == null ? ' sel' : ''}`}
        onClick={() => select(null)}
      >
        <span className="edTreeLabel">{level.name || 'LEVEL'}</span>
        <span className="edTreeMeta">{level.mode.kind}</span>
      </button>
      <button
        className={`edTreeRow${samePath(selection, ['player']) ? ' sel' : ''}`}
        onClick={() => select(['player'])}
      >
        <span className="edTreeDot" style={{ background: '#e8352a' }} />
        <span className="edTreeLabel">PLAYER</span>
        <span className="edTreeMeta">{level.player.variant}</span>
      </button>

      {CATEGORIES.map((cat) => {
        const list = (level[cat.key] ?? []) as unknown[];
        const field = levelFields[cat.key];
        const itemLabel = field?.kind === 'list' ? field.itemLabel : undefined;
        const isCollapsed = collapsed[cat.key];
        return (
          <div key={cat.key} className="edTreeGroup">
            <div className="edTreeHead">
              <button
                className="edTreeTwist"
                onClick={() => setCollapsed((c) => ({ ...c, [cat.key]: !c[cat.key] }))}
              >
                {isCollapsed ? '▸' : '▾'}
              </button>
              <span className="edTreeDot" style={{ background: cat.accent }} />
              <span className="edTreeLabel">{cat.label}</span>
              <span className="edTreeMeta">{list.length}</span>
              <button
                className="edMini add"
                title={`add ${cat.label.toLowerCase()}`}
                onClick={() => addListItem([cat.key], cat.makeEmpty())}
              >
                +
              </button>
            </div>
            {!isCollapsed && list.map((item, i) => {
              const path: NodePath = [cat.key, i];
              return (
                <button
                  key={i}
                  className={`edTreeRow item${samePath(selection, path) || (selection && selection.length > 2 && samePath(selection.slice(0, 2), path)) ? ' sel' : ''}`}
                  onClick={() => select(path)}
                >
                  <span className="edTreeLabel">{itemLabel ? itemLabel(item, i) : String(i)}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
