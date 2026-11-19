import React, { useMemo } from 'react';
import { ArrowDown, ArrowUp, Palette as PaletteIcon, Trophy, Hash, Trash2 } from 'lucide-react';
import { useT } from '../../../lib/phrases/table';
import { colorOf, readDefinitions } from '../../../app/writing/latexHtml';
import {
  ColorRule, Direction, FormatRule, Mark, Palette, PreviewCell, RankRule, Reference, Region, SCALE_NAMES, ScaleName, TableRules,
  applyRules, defaultRules, previewTable, readRules, readTabular, rowLabel, scaleColor, writeRules,
} from './rules';

interface Props {
  /** The table block's LaTeX. */
  source: string;
  preamble: string;
  onChange: (source: string) => void;
  disabled?: boolean;
}

const BASE_COLORS = ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow', 'orange', 'purple', 'teal', 'gray'];

function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const ALL: Region = { rows: null, cols: null };

/** A colour expression of the preview ("name!40!white", or "HTML:RRGGBB") as CSS. */
function cssColor(expression: string | null, colors: Record<string, [number, number, number]>): string | undefined {
  if (!expression) return undefined;
  if (expression.startsWith('HTML:')) return `#${expression.slice(5)}`;
  const rgb = colorOf(expression, colors);
  return rgb ? `rgb(${rgb.map((value) => Math.round(value * 255)).join(',')})` : undefined;
}

/**
 * The rules of one table, chosen here and kept in its LaTeX: colours from a colour scale, the best numbers marked,
 * numbers written alike. Every change rewrites the table at once, so the preview beside it follows.
 */
