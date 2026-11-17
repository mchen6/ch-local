// ask: one declared question (ctx.ask through the shim: shared-acceptance (b2))
module.exports = async (input, ctx) => {
  try {
    const answer = await ctx.ask('confirm', {what: String(input.what)});
    return {output: {asked: true, answer: answer}};
  } catch (e) {
    if (e != null && e.code === 'ASK_UNAVAILABLE') return {output: {asked: false, answer: null, code: e.code}};
    throw e;
  }
};
