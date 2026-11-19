import { describe, expect, it } from 'vitest';
import { applyRules, countColumns, previewTable, readRules, readTabular, ruleEdits, TableRules, writeRules } from './rules';

// Rows of a paper's Table 2, coloured by a script against each model's aligned row.
const TABLE = String.raw`\begin{table*}[t]
\centering
\noindent\resizebox{\ifdim\width>\linewidth\linewidth\else\width\fi}{!}{%
\begin{tabular}{@{}lcc@{\hskip 10pt}cc}
\toprule
\multirow{2}{*}{\textbf{Model}}
& \multicolumn{2}{c}{\textbf{HarmBench}}
& \multicolumn{2}{c}{\textbf{XSTest-unsafe}} \\
\cmidrule(lr){2-3}\cmidrule(l){4-5}
& RR & ASR & RR & ASR \\
\midrule

Llama-3.1-8B-Instruct
& 84.50 & 15.00 & 97.00 & 1.50 \\
\multicolumn{1}{r}{+Full FT}
& \cellcolor{heatredmid!69.7!white}22.33{\sdstyle$\pm$1.89} & \cellcolor{heatredmid!62.1!white}67.67{\sdstyle$\pm$3.01} & \cellcolor{heatredmid!42.1!white}69.33{\sdstyle$\pm$0.58} & \cellcolor{heatredmid!38.4!white}24.50{\sdstyle$\pm$1.00} \\
\midrule

Gemma-2-9B-it
& 99.00 & 1.00 & 98.50 & 1.50 \\
\multicolumn{1}{r}{+Alp-100}
& \cellcolor{heatredmid!96.7!white}3.17{\sdstyle$\pm$2.57} & \cellcolor{heatbluemid!20.3!white}0.67{\sdstyle$\pm$1.15} & \cellcolor{heatredmid!94.1!white}5.83{\sdstyle$\pm$5.77} & \cellcolor{heatredmid!26.4!white}9.50{\sdstyle$\pm$1.00} \\
\multicolumn{1}{r}{+Self-distilled}
& \cellcolor{heatbluemid!20.1!white}99.17{\sdstyle$\pm$0.29} & \cellcolor{heatbluemid!20.1!white}0.83{\sdstyle$\pm$0.29} & 98.50{\sdstyle$\pm$0} & 1.50{\sdstyle$\pm$0} \\
\bottomrule
\end{tabular}%
}
\caption{RR and ASR (\%).}
\label{tab:app-behavior-1}
\end{table*}`;

const HEAT: TableRules = {
  directions: { '2': 'lower', '4': 'lower' },
  color: {
    region: { rows: null, cols: null },
    reference: { kind: 'group' },
    palette: { kind: 'diverging', better: 'heatbluemid', worse: 'heatredmid' },
    base: 20,
    slope: 0.8,
    max: 100,
  },
};

const uncoloured = TABLE.replace(/\\cellcolor\{[^{}]*\}/g, '');

