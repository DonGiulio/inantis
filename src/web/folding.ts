type LexState = { quote: string; blockComment: boolean };

// Replace non-code characters with spaces while preserving character positions.
function codeOnLine(line: string, state: LexState, python: boolean): string {
  let code = '';
  for (let i = 0; i < line.length;) {
    if (state.blockComment) {
      if (line.startsWith('*/', i)) {
        state.blockComment = false;
        code += '  ';
        i += 2;
      } else {
        code += ' ';
        i++;
      }
    } else if (state.quote) {
      if (line[i] === '\\') {
        const length = Math.min(2, line.length - i);
        code += ' '.repeat(length);
        i += length;
      } else if (line.startsWith(state.quote, i)) {
        code += ' '.repeat(state.quote.length);
        i += state.quote.length;
        state.quote = '';
      } else {
        code += ' ';
        i++;
      }
    } else if ((!python && line.startsWith('//', i)) || (python && line[i] === '#')) {
      code += ' '.repeat(line.length - i);
      break;
    } else if (!python && line.startsWith('/*', i)) {
      state.blockComment = true;
      code += '  ';
      i += 2;
    } else if (line[i] === '"' || line[i] === "'" || (!python && line[i] === '`')) {
      const char = line[i];
      state.quote = python && line.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
      code += (python ? 'x' : ' ') + ' '.repeat(state.quote.length - 1);
      i += state.quote.length;
    } else {
      code += line[i++];
    }
  }
  // Ordinary quoted strings cannot continue onto another line without an escape.
  if (state.quote.length === 1 && state.quote !== '`' && !line.endsWith('\\')) state.quote = '';
  return code;
}

function braceFolds(lines: string[]): Map<number, number> {
  const folds = new Map<number, number>();
  const state: LexState = { quote: '', blockComment: false };
  const stack: number[] = [];
  for (let row = 0; row < lines.length; row++) {
    const code = codeOnLine(lines[row], state, false);
    for (const char of code) {
      if (char === '{') stack.push(row);
      else if (char === '}' && stack.length) {
        const start = stack.pop()!;
        if (start < row) folds.set(start, Math.max(folds.get(start) ?? row, row));
      }
    }
  }
  return folds;
}

function indentation(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width++;
    else if (char === '\t') width += 8 - width % 8;
    else break;
  }
  return width;
}

function pythonFolds(lines: string[]): Map<number, number> {
  const folds = new Map<number, number>();
  const state: LexState = { quote: '', blockComment: false };
  const stack: { start: number; indent: number; end: number }[] = [];
  let pending: { start: number; indent: number } | undefined;
  let depth = 0;
  for (let row = 0; row < lines.length; row++) {
    const inString = state.quote.length > 1;
    const code = codeOnLine(lines[row], state, true);
    const trimmed = code.trim();
    if (inString) {
      for (const block of stack) block.end = row;
      continue;
    }
    if (!trimmed) continue;
    const indent = indentation(lines[row]);
    const initialDepth = depth;
    for (const char of code) {
      if (char === '(' || char === '[' || char === '{') depth++;
      else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    }
    if (initialDepth > 0) {
      for (const block of stack) block.end = row;
      continue;
    }
    while (stack.length && indent <= stack[stack.length - 1].indent) {
      const block = stack.pop()!;
      if (block.end > block.start) folds.set(block.start, block.end);
    }
    if (pending && indent > pending.indent) stack.push({ ...pending, end: row });
    pending = undefined;
    for (const block of stack) block.end = row;
    if (depth === 0 && /^(?:async\s+)?(?:def|class|if|elif|else|for|while|try|except|finally|with|match|case)\b.*:\s*$/.test(trimmed)) {
      pending = { start: row, indent };
    }
  }
  while (stack.length) {
    const block = stack.pop()!;
    if (block.end > block.start) folds.set(block.start, block.end);
  }
  return folds;
}

/** Returns zero-based fold starts and inclusive ends for the supplied lines. */
export function findFolds(lines: string[], path: string): Map<number, number> {
  return /\.(?:py|pyw|pyi)$/i.test(path) ? pythonFolds(lines) : braceFolds(lines);
}
