import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFolds } from '../src/web/folding.js';

test('finds nested multiline brace blocks with inclusive ends', () => {
  assert.deepEqual(findFolds(['function f() {', '  if (x) {', '    run();', '  }', '}'], 'file.ts'), new Map([[1, 3], [0, 4]]));
});

test('ignores braces in strings, line comments and multiline comments', () => {
  assert.deepEqual(findFolds(['function f() {', '  const s = "}"; // {', '  /* }', '     { */', '  run();', '}'], 'file.js'), new Map([[0, 5]]));
});

test('ignores unmatched and single-line braces', () => {
  assert.deepEqual(findFolds(['if (x) {', '  run();', 'const obj = {};', 'else {'], 'file.ts'), new Map());
});
test('folds Python suites by indentation including nested suites', () => {
  assert.deepEqual(findFolds(['def f():', '    if x:', '        run()', '    other()', '', 'after()'], 'file.py'), new Map([[1, 2], [0, 3]]));
});

test('ignores Python colons in strings, comments and incomplete suites', () => {
  assert.deepEqual(findFolds(['value = "if x:"', '# if x:', 'if x:', 'next()', 'text = """', 'if fake:', '    nope()', '"""'], 'file.py'), new Map());
});

test('does not fold multiline Python expressions as suites', () => {
  assert.deepEqual(findFolds(['value = (', '    {"key":', '     1}', ')', 'if ready:', '    go()'], 'file.py'), new Map([[4, 5]]));
});

test('counts a Python string literal as a suite body', () => {
  assert.deepEqual(findFolds(['def f():', '    \"\"\"Documentation.', '    Not code: {', '    \"\"\"', 'next()'], 'file.py'), new Map([[0, 3]]));
});
