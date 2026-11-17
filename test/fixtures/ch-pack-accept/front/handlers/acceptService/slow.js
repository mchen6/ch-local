// slow: a hop to the part's hold, which waits (a call to cancel: shared-acceptance (c))
module.exports = async (input, ctx) => {
  const r = await ctx.call('ch-accept-back/backService.hold', {ms: Number.isInteger(input.ms) ? input.ms : 60000});
  return {output: {waited: Number((r && r.output && r.output.waited) || 0)}};
};
