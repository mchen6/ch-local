// relay: a hop to the part, then the call's own progress twice, then the answer
// (progress frames before an answer, through the shim: shared-acceptance (a))
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async (input, ctx) => {
  const r = await ctx.call('ch-accept-back/backService.work', {});
  ctx.job.progress(25);
  await wait(300);
  ctx.job.progress(75);
  await wait(300);
  return {output: {hopped: true, said: String((r && r.output && r.output.said) || '')}};
};
