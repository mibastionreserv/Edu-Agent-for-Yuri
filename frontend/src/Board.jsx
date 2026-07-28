import React, { useEffect, useRef } from 'react';
import rough from 'roughjs';

// Interactive whiteboard. Renders the course's board_commands (see Course Spec
// Appendix A) in a hand-drawn style using rough.js — the same rendering engine
// Excalidraw is built on — so the vocabulary stays Excalidraw-compatible while
// the app has no heavy editor dependency. Elements reveal step by step as Mira
// narrates (driven by `revealed`).

const SVGNS = 'http://www.w3.org/2000/svg';
const COLORS = {
  grey: { s: '#5b6472', f: '#eef1f5' },
  blue: { s: '#2f6f8f', f: '#e6f2f7' },
  green: { s: '#2f9e6b', f: '#e6f6ee' },
  orange: { s: '#d98a2b', f: '#fdf1e0' },
  red: { s: '#df5648', f: '#fdeceb' },
  plain: { s: '#334155', f: '#ffffff' },
};
const col = (c) => COLORS[c] || COLORS.plain;

function textEl(x, y, str, { size = 15, weight = 600, anchor = 'middle', fill = '#1f2733' } = {}) {
  const t = document.createElementNS(SVGNS, 'text');
  t.setAttribute('x', x); t.setAttribute('y', y);
  t.setAttribute('text-anchor', anchor);
  t.setAttribute('font-size', size);
  t.setAttribute('font-weight', weight);
  t.setAttribute('fill', fill);
  t.setAttribute('font-family', 'Inter, "Segoe UI", system-ui, sans-serif');
  t.textContent = str;
  return t;
}

