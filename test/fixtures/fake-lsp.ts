/**
 * A language server for tests: it reports an error on each line containing BAD, and a warning on
 * each line containing MEH. It asks the client for configuration once, as real servers do, and
 * logs the methods it receives to the file in FAKE_LSP_LOG.
 */
import { appendFileSync } from 'node:fs';

let buffer = Buffer.alloc(0);
const log = (text: string): void => {
  if (process.env.FAKE_LSP_LOG) appendFileSync(process.env.FAKE_LSP_LOG, `${text}\n`);
};
const send = (message: Record<string, unknown>): void => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
const publish = (uri: string, text: string): void => {
  const diagnostics = text.split('\n').flatMap((line, i) => [
    ...(line.includes('BAD') ? [{ range: { start: { line: i, character: line.indexOf('BAD') } }, severity: 1, message: 'BAD is not allowed', source: 'fake', code: 'F1' }] : []),
    ...(line.includes('MEH') ? [{ range: { start: { line: i, character: 0 } }, severity: 2, message: 'meh' }] : []),
  ]);
  send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
};
process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end === -1) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())![1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()) as { id?: number; method?: string; params?: Record<string, any> };
    buffer = buffer.subarray(end + 4 + length);
    if (message.method) log(message.method);
    switch (message.method) {
      case 'initialize':
        send({ id: 99, method: 'workspace/configuration', params: { items: [{ section: 'fake' }] } });
        send({ id: message.id, result: { capabilities: { textDocumentSync: 1 } } });
        break;
      case 'textDocument/didOpen':
        publish(message.params!.textDocument.uri, message.params!.textDocument.text);
        break;
      case 'textDocument/didChange':
        publish(message.params!.textDocument.uri, message.params!.contentChanges[0].text);
        break;
      case 'shutdown':
        send({ id: message.id, result: null });
        break;
      case 'exit':
        process.exit(0);
    }
  }
});
