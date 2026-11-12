#!/usr/bin/env node
'use strict';
// ch-local snippet <client>: the client's config entry on stdout (alone, so it
// can be piped), and on stderr which node it pinned and how to reprint.
const {snippet, CLIENTS} = require('../lib/snippets');
const {launcherPath} = require('../lib/home');

const USAGE = `usage: ch-local snippet <${CLIENTS.join('|')}>\n`;

function main(argv, {stdout, stderr, env, node}) {
  const [command, client, ...rest] = argv;
  if (command !== 'snippet' || !CLIENTS.includes(client) || rest.length > 0) {
    if (command === 'snippet' && client !== undefined && !CLIENTS.includes(client)) stderr.write(`ch-local: unknown client "${client}"\n`);
    stderr.write(USAGE);
    return 2;
  }
  let launcher;
  try {
    launcher = launcherPath(env);
  } catch (err) {
    if (err.code !== 'HOME_RELATIVE') throw err;
    stderr.write(`ch-local: ${err.message}\n`);
    return 2;
  }
  const {text, note} = snippet(client, {node, launcher});
  stdout.write(text);
  if (note != null) {
    stderr.write(note);
  } else {
    stderr.write(`ch-local: the entry runs the Node at ${node}.\n`);
    stderr.write(`ch-local: an nvm or system Node upgrade changes this path; run \`ch-local snippet ${client}\` again to reprint the entry.\n`);
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), {stdout: process.stdout, stderr: process.stderr, env: process.env, node: process.execPath});
}

module.exports = {main};
