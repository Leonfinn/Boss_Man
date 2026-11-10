/**
 * No core dumps from anything the runner starts (BOS-1059). A crashed browser or test process writes a core.<pid> file
 * holding its whole memory, live runner secrets included, into the ticket's checkout, where review copies and other
 * agents can read it. The soft and hard core-size limits are set to 0 before the command starts, and every child of it
 * inherits them. Node has no setrlimit, so the command runs under `sh -c 'ulimit -c 0; exec "$@"'`.
 */
export function withoutCoreDumps(launch: { bin: string; args: string[] }): { bin: string; args: string[] } {
  return { bin: "sh", args: ["-c", 'ulimit -c 0 && exec "$@"', "sh", launch.bin, ...launch.args] };
}
