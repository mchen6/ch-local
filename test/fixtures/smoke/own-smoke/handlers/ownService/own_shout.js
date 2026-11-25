'use strict';
// The smoke test's own module: one call to the smoke pack's step (an own
// module composes with what is installed: B-own-add).
module.exports = async (input, ctx) => {
  // (its worker ended, so that the runtime starts it again: an uncaught
  // exception is logged, and the worker lives on)
  if (input.text === 'crash') { setTimeout(() => process.exit(3), 50); await new Promise(() => {}); }
  const {output} = await ctx.call('ch-step-smoke/shoutService.shout', {text: input.text});
  return {output: {mine: output.text}};
};
