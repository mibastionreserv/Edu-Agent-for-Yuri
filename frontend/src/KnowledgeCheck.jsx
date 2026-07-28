import React, { useMemo, useState } from 'react';

// Interactive knowledge check. Renders the module's localized `check.items`
// (types: match, mcq, tf, order, velocity) with validation and feedback.
// Content-driven: adding items in the course files needs no code change here.

function shuffle(a) { const x = [...a]; for (let i = x.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; }

function MatchItem({ item, ui }) {
  const rights = useMemo(() => shuffle(item.pairs.map((p) => p.right)), [item]);
  const [sel, setSel] = useState(null); // selected left index
  const [assign, setAssign] = useState({}); // leftIndex -> right
  const [checked, setChecked] = useState(false);
  const correct = (i) => assign[i] === item.pairs[i].right;
  const allRight = item.pairs.every((_, i) => correct(i));
  return (
    <div>
      <p className="kc-prompt">{item.prompt}</p>
      <div className="kc-match">
        <div className="kc-col">
          {item.pairs.map((p, i) => (
            <button key={i} type="button"
              className={`kc-tile ${sel === i ? 'sel' : ''} ${assign[i] ? 'has' : ''} ${checked ? (correct(i) ? 'ok' : 'no') : ''}`}
              onClick={() => setSel(i)}>
              <span>{p.left}</span>
              {assign[i] && <em>{assign[i]}</em>}
            </button>
          ))}
        </div>
        <div className="kc-col">
          {rights.map((r, j) => (
            <button key={j} type="button" className="kc-tile alt"
              onClick={() => { if (sel !== null) { setAssign((a) => ({ ...a, [sel]: r })); setSel(null); setChecked(false); } }}>
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="kc-foot">
        <button className="primary sm" onClick={() => setChecked(true)} disabled={Object.keys(assign).length < item.pairs.length}>{ui.checkAnswer}</button>
        {checked && <span className={allRight ? 'kc-good' : 'kc-bad'}>{allRight ? ui.correct : ui.tryAgain}</span>}
      </div>
    </div>
  );
}

function McqItem({ item, ui }) {
  const [pick, setPick] = useState(null); const [checked, setChecked] = useState(false);
  return (
    <div>
      <p className="kc-prompt">{item.prompt}</p>
      <div className="kc-opts">
        {item.options.map((o, i) => (
          <button key={i} type="button"
            className={`kc-opt ${pick === i ? 'sel' : ''} ${checked && i === item.answer ? 'ok' : ''} ${checked && pick === i && i !== item.answer ? 'no' : ''}`}
            onClick={() => { setPick(i); setChecked(false); }}>{o}</button>
        ))}
      </div>
      <div className="kc-foot">
        <button className="primary sm" onClick={() => setChecked(true)} disabled={pick === null}>{ui.checkAnswer}</button>
        {checked && <span className={pick === item.answer ? 'kc-good' : 'kc-bad'}>{pick === item.answer ? ui.correct : ui.tryAgain}</span>}
      </div>
    </div>
  );
}

function TfItem({ item, ui }) {
  const [ans, setAns] = useState({}); const [checked, setChecked] = useState(false);
  const allRight = item.statements.every((s, i) => ans[i] === s.answer);
  return (
    <div>
      <p className="kc-prompt">{item.prompt}</p>
      {item.statements.map((s, i) => (
        <div key={i} className={`kc-tf ${checked ? (ans[i] === s.answer ? 'ok' : 'no') : ''}`}>
          <span>{s.text}</span>
          <span className="kc-tf-btns">
            <button type="button" className={ans[i] === true ? 'sel' : ''} onClick={() => { setAns((a) => ({ ...a, [i]: true })); setChecked(false); }}>✓</button>
            <button type="button" className={ans[i] === false ? 'sel' : ''} onClick={() => { setAns((a) => ({ ...a, [i]: false })); setChecked(false); }}>✕</button>
          </span>
        </div>
      ))}
      <div className="kc-foot">
        <button className="primary sm" onClick={() => setChecked(true)} disabled={Object.keys(ans).length < item.statements.length}>{ui.checkAnswer}</button>
        {checked && <span className={allRight ? 'kc-good' : 'kc-bad'}>{allRight ? ui.correct : ui.tryAgain}</span>}
      </div>
    </div>
  );
}

function OrderItem({ item, ui }) {
  const [order, setOrder] = useState(() => shuffle(item.items.map((_, i) => i)));
  const [checked, setChecked] = useState(false);
  const move = (pos, dir) => { const n = [...order]; const t = pos + dir; if (t < 0 || t >= n.length) return; [n[pos], n[t]] = [n[t], n[pos]]; setOrder(n); setChecked(false); };
  const right = order.every((idx, pos) => idx === pos);
  return (
    <div>
      <p className="kc-prompt">{item.prompt}</p>
      <ol className="kc-order">
        {order.map((idx, pos) => (
          <li key={idx} className={checked ? (idx === pos ? 'ok' : 'no') : ''}>
            <span>{item.items[idx]}</span>
            <span className="kc-order-btns">
              <button type="button" onClick={() => move(pos, -1)} disabled={pos === 0}>▲</button>
              <button type="button" onClick={() => move(pos, 1)} disabled={pos === order.length - 1}>▼</button>
            </span>
          </li>
        ))}
      </ol>
      <div className="kc-foot">
        <button className="primary sm" onClick={() => setChecked(true)}>{ui.checkAnswer}</button>
        {checked && <span className={right ? 'kc-good' : 'kc-bad'}>{right ? ui.correct : ui.tryAgain}</span>}
      </div>
    </div>
  );
}

function VelocityItem({ item, ui }) {
  const [inBacklog, setInBacklog] = useState({});
  const sum = item.cards.reduce((t, c, i) => t + (inBacklog[i] ? c.pts : 0), 0);
  const limit = item.limit || 30;
  const state = sum === 0 ? null : (sum > limit ? 'over' : (sum >= limit - 10 ? 'ok' : 'under'));
  const fb = item.feedback || {};
  return (
    <div>
      <p className="kc-prompt">{item.prompt}</p>
      <div className="kc-vel">
        <div className="kc-vel-pool">
          {item.cards.map((c, i) => (
            <button key={i} type="button" className={`kc-vcard ${inBacklog[i] ? 'in' : ''}`}
              onClick={() => setInBacklog((s) => ({ ...s, [i]: !s[i] }))}>
              {c.label} <b>{c.pts} SP</b>
            </button>
          ))}
        </div>
        <div className={`kc-vel-sum ${state || ''}`}>
          <div className="kc-vel-num">{sum} / {limit} SP</div>
          <div className="kc-vel-bar"><i style={{ width: `${Math.min(100, (sum / limit) * 100)}%` }} /></div>
          {state && <p className="kc-vel-fb">{fb[state]}</p>}
        </div>
      </div>
    </div>
  );
}

const RENDER = { match: MatchItem, mcq: McqItem, tf: TfItem, order: OrderItem, velocity: VelocityItem };

export default function KnowledgeCheck({ check, ui, onClose }) {
  if (!check || !check.items) return null;
  return (
    <div className="kc-wrap">
      <div className="kc-head">
        <b>🎯 {check.title || ui.knowledgeCheck}</b>
        <button className="ghost" onClick={onClose}>✕ {ui.backToBoard}</button>
      </div>
      <div className="kc-items">
        {check.items.map((item, i) => {
          const C = RENDER[item.type];
          return C ? <div className="kc-item" key={i}><C item={item} ui={ui} /></div> : null;
        })}
      </div>
    </div>
  );
}
