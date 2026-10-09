/** Harness-style chronological rows: fold results and child runs onto their call. */
export function sessionRows(events: any[]) {
  const rows: any[] = [];
  const tools = new Map<string, any>();
  for (const item of [...new Map(events.map(e => [e.id, e])).values()].sort((a, b) => a.seq - b.seq)) {
    const e = item.event || {};
    if (e.type === 'message' && ['user', 'assistant'].includes(e.role) && e.actor !== 'system') rows.push({ ...item, kind: 'message' });
    else if (e.type === 'tool_call') {
      const row = { ...item, kind: 'tool', call: e };
      rows.push(row); tools.set(e.id, row);
    } else if (['tool_result', 'tool_spawn'].includes(e.type)) {
      let row = tools.get(e.toolCallId);
      if (!row) { row = { ...item, kind: 'tool', call: { name: e.name || 'delegate', id: e.toolCallId } }; rows.push(row); tools.set(e.toolCallId, row); }
      if (e.type === 'tool_result') { row.result = e; row.completedAt = item.createdAt; }
      else row.child = e;
    } else if (e.type === 'error') rows.push({ ...item, kind: 'error' });
  }
  return rows;
}

/** Do not expose credential-bearing fields in expandable JSON. */
export function displayJSON(value: unknown): string {
  return JSON.stringify(value, (key, item) => /^(authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|pairing[_-]?token)$/i.test(key) ? '[redacted]' : item, 2) ?? '';
}
