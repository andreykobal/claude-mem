import { describe, expect, it } from 'bun:test';
import { stripInlineBinary, stripInlineBinaryDeep } from '../../src/shared/inline-binary.js';

// Real base64 mixes cases and digits; a run of one letter is filler, not an image.
const png = 'iVBORw0KGgo' + 'Ab3x'.repeat(1000);

describe('inline binary', () => {
  it('reduces an image content block to a marker with its type and size', () => {
    const response = [
      { type: 'text', text: 'Screenshot taken' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
    ];
    expect(stripInlineBinaryDeep(response)).toEqual([
      { type: 'text', text: 'Screenshot taken' },
      { type: 'text', text: '[image/png 3 KB omitted]' },
    ]);
  });

  it('replaces data: URIs and long base64 runs inside text', () => {
    expect(stripInlineBinary(`<img src="data:image/jpeg;base64,${'/9j/'.repeat(300)}"> done`))
      .toBe('<img src="[image/jpeg 1 KB omitted]"> done');
    expect(stripInlineBinary(`blob: ${png}\nnext line`)).toBe('blob: [binary 3 KB omitted]\nnext line');
  });

  it('leaves hashes, keys, code and prose alone', () => {
    const text = [
      'sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      'key cmem_c0c52051e08b5b530a0a861f1de6933ebb84efc0b7c151d2',
      'const x = require("a/b/c").map(y => y + 1); '.repeat(40),
      'word '.repeat(400),
      'a'.repeat(5000),
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.repeat(40),
    ].join('\n');
    expect(stripInlineBinary(text)).toBe(text);
  });

  it('keeps structure and every non-binary value', () => {
    const input = { file_path: '/a.png', nested: { list: [1, true, null, 'ok', png] } };
    expect(stripInlineBinaryDeep(input)).toEqual({ file_path: '/a.png', nested: { list: [1, true, null, 'ok', '[binary 3 KB omitted]'] } });
  });
});
