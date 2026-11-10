import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newPaper } from './library';
import { TEMPLATES, latexText, templateFor, templatePreamble } from './templates';

describe('templateFor', () => {
  it('finds the template from the venue as typed', () => {
    expect(templateFor('ACL 2027')).toBe('acl');
    expect(templateFor('EMNLP 2027 Findings')).toBe('acl');
    expect(templateFor('NeurIPS 2026')).toBe('neurips');
    expect(templateFor('icml')).toBe('icml');
    expect(templateFor('ICLR 2027 (under review)')).toBe('iclr');
    expect(templateFor('IEEE/CVF ICCV 2027')).toBe('cvpr');
    expect(templateFor('ECCV')).toBe('eccv');
    expect(templateFor('AAAI-27')).toBe('aaai');
    expect(templateFor('IJCAI 2027')).toBe('ijcai');
    expect(templateFor("KDD '27")).toBe('acm');
    expect(templateFor('IEEE ICRA')).toBe('ieee');
  });

  it('gives the arXiv style for no venue or one it does not know', () => {
    expect(templateFor('')).toBe('arxiv');
    expect(templateFor('Nature Methods')).toBe('arxiv');
    expect(templateFor('Oracle')).toBe('arxiv');
  });
});

describe('templatePreamble', () => {
  it('puts the title and the author in, escaped for LaTeX', () => {
    const preamble = templatePreamble('acl', { title: 'Tolerance & 100% of $x_1$', author: 'Zihan Zhao' });
    expect(preamble).toContain('\\usepackage[review]{acl}');
    expect(preamble).toContain('\\title{Tolerance \\& 100\\% of \\$x\\_1\\$}');
    expect(preamble).toContain('\\author{Zihan Zhao \\\\ Affiliation');
  });

  it('names the venue where the template prints it', () => {
    expect(templatePreamble('cvpr', { title: 'T', author: 'A', venue: 'ICCV 2027' })).toContain('\\def\\confName{ICCV}');
    expect(templatePreamble('cvpr', { title: 'T', author: 'A' })).toContain('\\def\\confName{CVPR}');
  });

  it('leaves out what AAAI forbids and what clashes with ACM fonts', () => {
    expect(templatePreamble('aaai', { title: 'T', author: 'A' })).not.toMatch(/hyperref|geometry|\{float\}/);
    expect(templatePreamble('acm', { title: 'T', author: 'A' })).not.toContain('amssymb');
  });

  it('is the arXiv style by default, with the title between rules', () => {
    expect(templatePreamble('arxiv', { title: 'T', author: 'A' })).toMatch(/^\\documentclass\{article\}\n\\usepackage\{arxiv\}/);
  });

  it('escapes what LaTeX treats specially', () => {
    expect(latexText(' a\\b ~ ^ {c} # ')).toBe('a\\textbackslash{}b \\textasciitilde{} \\textasciicircum{} \\{c\\} \\#');
  });
});

describe('template files', () => {
  it('are all in public/templates', () => {
    for (const template of TEMPLATES) for (const name of template.files) expect(existsSync(`public/templates/${template.id}/${name}`), `${template.id}/${name}`).toBe(true);
  });
});

describe('newPaper from a template', () => {
  it('takes the preamble and the blocks the template starts with', () => {
    const paper = newPaper({ title: 'Dynamics of Prompt Tolerance', venue: 'KDD 2027', template: 'acm' }, 'Zihan Zhao', [], 36);
    expect(paper.preamble).toContain('\\documentclass[sigconf,review,anonymous]{acmart}');
    expect(paper.preamble).toContain('\\title{Dynamics of Prompt Tolerance}');
    expect(paper.preamble).toContain('\\acmConference[KDD 2027]');
    expect(paper.blocks).toEqual([{ id: 'blk-10000', kind: 'text', source: '\\begin{abstract}\n\n\\end{abstract}\n\\maketitle' }]);
    expect(paper.files).toEqual([]);
  });
});