describe('reading the tabular', () => {
  it('counts columns past @{…} and p{…}', () => {
    expect(countColumns('@{}lcc@{\\hskip 10pt}cc')).toBe(5);
    expect(countColumns('|l|p{3cm}|*{3}{c}|')).toBe(5);
    expect(countColumns('lS[table-format=2.2]X')).toBe(3);
  });

  it('finds the rows, their groups between full rules and the columns of their cells', () => {
    const layout = readTabular(TABLE)!;
    expect(layout.columns).toBe(5);
    expect(layout.rows.map((row) => row.group)).toEqual([0, 0, 1, 1, 2, 2, 2]);
    expect(layout.rows[0].cells.map((cell) => [cell.col, cell.span])).toEqual([[0, 1], [1, 2], [3, 2]]);
    expect(layout.rows[3].cells.map((cell) => cell.col)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('colours from a reference', () => {
  it('colours each cell against its group’s first row as the paper’s script did', () => {
    expect(applyRules(uncoloured, HEAT)).toBe(TABLE);
  });

  it('changes nothing in a table that already follows its rules', () => {
    expect(ruleEdits(TABLE, HEAT)).toEqual([]);
  });

  it('recolours a number that changed, with one small edit before it', () => {
    const changed = TABLE.replace('22.33{\\sdstyle', '42.33{\\sdstyle');
    const edits = ruleEdits(changed, HEAT);
    expect(edits).toHaveLength(1);
    expect(applyRules(changed, HEAT)).toContain('\\cellcolor{heatredmid!53.7!white}42.33');
  });

  it('takes a fixed row as the reference, by its label', () => {
    const rules: TableRules = { ...HEAT, color: { ...HEAT.color!, reference: { kind: 'row', row: 2, label: 'Llama-3.1-8B-Instruct' } } };
    const result = applyRules(uncoloured, rules);
    // Gemma's 99.00 RR is better than Llama's 84.50: 20 + 0.8 · 14.5.
    expect(result).toContain('\\cellcolor{heatbluemid!31.6!white}99.00');
  });
});

describe('colours along a scale', () => {
  it('runs from the lowest to the highest number of each column, with exact colours', () => {
    const rules: TableRules = {
      directions: {},
      color: { region: { rows: null, cols: [1] }, reference: { kind: 'none' }, palette: { kind: 'scale', name: 'viridis' }, base: 0, slope: 0, max: 100 },
    };
    const result = applyRules(uncoloured, rules);
    expect(result).toContain('\\cellcolor[HTML]{FDE725}99.17'); // the highest
    expect(result).toContain('\\cellcolor[HTML]{440154}3.17'); // the lowest
  });
});

describe('best and second best', () => {
  it('marks them in each column within each group, the way each column counts as better', () => {
    const rules: TableRules = { directions: { '2': 'lower', '4': 'lower' }, rank: { region: { rows: null, cols: null }, by: 'column', withinGroups: true, best: 'bold', second: 'underline' } };
    const result = applyRules(TABLE, rules);
    expect(result).toContain('\\cellcolor{heatbluemid!20.1!white}\\textbf{99.17}');
    expect(result).toContain('\\cellcolor{heatbluemid!20.3!white}\\textbf{0.67}');
    expect(result).toContain('& \\underline{99.00} &');
    // Run again: nothing more to change.
    expect(ruleEdits(result, rules)).toEqual([]);
  });

  it('takes its marks away again from cells that are no longer best', () => {
    const rules: TableRules = { directions: {}, rank: { region: { rows: null, cols: [1] }, by: 'column', withinGroups: false, best: 'bold', second: 'none' } };
    const marked = applyRules(uncoloured, rules);
    expect(marked).toContain('\\textbf{99.17}');
    const changed = marked.replace('\\textbf{99.17}', '\\textbf{89.17}');
    const again = applyRules(changed, rules);
    expect(again).toContain('& 89.17{');
    expect(again).toContain('\\textbf{99.00}');
  });
});

describe('number format', () => {
  it('writes the numbers and the ± part with the decimals asked for', () => {
    const rules: TableRules = { directions: {}, format: { region: { rows: null, cols: null }, decimals: 1, stdDecimals: 1 } };
    const result = applyRules(TABLE, rules);
    expect(result).toContain('22.3{\\sdstyle$\\pm$1.9}');
    expect(result).toContain('& 84.5 & 15.0 &');
  });
});

describe('the rule line', () => {
  it('keeps the rules on the first line and reads them back', () => {
    const withRules = writeRules(TABLE, HEAT);
    expect(withRules.split('\n')[0]).toMatch(/^% onizukatex-table-rules \{/);
    expect(readRules(withRules)).toEqual(HEAT);
    expect(ruleEdits(withRules)).toEqual([]);
    expect(writeRules(withRules, null)).toBe(TABLE);
  });

  it('leaves a table without a single readable tabular alone', () => {
    expect(ruleEdits('no table here', HEAT)).toEqual([]);
  });

  it('previews the cells with their colours and marks', () => {
    const preview = previewTable(uncoloured, HEAT)!;
    const fullFt = preview.rows[3];
    expect(fullFt[0].text).toBe('+Full FT');
    expect(fullFt[1]).toMatchObject({ value: 22.33, color: 'heatredmid!69.7!white', text: '22.33±1.89' });
  });
});