// naive word-wrap to ~chars per line
function wrap(str, perLine) {
  const words = String(str).split(/\s+/);
  const lines = []; let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > perLine && cur) { lines.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

export default function Board({ steps = [], revealed = 0, viewBox = '0 0 680 470' }) {
  const svgRef = useRef(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const rc = rough.svg(svg);
    const pos = {}; // id -> {x,y,w,h,cx,cy}

    const drawArrow = (x1, y1, x2, y2, color) => {
      const g = document.createElementNS(SVGNS, 'g');
      g.appendChild(rc.line(x1, y1, x2, y2, { stroke: color, strokeWidth: 2, roughness: 1.1 }));
      const ang = Math.atan2(y2 - y1, x2 - x1); const h = 9;
      const ax = x2 - h * Math.cos(ang - Math.PI / 6);
      const ay = y2 - h * Math.sin(ang - Math.PI / 6);
      const bx = x2 - h * Math.cos(ang + Math.PI / 6);
      const by = y2 - h * Math.sin(ang + Math.PI / 6);
      const head = document.createElementNS(SVGNS, 'polygon');
      head.setAttribute('points', `${x2},${y2} ${ax},${ay} ${bx},${by}`);
      head.setAttribute('fill', color);
      g.appendChild(head);
      return g;
    };

    const elements = [];
    for (let i = 0; i < Math.min(revealed, steps.length); i += 1) {
      for (const d of (steps[i].draw || [])) elements.push(d);
    }

    // first pass: register box/circle positions so arrows can resolve refs
    for (const d of elements) {
      if (d.t === 'card' || d.t === 'frame') {
        const w = d.w || 150; const h = d.h || 70;
        pos[d.id] = { x: d.x, y: d.y, w, h, cx: d.x + w / 2, cy: d.y + h / 2 };
      } else if (d.t === 'circle' || d.t === 'loop') {
        const r = d.r || 55; pos[d.id] = { x: d.x - r, y: d.y - r, w: r * 2, h: r * 2, cx: d.x, cy: d.y, r };
      } else if (d.t === 'axes') {
        pos[d.id] = { x: d.x, y: d.y, w: d.w, h: d.h, cx: d.x + d.w / 2, cy: d.y + d.h / 2 };
      }
    }

    const edgePoint = (a, b) => {
      // point on box/circle a's boundary toward b
      const dx = b.cx - a.cx; const dy = b.cy - a.cy; const ang = Math.atan2(dy, dx);
      if (a.r) return [a.cx + a.r * Math.cos(ang), a.cy + a.r * Math.sin(ang)];
      const hw = a.w / 2; const hh = a.h / 2;
      const tx = Math.abs(Math.cos(ang)) < 1e-3 ? Infinity : hw / Math.abs(Math.cos(ang));
      const ty = Math.abs(Math.sin(ang)) < 1e-3 ? Infinity : hh / Math.abs(Math.sin(ang));
      const t = Math.min(tx, ty);
      return [a.cx + t * Math.cos(ang), a.cy + t * Math.sin(ang)];
    };

    for (const d of elements) {
      const c = col(d.color);
      if (d.t === 'frame') {
        svg.appendChild(rc.rectangle(d.x, d.y, d.w, d.h, {
          stroke: '#9aa7b5', strokeWidth: 1.6, roughness: 1.3, fill: '#f8fafc', fillStyle: 'solid',
        }));
        if (d.label) svg.appendChild(textEl(d.x + 12, d.y + 20, d.label, { size: 13, weight: 700, anchor: 'start', fill: '#64748b' }));
      } else if (d.t === 'card') {
        const w = d.w || 150; const h = d.h || 70;
        svg.appendChild(rc.rectangle(d.x, d.y, w, h, {
          stroke: c.s, strokeWidth: 2, roughness: 1.25, fill: c.f, fillStyle: 'solid',
        }));
        const lines = wrap(d.text, Math.max(10, Math.floor(w / 8.5)));
        const start = d.y + h / 2 - (lines.length - 1) * 9;
        lines.forEach((ln, k) => svg.appendChild(textEl(d.x + w / 2, start + k * 18 + 5, ln, { size: 14, fill: c.s })));
      } else if (d.t === 'circle') {
        const r = d.r || 55;
        svg.appendChild(rc.circle(d.x, d.y, r * 2, {
          stroke: c.s, strokeWidth: 2, roughness: 1.3, fill: c.f, fillStyle: 'solid',
        }));
        if (d.label) {
          const lines = wrap(d.label, 14);
          const start = d.y - (lines.length - 1) * 8 - (d.sub ? 6 : 0);
          lines.forEach((ln, k) => svg.appendChild(textEl(d.x, start + k * 15, ln, { size: 13, weight: 700, fill: c.s })));
          if (d.sub) svg.appendChild(textEl(d.x, start + lines.length * 15 + 2, d.sub, { size: 11, weight: 500, fill: '#64748b' }));
        }
      } else if (d.t === 'loop') {
        const r = d.r || 55;
        svg.appendChild(rc.circle(d.x, d.y, r * 2, {
          stroke: '#2f6f8f', strokeWidth: 2, roughness: 1.4, fill: '#eaf4f8', fillStyle: 'solid',
        }));
        // circular arrow hint
        svg.appendChild(rc.arc(d.x, d.y, r * 2 + 14, r * 2 + 14, Math.PI * 1.15, Math.PI * 1.9, false, { stroke: '#2f6f8f', strokeWidth: 1.6, roughness: 1.2 }));
        if (d.label) {
          const lines = wrap(d.label, 12);
          const start = d.y - (lines.length - 1) * 8;
          lines.forEach((ln, k) => svg.appendChild(textEl(d.x, start + k * 15 + 4, ln, { size: 12.5, weight: 700, fill: '#2f6f8f' })));
        }
      } else if (d.t === 'axes') {
        svg.appendChild(rc.line(d.x, d.y, d.x, d.y + d.h, { stroke: '#334155', strokeWidth: 2, roughness: 0.7 }));
        svg.appendChild(rc.line(d.x, d.y + d.h, d.x + d.w, d.y + d.h, { stroke: '#334155', strokeWidth: 2, roughness: 0.7 }));
        if (d.ylabel) { const t = textEl(d.x - 8, d.y + d.h / 2, d.ylabel, { size: 11, weight: 600, fill: '#64748b', anchor: 'middle' }); t.setAttribute('transform', `rotate(-90 ${d.x - 8} ${d.y + d.h / 2})`); svg.appendChild(t); }
        if (d.xlabel) svg.appendChild(textEl(d.x + d.w / 2, d.y + d.h + 22, d.xlabel, { size: 11, weight: 600, fill: '#64748b' }));
      } else if (d.t === 'line') {
        const pts = d.pts || [];
        for (let k = 1; k < pts.length; k += 1) {
          svg.appendChild(rc.line(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], {
            stroke: d.color || '#334155', strokeWidth: 2.4, roughness: 0.8,
            strokeLineDash: d.dashed ? [6, 6] : undefined,
          }));
        }
      } else if (d.t === 'cross') {
        const s = 9; const color = d.color || '#df5648';
        svg.appendChild(rc.line(d.x - s, d.y - s, d.x + s, d.y + s, { stroke: color, strokeWidth: 2.4, roughness: 0.6 }));
        svg.appendChild(rc.line(d.x - s, d.y + s, d.x + s, d.y - s, { stroke: color, strokeWidth: 2.4, roughness: 0.6 }));
        if (d.label) svg.appendChild(textEl(d.x + 14, d.y + 4, d.label, { size: 11, weight: 600, anchor: 'start', fill: color }));
      } else if (d.t === 'note') {
        const lines = wrap(d.text, 46);
        lines.forEach((ln, k) => svg.appendChild(textEl(d.x, d.y + k * 18, ln, { size: 13, weight: 500, anchor: 'start', fill: '#475569' })));
      } else if (d.t === 'arrow') {
        let x1; let y1; let x2; let y2;
        if (d.from && d.to && pos[d.from] && pos[d.to]) {
          [x1, y1] = edgePoint(pos[d.from], pos[d.to]);
          [x2, y2] = edgePoint(pos[d.to], pos[d.from]);
        } else { x1 = d.x1; y1 = d.y1; x2 = d.x2; y2 = d.y2; }
        if ([x1, y1, x2, y2].every((n) => typeof n === 'number')) {
          svg.appendChild(drawArrow(x1, y1, x2, y2, d.color || '#8892b0'));
          if (d.label) svg.appendChild(textEl((x1 + x2) / 2, (y1 + y2) / 2 - 6, d.label, { size: 11, weight: 600, fill: d.color || '#64748b' }));
        }
      }
    }
  }, [steps, revealed, viewBox]);

  return <svg ref={svgRef} className="board-svg" viewBox={viewBox} preserveAspectRatio="xMidYMid meet" role="img" aria-label="whiteboard" />;
}
