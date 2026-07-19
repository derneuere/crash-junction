// Left pane — the workspace tree: level root, player, mode, then one group
// per placeable category with counts, an ADD button, and item rows labeled
// by the schema's itemLabel. Selection is the shared NodePath.

import { useState } from 'react';
import type { RaceWaypoint } from '../game/types';
import { CATEGORIES } from './defaults';
import { insertWaypointSpot } from './race';
import { LEVEL_SCHEMA } from './schema/levelSchema';
import type { NodePath } from './schema/types';
import { useEditor } from './state';

const WP_PATH: NodePath = ['mode', 'race', 'waypoints'];

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

      {level.mode.kind === 'race' && (
        <div className="edTreeGroup">
          <div className="edTreeHead">
            <button
              className="edTreeTwist"
              onClick={() => setCollapsed((c) => ({ ...c, waypoints: !c.waypoints }))}
            >
              {collapsed.waypoints ? '▸' : '▾'}
            </button>
            <span className="edTreeDot" style={{ background: '#c75fd9' }} />
            <span className="edTreeLabel">WAYPOINTS</span>
            <span className="edTreeMeta">{level.mode.race.waypoints?.length ?? 0}</span>
            <button
              className="edMini add"
              title="insert a waypoint after the selected one (midpoint to the next)"
              onClick={() => {
                if (level.mode.kind !== 'race') return;
                const wps = level.mode.race.waypoints ?? [];
                const selIdx =
                  selection && selection[0] === 'mode' && selection[2] === 'waypoints'
                    ? (selection[3] as number)
                    : null;
                const { index, wp } = insertWaypointSpot(wps, selIdx);
                addListItem(WP_PATH, wp, index);
              }}
            >
              +
            </button>
          </div>
          {!collapsed.waypoints && (level.mode.race.waypoints ?? []).map((wp: RaceWaypoint, i: number) => {
            const path: NodePath = [...WP_PATH, i];
            return (
              <button
                key={i}
                className={`edTreeRow item${samePath(selection, path) ? ' sel' : ''}`}
                onClick={() => select(path)}
              >
                <span className="edTreeLabel">
                  {i === 0 ? '0 (start)' : i}: ({wp[0]}, {wp[1]}{wp.length > 2 ? `, y ${wp[2]}` : ''})
                </span>
              </button>
            );
          })}
        </div>
      )}

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
