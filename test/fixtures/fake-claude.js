#!/usr/bin/env node
// Faux binaire claude : le comportement dépend du prompt reçu sur stdin.
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const mode = [...input.matchAll(/MODE:(\w+)/g)].at(-1)?.[1] || 'ok';
  const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 };
  const out = (o) => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 's1', total_cost_usd: 0.0123, usage, ...o }));
  switch (mode) {
    case 'ok': return out({ result: 'RAS' });
    case 'alert': return out({ result: 'Disque / à 92 %' });
    case 'iserror': return out({ result: 'boom', is_error: true, subtype: 'success' });
    case 'subtype': return out({ result: 'RAS', subtype: 'error_max_turns' });
    case 'exit': out({ result: 'RAS' }); process.exitCode = 2; return;
    case 'garbage': return process.stdout.write('pas du json');
    case 'env': return out({ result: JSON.stringify({ keys: Object.keys(process.env).sort(), args: process.argv.slice(2) }) });
    case 'suggest': return out({ result: 'Il reste 36 Go libres sur 74 Go (47 %).\n\n```json\n{"ronde": true}\n```' });
    case 'plain': return out({ result: 'Paris.\n\n```json\n{"ronde": false}\n```' });
    case 'designq': return out({ result: 'Je vois 34 IP bannies. À partir de quel pic veux-tu une alerte ?\n\n```json\n{"type": "question"}\n```' });
    case 'designp': return out({ result: 'Voici ma proposition.\n\n```json\n' + JSON.stringify({ type: 'proposal', ronde: { name: 'Sécurité SSH', prompt: 'Lis /host-metrics/fail2ban.txt. Réponds RAS si rien.', cron: '5 * * * *', allowed_tools: ['Read'], max_turns: 4 } }) + '\n```' });
    case 'fork':
      // Descendant qui hérite de stdout : sans kill du groupe, « close » n'arrive jamais.
      return import('node:child_process').then(({ spawn }) => {
        spawn('sleep', ['30'], { stdio: 'inherit' });
        setTimeout(() => {}, 60_000);
      });
    case 'sleep': return setTimeout(() => out({ result: 'RAS' }), 60_000);
    default: return out({ result: 'RAS' });
  }
});
