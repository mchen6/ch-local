'use strict';
// The smoke scenario: one call to its step, and the launcher's defaultRepo.
module.exports = async (input, ctx) => {
  const {output} = await ctx.call('ch-step-smoke/shoutService.shout', {text: input.text});
  const config = typeof DeviceConfig === 'undefined' || DeviceConfig == null ? {} : DeviceConfig;
  return {output: {shout: output.text, defaultRepo: typeof config.defaultRepo === 'string' ? config.defaultRepo : null}};
};
