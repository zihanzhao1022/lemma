import { describe, expect, it } from 'vitest';
import { printedUnits } from './printed';

/** Each unit as kind:printed text=source slice, for readable expectations. */
const show = (source: string, from?: number, to?: number): string[] =>
  printedUnits(source, from, to).map((unit) => `${unit.kind}:${unit.text}=${source.slice(unit.from, unit.to)}`);

describe('printedUnits', () => {
  it('gives one unit per printed character of plain text', () => {
    expect(show('Hi you')).toEqual(['char:H=H', 'char:i=i', 'space: = ', 'char:y=y', 'char:o=o', 'char:u=u']);
  });

  it('collapses a run of spaces and a single line break into one space', () => {
    expect(show('a  \n b')).toEqual(['char:a=a', 'space: =  \n ', 'char:b=b']);
  });

  it('drops a comment together with its line break', () => {
    const units = printedUnits('per%cut\nformance');
    expect(units.map((unit) => unit.text).join('')).toBe('performance');
    expect(units.every((unit) => unit.kind === 'char')).toBe(true);
  });

  it('prints an escaped special character as that character', () => {
    expect(show('5\\% of \\$3')).toEqual(['char:5=5', 'char:%=\\%', 'space: = ', 'char:o=o', 'char:f=f', 'space: = ', 'char:$=\\$', 'char:3=3']);
  });

  it('keeps inline math as one unit', () => {
    expect(show('if $x_t<\\tau$ then')).toEqual(['char:i=i', 'char:f=f', 'space: = ', 'atom:=$x_t<\\tau$', 'space: = ', 'char:t=t', 'char:h=h', 'char:e=e', 'char:n=n']);
  });

  it('keeps \\( \\) and \\[ \\] math as one unit', () => {
    expect(show('a \\(x\\) b')).toContain('atom:=\\(x\\)');
    expect(show('a \\[x\\] b')).toContain('atom:=\\[x\\]');
  });

  it('keeps a display math environment as one unit', () => {
    expect(show('see \\begin{equation} x = 1 \\label{e} \\end{equation} so')).toContain('atom:=\\begin{equation} x = 1 \\label{e} \\end{equation}');
  });

  it('prints a tie as a space and keeps a citation as one unit', () => {
    expect(show('shown~\\cite{a,b}.')).toEqual(['char:s=s', 'char:h=h', 'char:o=o', 'char:w=w', 'char:n=n', 'space: =~', 'atom:=\\cite{a,b}', 'char:.=.']);
  });

  it('prints the argument of a text style command as text', () => {
    const units = printedUnits('an \\emph{odd} word');
    const odd = units.filter((unit) => unit.kind === 'char').map((unit) => unit.text).join('');
    expect(odd).toBe('anoddword');
    const d = units.find((unit) => unit.text === 'd')!;
    expect('an \\emph{odd} word'.slice(d.from, d.to)).toBe('d');
  });

  it('skips the colour argument of \\textcolor and prints the text', () => {
    expect(show('\\textcolor{red}{hot}')).toEqual(['char:h=h', 'char:o=o', 'char:t=t']);
  });

  it('prints nothing for a label', () => {
    expect(show('Text\\label{sec:x} more').map((unit) => unit.split('=')[0])).toEqual(['char:T', 'char:e', 'char:x', 'char:t', 'space: ', 'char:m', 'char:o', 'char:r', 'char:e']);
  });

  it('turns dashes and TeX quotes into the characters they print', () => {
    expect(show("a--b ``q'' c---d")).toEqual(['char:a=a', 'char:–=--', 'char:b=b', 'space: = ', 'char:“=``', 'char:q=q', "char:”=''", 'space: = ', 'char:c=c', 'char:—=---', 'char:d=d']);
  });

  it('composes an accent command with its letter', () => {
    expect(show("caf\\'e")).toEqual(['char:c=c', 'char:a=a', 'char:f=f', "char:é=\\'e"]);
    expect(show('na\\"{i}ve')[2]).toBe('char:ï=\\"{i}');
  });

  it('marks table cell separators and row ends, and prints nothing for rules', () => {
    expect(show('Ours & 78.4 \\\\ \\midrule')).toEqual(['char:O=O', 'char:u=u', 'char:r=r', 'char:s=s', 'space: = ', 'separator:=&', 'space: = ', 'char:7=7', 'char:8=8', 'char:.=.', 'char:4=4', 'space: = ', 'separator:=\\\\', 'space: = ']);
  });

  it('skips the column specification of a tabular', () => {
    expect(show('\\begin{tabular}{lr}A&B\\end{tabular}')).toEqual(['char:A=A', 'separator:=&', 'char:B=B']);
  });

  it('keeps an unknown command with its arguments as one unit', () => {
    expect(show('\\ours{} is')).toEqual(['atom:=\\ours{}', 'space: = ', 'char:i=i', 'char:s=s']);
  });

  it('prints the title of a section and the text of a caption', () => {
    expect(show('\\section{Intro}').map((unit) => unit.split('=')[0]).join(' ')).toBe('char:I char:n char:t char:r char:o');
    expect(show('\\caption[short]{Long}').map((unit) => unit.split('=')[0]).join(' ')).toBe('char:L char:o char:n char:g');
  });

  it('keeps a footnote and verbatim text as single units', () => {
    expect(show('x\\footnote{note} y')).toEqual(['char:x=x', 'atom:=\\footnote{note}', 'space: = ', 'char:y=y']);
    expect(show('a \\verb|x y| b')).toContain('atom:=\\verb|x y|');
  });

  it('keeps the image of a figure as one unit and skips placement options', () => {
    expect(show('\\begin{figure}[t]\\centering\\includegraphics[width=\\columnwidth]{fig/a.pdf}\\end{figure}')).toEqual(['atom:=\\includegraphics[width=\\columnwidth]{fig/a.pdf}']);
  });

  it('prints the text of a multicolumn cell', () => {
    expect(show('\\multicolumn{2}{c}{Both}').map((unit) => unit.split('=')[0]).join('')).toBe('char:Bchar:ochar:tchar:h');
  });

  it('only reads the given range', () => {
    const source = 'one two three';
    expect(show(source, 4, 7)).toEqual(['char:t=t', 'char:w=w', 'char:o=o']);
  });
});
