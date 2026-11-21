'use strict';
// The smoke test's own module: one call to the smoke pack's step (an own
// module composes with what is installed: B-own-add).
module.exports = async (input, ctx) => {
  const {output} = await ctx.call('ch-step-smoke/shoutService.shout', {text: input.text});
  return {output: {mine: output.text}};
};
