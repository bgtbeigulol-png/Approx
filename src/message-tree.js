/** Walk the transcript's nested tool containers in display order. */
export function* toolTreeNodes(value) {
  const nodes = Array.isArray(value) ? value : [value];
  for (const node of nodes) {
    if (!node || !['tool', 'toolgroup', 'workgroup'].includes(node.role)) continue;
    yield node;
    if (node.role !== 'tool') yield* toolTreeNodes(node.tools ?? []);
  }
}

export function* toolMessages(value) {
  for (const node of toolTreeNodes(value)) if (node.role === 'tool') yield node;
}
