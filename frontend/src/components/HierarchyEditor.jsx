import { DEFAULT_HIERARCHY, slugKey } from "../status.js";

// Edit a society's address hierarchy. Level 1 is always the plot number; levels
// below are grouping levels (street, sub-sector, sector, phase, …). The storage
// key is derived from the label ("Sub sector" -> sub_sector); "street"/"block"
// map to first-class columns, everything else to plot.attrs.
export default function HierarchyEditor({ value, onChange }) {
  const levels = value && value.length ? value : DEFAULT_HIERARCHY;

  const setLabel = (i, label) =>
    onChange(
      levels.map((l, idx) =>
        idx === i ? { key: idx === 0 ? "number" : slugKey(label), label } : l
      )
    );
  const add = () => onChange([...levels, { key: "", label: "" }]);
  const remove = (i) => onChange(levels.filter((_, idx) => idx !== i));
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 1 || j >= levels.length) return; // keep the number pinned at level 1
    const next = levels.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="hier-editor">
      <div className="muted small">
        Level 1 is the plot number. Add levels for street, sub-sector, sector,
        phase… — drop the ones this society doesn’t use.
      </div>
      {levels.map((l, i) => (
        <div className="hier-row" key={i}>
          <span className="hier-lv">{i + 1}</span>
          <input
            value={l.label}
            onChange={(e) => setLabel(i, e.target.value)}
            placeholder={i === 0 ? "Number" : "Level name"}
          />
          {i === 0 ? (
            <span className="hier-fixed">plot no.</span>
          ) : (
            <span className="hier-actions">
              <button type="button" onClick={() => move(i, -1)} disabled={i <= 1}>
                ↑
              </button>
              <button type="button" onClick={() => move(i, 1)} disabled={i >= levels.length - 1}>
                ↓
              </button>
              <button type="button" className="hier-x" onClick={() => remove(i)} title="Remove level">
                ×
              </button>
            </span>
          )}
        </div>
      ))}
      <button type="button" className="hier-add" onClick={add}>
        + Add level
      </button>
    </div>
  );
}
