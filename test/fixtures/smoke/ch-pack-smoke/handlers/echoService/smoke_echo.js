'use strict';
// The smoke scenario: one call to its step, and its own setting defaultRepo
// (as pack 1 reads it since #413 rev 3's P1 and P3: no device config).
module.exports = async (input, ctx) => {
  const {output} = await ctx.call('ch-step-smoke/shoutService.shout', {text: input.text});
  const repo = ctx.settings != null && typeof ctx.settings.defaultRepo === 'string' ? ctx.settings.defaultRepo : null;
  return {output: {shout: output.text, defaultRepo: repo}};
};
