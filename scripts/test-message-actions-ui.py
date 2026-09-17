# Run with: browser-harness < scripts/test-message-actions-ui.py
# Isolated real-DOM fixture; clipboard and send/fork services are mocked.
begin_browser_task()
from pathlib import Path
import json
import subprocess

root = Path('/home/lepton/agentchatbox')
bundle = subprocess.check_output(['node', '--input-type=module', '-e', '''
import { buildSync } from 'esbuild';
const result = buildSync({stdin: {contents: `
  export { appendAssistantPlaceholder, renderMessageNode } from './src/client/render.ts';
  export { state } from './src/client/state.ts';
  export { services } from './src/client/services.ts';
`, resolveDir: process.cwd()}, bundle: true, write: false, format: 'iife', globalName: 'fixture'});
process.stdout.write(result.outputFiles[0].text);
'''], cwd=root, text=True)
new_tab('about:blank')
try:
    frame = cdp('Page.getFrameTree')['frameTree']['frame']['id']
    cdp('Page.setDocumentContent', frameId=frame, html='<html><body><div id="messages"></div></body></html>')
    js("window.__fixtureScript = ''")
    for offset in range(0, len(bundle), 18000):
        js('window.__fixtureScript += ' + json.dumps(bundle[offset:offset+18000]) + '; void 0')
    js('(0,eval)(window.__fixtureScript); void 0')
    js('''(() => {
      const {state, services, appendAssistantPlaceholder} = fixture;
      window.calls = {copy: [], retry: [], fork: []};
      services.copyText = async text => { calls.copy.push(text); return true; };
      services.sendPrompt = text => { calls.retry.push(text); return true; };
      services.forkFromMessage = seq => calls.fork.push(seq);
      state.messages = [];
      state.isStreaming = false;
      window.answers = [];
      for (let i = 1; i <= 2; i++) {
        state.messages.push({kind:'user', text:'Request ' + i});
        const message = {kind:'assistant', text:'Partial ' + i, thinking:''};
        state.messages.push(message);
        appendAssistantPlaceholder(message);
        // Complete the message after mounting, as streaming does.
        message.text = 'Final answer ' + i;
        message.seq = i * 10;
        answers.push(message);
      }
    })(); void 0''')
    for index in [0, 1, 0]:
        for label, key, expected in [
            ('Copy this answer', 'copy', f'Final answer {index + 1}'),
            ('Retry the previous request', 'retry', f'Request {index + 1}'),
            ('Fork this conversation here', 'fork', (index + 1) * 10),
        ]:
            js(f'document.querySelectorAll(\'[aria-label="{label}"]\')[{index}].click(); void 0')
            assert js(f'calls.{key}.at(-1)') == expected, (index, key)
    print('PASS: older and latest streamed rows copy their own final text, retry their own prompt and fork their own sequence.')
finally:
    finish_scope()
