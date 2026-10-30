/**
 * Shared by the tests: they run their agents in a tmux server of their own (tmux -L perch-e2e),
 * never in yours. Model tests use a cheap model pi can reach here: the first argument,
 * PERCH_TEST_MODEL, or Claude Haiku.
 */
process.env.PERCH_TMUX_SOCKET = "perch-e2e";
const arg = process.argv[2];
export const MODEL = (arg && arg.includes("/") ? arg : undefined) || process.env.PERCH_TEST_MODEL || "anthropic/claude-haiku-4-5";
/** A second model, for the model switch test. */
export const MODEL2 = process.env.PERCH_TEST_MODEL2 || (MODEL.includes("haiku") ? "anthropic/claude-sonnet-4-5" : MODEL);
