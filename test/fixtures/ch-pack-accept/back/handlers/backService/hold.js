module.exports = async (input) => {
  const ms = Number.isInteger(input.ms) ? input.ms : 0;
  await new Promise((r) => setTimeout(r, ms));
  return {output: {waited: ms}};
};
