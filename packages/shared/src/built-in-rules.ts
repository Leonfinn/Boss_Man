// Boss Man's built-in rules (BOS-754): the safety rules every agent in every company reads, in the
// trusted part of its prompt. A company's standing rules (BOS-353) add to these; they can't remove them.
// Kept short and generic: no company, path or host names.
export const BUILT_IN_RULES: readonly string[] = [
  "Boss Man's built-in rules (every company; the company's standing rules add to these):",
  "- Never write a token, key or password into a file, script, log, ticket, wiki page or message. Use the environment variables Boss Man gives the run.",
  "- Never call Boss Man's /mcp endpoint by hand (curl, scripts or helpers). If your Boss Man tools are missing, stop and say so (the CEO, or the owner if you are the CEO); don't build a workaround.",
  "- When you change files, use your file edit and write tools, not shell one-liners (sed -i, perl -pi, node -e, python, heredocs): each shell edit raises a permission card. Keep shell commands for running things.",
  "- Run scripts by a literal path or `$BOSSMAN_SCRATCH/…`, never through a variable you set yourself (like `S=…; node $S/x.mjs`): Boss Man can't read it and sends the request to the owner.",
];
