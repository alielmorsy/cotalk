// Header chips for `GET /api/usage`: each tool's five-hour and weekly figure (the lowest across its pools).
import { el } from './dom.js';

const LOW_PCT = 20; // below this many % left a chip turns amber

// one { tool, text, level, title } per tool; [] before the first fetch
export function summarizeUsage(u) {
  if (!u) return [];
  return ['agy', 'claude'].map((tool) => {
    const t = u[tool];
    if (!t?.ok) return { tool, text: `${tool} ?`, level: 'bad', title: `${tool} unavailable: ${t?.error ?? 'no data'} (click to retry)` };
    const tightest = Math.min(...t.windows.map(w => w.remaining));
    const shown = [['5h', '5h'], ['wk', 'week']].flatMap(([short, kind]) => {
      const left = t.windows.filter(w => w.window === kind).map(w => w.remaining);
      return left.length ? [`${short} ${Math.min(...left)}%`] : [];
    });
    return {
      tool,
      text: `${tool} ${shown.join(' · ') || `${tightest}%`}`, // no 5h/weekly window at all: show the tightest one
      level: tightest < LOW_PCT ? 'warning' : 'ok',
      title: [`${tool} quota left (click to refresh)`, ...t.windows.map(w => `${w.label}: ${w.remaining}% (resets ${w.resets})`)].join('\n'),
    };
  });
}

export function usageChips(u, onRefresh) {
  return summarizeUsage(u).map(s =>
    el('button', { type: 'button', class: `badge usage-chip b-${s.level}`, title: s.title, onclick: onRefresh }, s.text));
}
