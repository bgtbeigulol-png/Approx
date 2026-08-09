// Display-only tokenizer for @file references. It never changes prompt text.

// A reference may appear in Markdown punctuation, notably `@path`. Keep path
// characters out of the boundary so emails and names such as foo@bar stay plain.
const boundary = (ch) => ch == null || /\s/u.test(ch) || !/[\p{L}\p{N}_.\/\-]/u.test(ch);

/** Split text into ordinary, @ marker, and path spans while preserving every glyph. */
export function fileMentionSpans(value) {
  const chars = [...String(value ?? '')];
  const spans = [];
  let plain = '';
  const pushPlain = () => {
    if (plain) spans.push({ text: plain, mention: false });
    plain = '';
  };

  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '@' || !boundary(chars[i - 1])) {
      plain += chars[i];
      continue;
    }
    const quoted = chars[i + 1] === '"';
    let end = i + (quoted ? 2 : 1);
    if (quoted) {
      while (end < chars.length && chars[end] !== '"') end++;
      if (end < chars.length) end++;
    } else {
      while (end < chars.length && !boundary(chars[end])) end++;
    }
    // Keep a bare @ highlighted while the user is still choosing a file.
    if (end === i + (quoted ? 2 : 1) && quoted) {
      plain += chars[i];
      continue;
    }
    pushPlain();
    spans.push({ text: '@', mention: true, part: 'marker' });
    const path = chars.slice(i + 1, end).join('');
    if (path) spans.push({ text: path, mention: true, part: 'path' });
    i = end - 1;
  }
  pushPlain();
  return spans;
}