const TableRulesPanel: React.FC<Props> = ({ source, preamble, onChange, disabled = false }) => {
  const t = useT();
  const rules = useMemo(() => readRules(source), [source]);
  const layout = useMemo(() => readTabular(source), [source]);
  const preview = useMemo(() => previewTable(source, rules), [source, rules]);
  const definitions = useMemo(() => readDefinitions(preamble), [preamble]);
  const colors = definitions.colors ?? {};
  const named = useMemo(() => [...Object.keys(colors), ...BASE_COLORS.filter((name) => !(name in colors))], [colors]);

  if (!layout || !preview) {
    return (
      <div className="m-5 rounded-xl border border-purple-100 bg-purple-50/50 p-5 text-sm text-gray-600 space-y-2">
        <p className="font-medium text-gray-900">{t('读不出这张表格的行和列')}</p>
        <p>{t('表格规则需要块里正好有一个 tabular 环境。')}</p>
      </div>
    );
  }

  const columns = layout.columns;
  const labels = layout.rows.map((row) => rowLabel(source, row));
  // A column's name: its letter and the last header text above the numbers.
  const headers = Array.from({ length: columns }, (_, col) => {
    const texts = preview.rows.flatMap((row) => row.filter((cell) => cell.col <= col && col < cell.col + cell.span && cell.value === null && cell.text).map((cell) => cell.text));
    return texts[texts.length - 1] ?? '';
  });

  const update = (next: TableRules | null) => {
    if (disabled) return;
    const written = writeRules(source, next);
    onChange(next ? applyRules(written, next) : written);
  };
  const current: TableRules = rules ?? { directions: {} };
  const set = (patch: Partial<TableRules>) => update({ ...current, ...patch });
  const direction = (col: number): Direction => current.directions[String(col)] ?? 'higher';

  if (!rules) {
    return (
      <div className="m-5 rounded-xl border border-purple-100 bg-white p-5 text-sm text-gray-600 space-y-3">
        <p className="font-medium text-gray-900">{t('这张表格还没有规则')}</p>
        <p>{t('规则存在表格的 LaTeX 里，数字改了会自动重新上色、重新标出最优。每条规则都可以不用。')}</p>
        <button type="button" disabled={disabled} className="rounded-lg bg-purple-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-800 disabled:opacity-50"
          onClick={() => update({ ...defaultRules(Object.keys(colors)), directions: {} })}>
          {t('加上规则')}
        </button>
      </div>
    );
  }

  // Drawn by calling, not as components of their own: a component made anew each render would lose focus and a colour drag.
  const regionPicker = (region: Region, onRegion: (region: Region) => void) => (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <span className="w-10 shrink-0 text-xs text-gray-500">{t('列')}</span>
        <button type="button" aria-pressed={region.cols === null} onClick={() => onRegion({ ...region, cols: null })} className={chip(region.cols === null)}>{t('全部')}</button>
        {Array.from({ length: columns }, (_, col) => {
          const on = region.cols?.includes(col) ?? false;
          return (
            <button key={col} type="button" aria-pressed={on} title={headers[col]} className={chip(on)}
              onClick={() => {
                const cols = region.cols ?? [];
                const next = on ? cols.filter((item) => item !== col) : [...cols, col].sort((a, b) => a - b);
                onRegion({ ...region, cols: next.length ? next : null });
              }}>
              {columnName(col)}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="w-10 shrink-0 text-xs text-gray-500">{t('行')}</span>
        <button type="button" aria-pressed={region.rows === null} onClick={() => onRegion({ ...region, rows: null })} className={chip(region.rows === null)}>{t('全部')}</button>
        {layout.rows.map((row) => {
          const on = region.rows?.includes(row.index) ?? false;
          return (
            <button key={row.index} type="button" aria-pressed={on} title={labels[row.index]} className={chip(on)}
              onClick={() => {
                const rows = region.rows ?? [];
                const next = on ? rows.filter((item) => item !== row.index) : [...rows, row.index].sort((a, b) => a - b);
                onRegion({ ...region, rows: next.length ? next : null });
              }}>
              {row.index + 1}
            </button>
          );
        })}
      </div>
    </div>
  );

  const colorChoice = (label: string, value: string, onColor: (color: string) => void) => {
    const hex = /^#[0-9a-f]{6}$/i.test(value);
    const shown = cssColor(hex ? `HTML:${value.slice(1)}` : value, colors);
    return (
      <label className="inline-flex items-center gap-1.5 text-xs text-gray-600">
        <span>{label}</span>
        <span className="inline-block h-4 w-4 rounded border border-gray-300" style={{ background: shown }} />
        <select aria-label={label} value={hex ? 'custom' : value} onChange={(event) => onColor(event.target.value === 'custom' ? (shown && shown.startsWith('#') ? shown : '#5C8EDE') : event.target.value)}
          className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs">
          {named.map((name) => <option key={name} value={name}>{name}</option>)}
          <option value="custom">{t('自定义颜色…')}</option>
        </select>
        {hex && <input type="color" aria-label={t('{label}：自定义颜色', { label })} value={value} onChange={(event) => onColor(event.target.value.toUpperCase())} className="h-6 w-8" />}
      </label>
    );
  };

  /* ------------------------------------------------------------------ colour */
  const color = current.color;
  const setColor = (patch: Partial<ColorRule> | null) => set({ color: patch === null ? undefined : { ...(color ?? defaultRules(Object.keys(colors)).color!), ...patch } });
  const reference: Reference = color?.reference ?? { kind: 'group' };
  const setReference = (kind: Reference['kind']) => {
    const next: Reference = kind === 'value' ? { kind, value: 0 }
      : kind === 'row' ? { kind, row: layout.rows.find((row) => preview.rows[row.index].some((cell) => cell.value !== null))?.index ?? 0, label: undefined }
      : kind === 'column' ? { kind, col: 1 }
      : { kind };
    if (next.kind === 'row') next.label = labels[next.row] || undefined;
    setColor({ reference: next, ...(kind === 'none' && color?.palette.kind === 'diverging' ? { palette: { kind: 'sequential', color: color.palette.better } as Palette, base: 0, max: 60 } : {}) });
  };
  const palette = color?.palette;
  const legend = (() => {
    if (!color) return [];
    const stops = [0, 0.25, 0.5, 0.75, 1];
    if (palette?.kind === 'scale') return stops.map((s) => `rgb(${scaleColor(palette.name, s).map(Math.round).join(',')})`);
    // A colour mixed with white, as xcolor's name!amount!white.
    const mix = (name: string, amount: number) => {
      const rgb = /^#([0-9a-f]{6})$/i.exec(name);
      if (!rgb) return cssColor(`${name}!${amount}!white`, colors);
      const value = parseInt(rgb[1], 16);
      const channel = (shift: number) => Math.round(255 + (((value >> shift) & 255) - 255) * (amount / 100));
      return `rgb(${channel(16)},${channel(8)},${channel(0)})`;
    };
    if (palette?.kind === 'sequential') return stops.map((s) => mix(palette.color, color.base + (color.max - color.base) * s));
    if (palette?.kind === 'diverging') {
      return [...[1, 0.6, 0.3].map((s) => mix(palette.worse, color.base + (color.max - color.base) * s)), '#ffffff', ...[0.3, 0.6, 1].map((s) => mix(palette.better, color.base + (color.max - color.base) * s))];
    }
    return [];
  })();

  /* ------------------------------------------------------------------ best and second best */
  const rank = current.rank;
  const setRank = (patch: Partial<RankRule> | null) => set({ rank: patch === null ? undefined : { ...(rank ?? { region: ALL, by: 'column', withinGroups: true, best: 'bold', second: 'underline' }), ...patch } });
  const markOptions: { value: Mark; label: string }[] = [{ value: 'bold', label: t('加粗') }, { value: 'underline', label: t('下划线') }, { value: 'none', label: t('不标') }];

  /* ------------------------------------------------------------------ format */
  const format = current.format;
  const setFormat = (patch: Partial<FormatRule> | null) => set({ format: patch === null ? undefined : { ...(format ?? { region: ALL, decimals: 2, stdDecimals: 2 }), ...patch } });

  const cellStyle = (cell: PreviewCell): React.CSSProperties => ({
    background: cssColor(cell.color, colors),
    fontWeight: cell.mark === 'bold' ? 700 : undefined,
    textDecoration: cell.mark === 'underline' ? 'underline' : undefined,
  });

  return (
    <div className="flex-1 min-h-0 overflow-auto p-4 space-y-4 text-sm">
      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
          <strong className="text-gray-900">{t('预览')}</strong>
          <span className="text-xs text-gray-500">{t('点列标题上的箭头，切换这一列越大越好还是越小越好')}</span>
        </div>
        <div className="overflow-auto p-2">
          <table className="border-collapse text-xs">
            <thead>
              <tr>
                <th className="px-1 text-gray-400" />
                {Array.from({ length: columns }, (_, col) => (
                  <th key={col} className="px-1 py-1 font-normal text-gray-500">
                    <div className="flex items-center justify-center gap-0.5">
                      <span>{columnName(col)}</span>
                      <button type="button" disabled={disabled} aria-label={direction(col) === 'higher' ? t('{column} 列：越大越好', { column: columnName(col) }) : t('{column} 列：越小越好', { column: columnName(col) })}
                        title={direction(col) === 'higher' ? t('越大越好') : t('越小越好')}
                        onClick={() => set({ directions: { ...current.directions, [String(col)]: direction(col) === 'higher' ? 'lower' : 'higher' } })}
                        className={`rounded px-0.5 ${direction(col) === 'higher' ? 'text-emerald-600' : 'text-rose-600'} hover:bg-gray-100`}>
                        {direction(col) === 'higher' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, index) => (
                <tr key={index} className={index > 0 && preview.groups[index] !== preview.groups[index - 1] ? 'border-t border-gray-400' : ''}>
                  <th className="px-1 text-right font-normal text-gray-400">{index + 1}</th>
                  {row.map((cell) => (
                    <td key={cell.col} colSpan={cell.span} className="whitespace-nowrap border border-gray-100 px-1.5 py-0.5 text-center" style={cellStyle(cell)}>{cell.text}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-3 space-y-3">
        <label className="flex items-center gap-2 font-medium text-gray-900">
          <input type="checkbox" checked={Boolean(color)} disabled={disabled} onChange={(event) => setColor(event.target.checked ? {} : null)} />
          <PaletteIcon size={15} className="text-purple-700" />{t('颜色条映射')}
        </label>
        {color && (
          <div className="space-y-3 pl-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-500">{t('参照')}</span>
              <select aria-label={t('参照')} value={reference.kind} disabled={disabled} onChange={(event) => setReference(event.target.value as Reference['kind'])} className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs">
                <option value="group">{t('每组第一行')}</option>
                <option value="row">{t('某一行')}</option>
                <option value="column">{t('某一列')}</option>
                <option value="value">{t('固定数值')}</option>
                <option value="none">{t('不参照：按数值高低')}</option>
              </select>
              {reference.kind === 'row' && (
                <select aria-label={t('参照行')} value={reference.row} disabled={disabled} className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs"
                  onChange={(event) => { const row = Number(event.target.value); setColor({ reference: { kind: 'row', row, label: labels[row] || undefined } }); }}>
                  {layout.rows.map((row) => <option key={row.index} value={row.index}>{`${row.index + 1}  ${labels[row.index]}`}</option>)}
                </select>
              )}
              {reference.kind === 'column' && (
                <select aria-label={t('参照列')} value={reference.col} disabled={disabled} className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs"
                  onChange={(event) => setColor({ reference: { kind: 'column', col: Number(event.target.value) } })}>
                  {Array.from({ length: columns }, (_, col) => <option key={col} value={col}>{`${columnName(col)}  ${headers[col]}`}</option>)}
                </select>
              )}
              {reference.kind === 'value' && (
                <input type="number" aria-label={t('参照数值')} value={reference.value} disabled={disabled} className="w-20 rounded border border-gray-200 px-1.5 py-0.5 text-xs"
                  onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setColor({ reference: { kind: 'value', value } }); }} />
              )}
              {reference.kind === 'none' && (
                <select aria-label={t('高低按')} value={color.span ?? 'column'} disabled={disabled} className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs"
                  onChange={(event) => setColor({ span: event.target.value as 'column' | 'region' })}>
                  <option value="column">{t('每列各自比较')}</option>
                  <option value="region">{t('整个范围一起比较')}</option>
                </select>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-gray-500">{t('配色')}</span>
              <select aria-label={t('配色')} disabled={disabled} className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs"
                value={palette?.kind === 'scale' ? `scale:${palette.name}` : palette?.kind ?? 'diverging'}
                onChange={(event) => {
                  const value = event.target.value;
                  const fallback = defaultRules(Object.keys(colors)).color!.palette as Extract<Palette, { kind: 'diverging' }>;
                  if (value.startsWith('scale:')) setColor({ palette: { kind: 'scale', name: value.slice(6) as ScaleName } });
                  else if (value === 'sequential') setColor({ palette: { kind: 'sequential', color: palette?.kind === 'diverging' ? palette.better : fallback.better } });
                  else setColor({ palette: { kind: 'diverging', better: fallback.better, worse: fallback.worse } });
                }}>
                <option value="diverging">{t('两色：变好 / 变差')}</option>
                <option value="sequential">{t('单色深浅')}</option>
                {SCALE_NAMES.map((name) => <option key={name} value={`scale:${name}`}>{t('色带：{name}', { name })}</option>)}
              </select>
              {palette?.kind === 'diverging' && (
                <>
                  {colorChoice(t('变好'), palette.better, (better) => setColor({ palette: { ...palette, better } }))}
                  {colorChoice(t('变差'), palette.worse, (worse) => setColor({ palette: { ...palette, worse } }))}
                </>
              )}
              {palette?.kind === 'sequential' && colorChoice(t('颜色'), palette.color, (next) => setColor({ palette: { kind: 'sequential', color: next } }))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">{reference.kind === 'none' ? t('最低') : t('差距小')}</span>
              <div className="flex h-3 flex-1 max-w-xs overflow-hidden rounded border border-gray-200">
                {legend.map((background, index) => <i key={index} className="flex-1" style={{ background }} />)}
              </div>
              <span className="text-xs text-gray-500">{reference.kind === 'none' ? t('最高') : t('差距大')}</span>
            </div>
            {palette?.kind !== 'scale' && (
              <div className="flex flex-wrap items-center gap-3 text-xs text-gray-600">
                <label className="inline-flex items-center gap-1">{reference.kind === 'none' ? t('最浅') : t('起始浓度')}
                  <input type="number" min={0} max={100} step={1} value={color.base} disabled={disabled} className="w-16 rounded border border-gray-200 px-1 py-0.5"
                    onChange={(event) => { const base = Number(event.target.value); if (Number.isFinite(base)) setColor({ base: Math.min(100, Math.max(0, base)) }); }} />%</label>
                {reference.kind !== 'none' && (
                  <label className="inline-flex items-center gap-1">{t('每差 1 加深')}
                    <input type="number" min={0} step={0.1} value={color.slope} disabled={disabled} className="w-16 rounded border border-gray-200 px-1 py-0.5"
                      onChange={(event) => { const slope = Number(event.target.value); if (Number.isFinite(slope)) setColor({ slope: Math.max(0, slope) }); }} />%</label>
                )}
                <label className="inline-flex items-center gap-1">{reference.kind === 'none' ? t('最深') : t('最大浓度')}
                  <input type="number" min={0} max={100} step={1} value={color.max} disabled={disabled} className="w-16 rounded border border-gray-200 px-1 py-0.5"
                    onChange={(event) => { const max = Number(event.target.value); if (Number.isFinite(max)) setColor({ max: Math.min(100, Math.max(0, max)) }); }} />%</label>
              </div>
            )}
            {regionPicker(color.region, (region) => setColor({ region }))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-3 space-y-3">
        <label className="flex items-center gap-2 font-medium text-gray-900">
          <input type="checkbox" checked={Boolean(rank)} disabled={disabled} onChange={(event) => setRank(event.target.checked ? {} : null)} />
          <Trophy size={15} className="text-purple-700" />{t('标出最优和次优')}
        </label>
        {rank && (
          <div className="space-y-3 pl-6">
            <div className="flex flex-wrap items-center gap-3 text-xs text-gray-600">
              <label className="inline-flex items-center gap-1">{t('比较')}
                <select value={rank.by} disabled={disabled} onChange={(event) => setRank({ by: event.target.value as 'column' | 'row' })} className="rounded border border-gray-200 bg-white px-1.5 py-0.5">
                  <option value="column">{t('每列')}</option>
                  <option value="row">{t('每行')}</option>
                </select>
              </label>
              {rank.by === 'column' && (
                <label className="inline-flex items-center gap-1"><input type="checkbox" checked={rank.withinGroups} disabled={disabled} onChange={(event) => setRank({ withinGroups: event.target.checked })} />{t('每组分开比较')}</label>
              )}
              <label className="inline-flex items-center gap-1">{t('最优')}
                <select value={rank.best} disabled={disabled} onChange={(event) => setRank({ best: event.target.value as Mark })} className="rounded border border-gray-200 bg-white px-1.5 py-0.5">
                  {markOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="inline-flex items-center gap-1">{t('次优')}
                <select value={rank.second} disabled={disabled} onChange={(event) => setRank({ second: event.target.value as Mark })} className="rounded border border-gray-200 bg-white px-1.5 py-0.5">
                  {markOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            </div>
            {rank.by === 'row' && <p className="text-xs text-gray-500">{t('按行比较时，一律数值越大越好。')}</p>}
            {regionPicker(rank.region, (region) => setRank({ region }))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-3 space-y-3">
        <label className="flex items-center gap-2 font-medium text-gray-900">
          <input type="checkbox" checked={Boolean(format)} disabled={disabled} onChange={(event) => setFormat(event.target.checked ? {} : null)} />
          <Hash size={15} className="text-purple-700" />{t('数字格式')}
        </label>
        {format && (
          <div className="space-y-3 pl-6">
            <div className="flex flex-wrap items-center gap-3 text-xs text-gray-600">
              <label className="inline-flex items-center gap-1">{t('小数位')}
                <select value={format.decimals ?? 'keep'} disabled={disabled} onChange={(event) => setFormat({ decimals: event.target.value === 'keep' ? null : Number(event.target.value) })} className="rounded border border-gray-200 bg-white px-1.5 py-0.5">
                  <option value="keep">{t('保持原样')}</option>
                  {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label className="inline-flex items-center gap-1">{t('± 部分的小数位')}
                <select value={format.stdDecimals ?? 'keep'} disabled={disabled} onChange={(event) => setFormat({ stdDecimals: event.target.value === 'keep' ? null : Number(event.target.value) })} className="rounded border border-gray-200 bg-white px-1.5 py-0.5">
                  <option value="keep">{t('保持原样')}</option>
                  {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            </div>
            {regionPicker(format.region, (region) => setFormat({ region }))}
          </div>
        )}
      </section>

      <div className="flex items-center justify-between gap-3 text-xs text-gray-500">
        <span>{t('规则存在表格 LaTeX 的第一行注释里；数字一改，颜色和标记会自动重算。')}</span>
        <button type="button" disabled={disabled} onClick={() => update(null)} className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-gray-500 hover:bg-gray-100 hover:text-rose-700">
          <Trash2 size={13} />{t('移除规则（保留现有颜色）')}
        </button>
      </div>
    </div>
  );
};

const chip = (on: boolean) => `rounded px-1.5 py-0.5 text-xs ${on ? 'bg-purple-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-purple-50 hover:text-purple-700'}`;

export default TableRulesPanel;
