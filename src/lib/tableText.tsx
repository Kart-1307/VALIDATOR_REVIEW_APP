// Detects tabular data typed as plain text (pipe/tab/space-delimited) inside
// question/stimulus/passage text and renders it as a real HTML table instead
// of raw lines.

import React from 'react';

type Segment =
  | { type: 'text'; content: string }
  | { type: 'table'; rows: string[][] };

const SEPARATOR_ROW = /^:?-{2,}:?$/;

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => SEPARATOR_ROW.test(cell.trim()));
}

function splitCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.includes('|')) {
    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length >= 2) return cells;
  }

  if (line.includes('\t')) {
    const cells = line.split('\t').map((cell) => cell.trim());
    if (cells.length >= 2) return cells;
  }

  if (/ {2,}/.test(trimmed)) {
    const cells = trimmed.split(/ {2,}/).map((cell) => cell.trim()).filter(Boolean);
    if (cells.length >= 2) return cells;
  }

  return null;
}

export function extractTableSegments(text: string): Segment[] {
  const lines = text.split(/\r?\n/);
  const segments: Segment[] = [];
  let textBuffer: string[] = [];
  let i = 0;

  const flushText = () => {
    if (textBuffer.length) {
      segments.push({ type: 'text', content: textBuffer.join('\n') });
      textBuffer = [];
    }
  };

  while (i < lines.length) {
    const cells = splitCells(lines[i]);

    if (cells) {
      const blockRows: string[][] = [cells];
      let j = i + 1;
      while (j < lines.length) {
        const nextCells = splitCells(lines[j]);
        if (!nextCells) break;
        blockRows.push(nextCells);
        j++;
      }

      if (blockRows.length >= 2) {
        flushText();
        segments.push({ type: 'table', rows: blockRows.filter((row) => !isSeparatorRow(row)) });
        i = j;
        continue;
      }
    }

    textBuffer.push(lines[i]);
    i++;
  }

  flushText();
  return segments;
}

interface TableAwareTextProps {
  text: string;
  textClassName?: string;
}

export function TableAwareText({ text, textClassName = '' }: TableAwareTextProps) {
  const segments = React.useMemo(() => extractTableSegments(text), [text]);

  return (
    <>
      {segments.map((segment, idx) => {
        if (segment.type === 'text') {
          if (!segment.content.trim()) return null;
          return (
            <p key={idx} className={`whitespace-pre-wrap font-sans ${textClassName}`}>
              {segment.content}
            </p>
          );
        }

        const columnCount = Math.max(...segment.rows.map((row) => row.length));
        const [headerRow, ...bodyRows] = segment.rows;

        return (
          <div key={idx} className="flex justify-center my-2">
            <table className="border-collapse border border-zinc-400 text-sm font-sans">
              <thead>
                <tr>
                  {Array.from({ length: columnCount }, (_, c) => (
                    <th
                      key={c}
                      className="border border-zinc-400 bg-white text-zinc-900 font-semibold text-center px-4 py-1.5 tabular-nums"
                    >
                      {headerRow[c] ?? ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bodyRows.map((row, r) => (
                  <tr key={r}>
                    {Array.from({ length: columnCount }, (_, c) => (
                      <td
                        key={c}
                        className="border border-zinc-400 bg-white text-zinc-900 text-center px-4 py-1.5 tabular-nums"
                      >
                        {row[c] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

